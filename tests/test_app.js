const assert = require("node:assert/strict");
const fs = require("node:fs");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { WebSocket } = require("ws");
const request = require("supertest");
const { openDatabase, seedTenantVehicleOptions } = require("../app/db");
const { backupDatabase } = require("../app/backup-db");
const { ErrorLogger } = require("../app/error-logger");
const { version: appVersion } = require("../package.json");

process.env.SESSION_SECRET ||= "test-only-session-secret-value-123456";

const { createApplication } = require("../app/server");
const { hashPassword, verifyPassword } = require("../app/security");

let application;
let server;
let baseUrl;
let agent;
let vehicleId;
let sessionCookie;
const extraServers = [];
const errorLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "guts-error-logs-"));

before(async () => {
  application = createApplication({
    databasePath: ":memory:",
    sessionSecret: "test-only-session-secret-value-123456",
    errorLogPath: path.join(errorLogDirectory, "errors.log"),
  });
  application.db.prepare("INSERT INTO users (username, password_hash, tenant_id) VALUES (?, ?, 1)").run(
    "operator",
    await hashPassword("correct-horse-battery"),
  );
  server = application.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  agent = request.agent(server);
});

after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  for (const extraServer of extraServers) {
    if (!extraServer.listening) continue;
    extraServer.close();
    await once(extraServer, "close");
  }
  application?.db.close();
  fs.rmSync(errorLogDirectory, { recursive: true, force: true });
});

test("creates and verifies a consistent SQLite backup without overwriting files", async () => {
  const source = path.join(errorLogDirectory, "backup-source.sqlite");
  const destination = path.join(errorLogDirectory, "backup-copy.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records(value) VALUES ('preserved')");
  db.close();

  assert.equal(await backupDatabase(source, destination), destination);
  const backupDb = new DatabaseSync(destination, { readOnly: true });
  assert.equal(backupDb.prepare("SELECT value FROM records").get().value, "preserved");
  assert.equal(backupDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  backupDb.close();
  const existing = path.join(errorLogDirectory, "existing-backup.sqlite");
  fs.writeFileSync(existing, "leave this file untouched");
  await assert.rejects(backupDatabase(source, existing), /Backup already exists/);
  assert.equal(fs.readFileSync(existing, "utf8"), "leave this file untouched");
});

test("serves the browser UI but protects vehicle data until login", async () => {
  const page = await request(server).get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /data-app-version/);
  assert.doesNotMatch(page.headers["content-security-policy"], /upgrade-insecure-requests/);
  const appScript = await request(server).get("/static/app.js");
  assert.equal(appScript.status, 200);
  assert.match(appScript.text, /setAppVersion/);
  assert.equal((await request(server).get("/static/id.js")).status, 200);
  assert.match(page.text, /\/static\/id\.js/);
  assert.equal((await request(server).get("/static/inspection3d.mjs")).status, 200);
  assert.match((await request(server).get("/vendor/three.module.js")).headers["content-type"], /javascript/);
  assert.deepEqual((await request(server).get("/api/me")).body, { authenticated: false, version: appVersion });
  assert.equal((await request(server).get("/api/bootstrap")).status, 401);
  assert.equal((await agent.get("/api/bootstrap")).status, 401);
});

test("generates UUIDs without requiring a secure browser context", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "static", "id.js"), "utf8");
  for (const crypto of [{ getRandomValues: (bytes) => bytes.fill(0x2a) }, undefined]) {
    const browser = {
      Uint8Array,
      Math,
      ...(crypto ? { crypto } : {}),
    };
    vm.runInNewContext(source, browser);
    const id = browser.createClientId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test("records sanitized browser and server request errors without logging request data", async () => {
  const passwordKey = ["pass", "word"].join("");
  const secretMarker = "sample-redaction-value";
  const browserReport = await request(server)
    .post("/api/client-errors")
    .set("Origin", baseUrl)
    .send({
      type: "browser-error",
      message: `Unexpected ${passwordKey}=${secretMarker} ${["to", "ken"].join("")}:another-value`,
      stack: `Error: ${["coo", "kie"].join("")}=sample-cookie-value`,
      source: `https://example.test/app.js?${["api", "key"].join("_")}=sample-api-value`,
      path: "/board",
      username: "must-not-be-recorded",
    });
  assert.equal(browserReport.status, 202);
  assert.equal((await request(server)
    .post("/api/client-errors")
    .send({ type: "browser-error", message: "Missing origin" })).status, 403);
  assert.equal((await request(server)
    .post("/api/client-errors")
    .set("Origin", baseUrl)
    .send({ type: "not-allowed", message: "Bad event" })).status, 422);

  const malformed = await request(server)
    .post("/api/login")
    .set("Content-Type", "application/json")
    .send("{");
  assert.equal(malformed.status, 400);

  const records = fs.readFileSync(path.join(errorLogDirectory, "errors.log"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].type, "client-browser-error");
  assert.match(records[0].message, new RegExp(`${passwordKey}=\\[REDACTED\\]`));
  assert.match(records[0].message, new RegExp(`${["to", "ken"].join("")}:\\[REDACTED\\]`));
  assert.match(records[0].stack, new RegExp(`${["coo", "kie"].join("")}=\\[REDACTED\\]`));
  assert.equal(records[0].source, "https://example.test/app.js");
  assert.equal(records[0].message.includes(secretMarker), false);
  assert.equal(Object.hasOwn(records[0], "username"), false);
  assert.equal(Object.hasOwn(records[0], "ip"), false);
  assert.equal(records[1].type, "malformed-json");
  assert.equal(records[1].status, 400);
});

test("writes structured, redacted application errors to the configured file", () => {
  const logger = new ErrorLogger(path.join(errorLogDirectory, "unit-errors.log"));
  const authorizationKey = ["author", "ization"].join("");
  const secretMarker = "sample-auth-value";
  logger.capture("test-error", new Error(`${authorizationKey}: ${secretMarker}`), { status: 500 });
  const record = JSON.parse(fs.readFileSync(path.join(errorLogDirectory, "unit-errors.log"), "utf8"));
  assert.equal(record.type, "test-error");
  assert.equal(record.status, 500);
  assert.match(record.message, new RegExp(`${authorizationKey}: \\[REDACTED\\]`, "i"));
  assert.equal(record.message.includes(secretMarker), false);
  assert.ok(record.timestamp);
  assert.equal(record.app_version, appVersion);
});

test("uses full-width parking cards and compact controls on phone layouts", () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  assert.ok(html.indexOf('id="status-panel"') < html.indexOf('class="board-workspace"'));
  assert.match(html, /<details id="status-panel">/);
  assert.match(html, /<details id="inspection-panel">/);
  assert.match(html, /<details id="task-panel">/);
  assert.doesNotMatch(html, /id="manage-statuses-button"/);
  assert.match(html, /id="vehicle-status-options"/);
  assert.match(html, /<fieldset class="option-fields">[\s\S]*?id="manage-options-button"/);
  assert.match(html, /<fieldset class="status-fields">[\s\S]*?id="manage-vehicle-statuses-button"/);
  assert.match(html, /<dialog id="admin-dialog">[\s\S]*?id="manage-employees-button"[\s\S]*?id="export-vehicles-button"/);
  assert.doesNotMatch(html.slice(html.indexOf('<dialog id="admin-dialog">'), html.indexOf("</dialog>")),
    /id="manage-(?:classes|options|vehicle-statuses|assessment)-button"/);
  assert.match(html, /id="admin-panel-button"[^>]*hidden/);
  assert.match(html, /車両状態評価シート/);
  assert.match(html, /<h3>車検<\/h3>[\s\S]*?name="inspection_expiry_date"[\s\S]*?name="statutory_inspection_date"/);
  assert.ok(html.indexOf('<h3>車両状態評価シート</h3>') < html.indexOf('<section class="vehicle-inspection-dates">'));
  assert.ok(html.indexOf('<section class="vehicle-inspection-dates">') < html.indexOf('<div id="assessment-fields">'));
  assert.match(html, /id="inspection-list"/);
  assert.match(html, /id="task-list"/);
  assert.match(html, /id="task-dialog"/);
  assert.match(html, /<label>クラス<select name="vehicle_type" required><\/select><\/label>/);
  assert.match(html, /<label class="vehicle-model-field">車種<select name="vehicle_model" id="vehicle-model"><\/select><\/label>/);
  assert.doesNotMatch(html, /車種・タイプ/);
  assert.match(html, /assessment-fields[\s\S]*?name="notes"[\s\S]*?<\/section>/);
  assert.match(html, /車体の損傷位置/);
  assert.match(html, /id="inspection-car-view"[^>]*360度回転/);
  assert.match(html, /static\/inspection3d\.mjs/);
  assert.match(html, /id="assessment-manager-dialog"/);
  assert.match(html, /id="manage-classes-button"/);
  assert.match(html, /id="manage-assessment-button"/);
  assert.match(html, /id="manage-damage-types-button"/);
  assert.match(html, /<form id="add-employee-form"[\s\S]*?name="username"[\s\S]*?name="password" type="password" required minlength="12"/);
  assert.match(html, /id="manage-employees-button"/);
  assert.doesNotMatch(html, /パスワード再発行/);
  const phoneLayout = stylesheet.slice(stylesheet.indexOf("@media (max-width: 560px)"));
  assert.match(phoneLayout, /\.parking-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(phoneLayout, /\.lot-card\s*\{\s*width:\s*100%;\s*max-width:\s*100%/);
  assert.match(phoneLayout, /\.topbar\s*\{\s*min-height:\s*62px;\s*height:\s*auto/);
  assert.match(stylesheet, /\.lot-markings\.editable\.drawing\s*\{[^}]*touch-action:\s*none/);
  assert.match(script, /classList\.add\("marking-canvas"\)/);
  assert.doesNotMatch(script, /選択した線を削除/);
  assert.match(script, /\/markings`,\s*\{\s*method:\s*"POST"/);
  assert.match(script, /addEventListener\("error"/);
  assert.match(script, /addEventListener\("unhandledrejection"/);
  assert.match(script, /reportClientError\("interaction-error"/);
  const tokenRenderer = script.slice(script.indexOf("function makeToken"), script.indexOf("function startDrag"));
  assert.ok(tokenRenderer.indexOf('className = "token-statuses"') < tokenRenderer.indexOf('className = "token-plate"'));
  assert.ok(tokenRenderer.indexOf('className = "token-plate"') < tokenRenderer.indexOf('className = "token-options"'));
  assert.match(stylesheet, /\.vehicle-token\s*\{[^}]*flex-direction:\s*column/);
  const issueDrag = script.slice(
    script.indexOf("function startInspectionIssueDrag"),
    script.indexOf("function moveInspectionIssueDrag"),
  );
  assert.doesNotMatch(issueDrag, /setPointerCapture/);
});

test("keeps undo and edge auto-scroll controls wired into vehicle interactions", async () => {
  const script = (await request(server).get("/static/app.js")).text;
  assert.match(script, /undo\.textContent = "取り消し"/);
  assert.match(script, /保存済みの最後の線を削除して保存します/);
  assert.match(script, /指を離すと自動保存されます/);
  assert.match(script, /updateMarkings\(lot, markings\.slice\(0, -1\)\)/);
  assert.match(script, /requestAnimationFrame\(autoScrollWhileDragging\)/);
  assert.match(script, /window\.scrollBy\(0, scrollDelta\)/);
  assert.match(script, /const edgeSize = Math\.min\(100, window\.innerHeight \* 0\.16\)/);
});

test("keeps HTTPS asset upgrades enabled when secure cookies are configured", async () => {
  const secureApplication = createApplication({
    databasePath: ":memory:",
    sessionSecret: "test-only-session-secret-value-123456",
    cookieSecure: true,
  });
  try {
    const response = await request(secureApplication.app).get("/");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-security-policy"], /upgrade-insecure-requests/);
  } finally {
    secureApplication.db.close();
  }
});

test("logs in with hashed credentials and seeds thirteen peer locations", async () => {
  assert.equal((await agent.post("/api/login").send({
    username: "operator",
    password: "incorrect-password",
  })).status, 401);
  const login = await agent.post("/api/login").send({
    username: "operator",
    password: "correct-horse-battery",
  });
  assert.equal(login.status, 200);
  sessionCookie = login.headers["set-cookie"][0].split(";")[0];
  assert.deepEqual((await agent.get("/api/me")).body, {
    authenticated: true,
    version: appVersion,
    username: "operator",
    can_manage: true,
    can_manage_franchises: true,
    tenant_name: "本店",
  });
  assert.equal(login.body.can_manage, true);
  const bootstrap = await agent.get("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.parking_lots.length, 13);
  assert.equal(Object.hasOwn(bootstrap.body, "board_sections"), false);
  assert.deepEqual(
    bootstrap.body.parking_lots.slice(9).map((lot) => lot.name),
    ["本店貸出中", "駅前店貸出中", "予備", "立駐"],
  );
  assert.deepEqual(bootstrap.body.vehicles, []);
});

test("admins create and change employee passwords while protecting credentials and sessions", async () => {
  assert.equal((await request(server).get("/api/employees")).status, 401);
  assert.equal((await request(server).get("/api/export/mariadb")).status, 401);
  assert.equal((await agent.post("/api/employees").send({
    username: "short-password-staff",
    password: "too-short",
  })).status, 422);
  const created = await agent.post("/api/employees").send({
    username: "managed-staff",
    password: "employee-initial-password",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.employee.username, "managed-staff");
  assert.equal(Object.hasOwn(created.body, "password"), false);
  assert.equal(Object.hasOwn(created.body.employee, "password_hash"), false);

  const employees = await agent.get("/api/employees");
  assert.equal(employees.status, 200);
  assert.ok(employees.body.employees.some((employee) => employee.id === created.body.employee.id));
  assert.equal(JSON.stringify(employees.body).includes("password_hash"), false);

  const employeeAgent = request.agent(server);
  const login = await employeeAgent.post("/api/login").send({
    username: created.body.employee.username,
    password: "employee-initial-password",
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.can_manage, false);
  assert.equal((await employeeAgent.get("/api/employees")).status, 403);
  assert.equal((await employeeAgent.get("/api/export/mariadb")).status, 403);
  assert.equal((await employeeAgent.post("/api/employees").send({ username: "staff-forbidden" })).status, 403);

  assert.equal((await agent.patch(`/api/employees/${created.body.employee.id}/password`).send({
    password: "short",
  })).status, 422);
  const reset = await agent.patch(`/api/employees/${created.body.employee.id}/password`).send({
    password: "employee-updated-password",
  });
  assert.equal(reset.status, 200);
  assert.equal(Object.hasOwn(reset.body, "password"), false);
  assert.deepEqual((await employeeAgent.get("/api/me")).body, { authenticated: false, version: appVersion });
  assert.equal((await employeeAgent.post("/api/login").send({
    username: created.body.employee.username,
    password: "employee-initial-password",
  })).status, 401);
  assert.equal((await employeeAgent.post("/api/login").send({
    username: created.body.employee.username,
    password: "employee-updated-password",
  })).status, 200);

  const dateAfterDays = (days) => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const [year, month, day] = today.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  };
  const expiryDate = dateAfterDays(15);
  const statutoryDate = dateAfterDays(30);
  const vehicle = await employeeAgent.post("/api/vehicles").send({
    plate: "staff-created-car",
    vehicle_type: "A-1",
    inspection_expiry_date: expiryDate,
    statutory_inspection_date: statutoryDate,
  });
  assert.equal(vehicle.status, 201);
  assert.equal(vehicle.body.inspection_expiry_date, expiryDate);
  assert.equal(vehicle.body.statutory_inspection_date, statutoryDate);
  assert.equal((await employeeAgent.post("/api/vehicles").send({
    plate: "invalid-inspection-date",
    vehicle_type: "A-1",
    inspection_expiry_date: "2026-02-30",
  })).status, 422);
  let inspections = (await employeeAgent.get("/api/bootstrap")).body.inspection_reminders;
  assert.deepEqual(inspections.map((item) => item.inspection_type), [
    "vehicle_inspection", "statutory_inspection",
  ]);
  assert.equal((await employeeAgent.patch(`/api/vehicle-inspections/${vehicle.body.id}`).send({
    inspection_type: "vehicle_inspection",
    due_date: expiryDate,
    completed: true,
  })).status, 200);
  inspections = (await employeeAgent.get("/api/bootstrap")).body.inspection_reminders;
  assert.equal(inspections.find((item) => item.inspection_type === "vehicle_inspection").completed, true);
  application.db.prepare(`
    UPDATE vehicle_inspection_completions SET completed_at = ?
    WHERE vehicle_id = ? AND inspection_type = 'vehicle_inspection'
  `).run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), vehicle.body.id);
  inspections = (await employeeAgent.get("/api/bootstrap")).body.inspection_reminders;
  assert.deepEqual(inspections.map((item) => item.inspection_type), ["statutory_inspection"]);
  assert.equal((await employeeAgent.patch(`/api/vehicle-inspections/${vehicle.body.id}`).send({
    inspection_type: "statutory_inspection",
    due_date: dateAfterDays(31),
    completed: true,
  })).status, 409);

  const task = await employeeAgent.post("/api/tasks").send({
    scheduled_date: "2026-11-01",
    content: "把第四停车场的所有车辆清空",
  });
  assert.equal(task.status, 201);
  assert.equal((await employeeAgent.post("/api/tasks").send({
    scheduled_date: "2026-02-30",
    content: "invalid date",
  })).status, 422);
  assert.equal((await employeeAgent.patch(`/api/tasks/${task.body.id}`).send({
    completed: true,
  })).status, 200);
  let board = (await employeeAgent.get("/api/bootstrap")).body;
  assert.equal(board.tasks.find((item) => item.id === task.body.id).completed, 1);
  const exported = (await agent.get("/api/export/mariadb")).body.tables;
  assert.ok(exported.scheduled_tasks.some((item) => item.id === task.body.id));
  assert.ok(exported.vehicle_inspection_completions.some((item) =>
    item.vehicle_id === vehicle.body.id && item.inspection_type === "vehicle_inspection"));
  assert.equal(application.purgeTasks(new Date(Date.now() + 36 * 60 * 60 * 1000)), 1);
  board = (await employeeAgent.get("/api/bootstrap")).body;
  assert.equal(board.tasks.some((item) => item.id === task.body.id), false);

  const location = await employeeAgent.post("/api/parking-lots").send({ name: "Employee location" });
  assert.equal(location.status, 201);
  assert.equal((await employeeAgent.patch(`/api/parking-lots/${location.body.id}`).send({
    name: "Updated employee location",
  })).status, 200);
  assert.equal((await employeeAgent.delete(`/api/parking-lots/${location.body.id}`)).status, 204);
  assert.equal((await agent.delete(`/api/vehicles/${vehicle.body.id}`)).status, 204);

  assert.equal((await agent.delete(`/api/employees/${created.body.employee.id}`)).status, 204);
  assert.deepEqual((await employeeAgent.get("/api/me")).body, { authenticated: false, version: appVersion });
  assert.equal((await agent.delete(`/api/employees/${created.body.employee.id}`)).status, 404);
  assert.equal((await agent.get("/api/employees")).body.employees
    .some((employee) => employee.id === created.body.employee.id), false);
});

test("creates vehicles in separate positions and validates updates", async () => {
  const first = await agent.post("/api/vehicles").send({
    plate: "品川 500 あ 1234",
    vehicle_type: "A-2",
    parking_lot_id: 1,
    unwashed: true,
    options: ["ETC", "ナビ"],
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.unwashed, true);
  assert.equal(first.body.status_ids.length, 1);
  assert.deepEqual(first.body.options, ["ETC", "ナビ"]);
  assert.equal(Object.hasOwn(first.body, "board_section"), false);
  assert.deepEqual([first.body.position_x, first.body.position_y], [0.125, 0.0625]);
  vehicleId = first.body.id;

  const second = await agent.post("/api/vehicles").send({
    plate: "品川 500 あ 5678",
    vehicle_type: "A-1",
    parking_lot_id: 1,
  });
  assert.equal(second.status, 201);
  assert.notDeepEqual(
    [second.body.position_x, second.body.position_y],
    [first.body.position_x, first.body.position_y],
  );
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ position_x: 1.1 })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ position_x: null })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ parking_lot_id: 999 })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ vehicle_type: "unknown" })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ board_section: "unknown" })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ options: ["unknown"] })).status, 422);
  const customOption = await agent.post("/api/vehicle-options").send({ name: "ドラレコ" });
  assert.equal(customOption.status, 201);
  const customOptionsSaved = await agent.patch(`/api/vehicles/${vehicleId}`).send({
    options: ["ETC", customOption.body.name],
  });
  assert.equal(customOptionsSaved.status, 200);
  assert.deepEqual(customOptionsSaved.body.options, ["ETC", "ドラレコ"]);
  assert.equal((await agent.get("/api/bootstrap")).body.vehicle_options
    .some((option) => option.id === customOption.body.id), true);
  assert.equal((await agent.post("/api/vehicle-options").send({ name: "ドラレコ" })).status, 409);
  assert.equal((await agent.delete(`/api/vehicle-options/${customOption.body.id}`)).status, 204);
  assert.deepEqual((await agent.get("/api/bootstrap")).body.vehicles
    .find((vehicle) => vehicle.id === vehicleId).options, ["ETC"]);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    options: ["ドラレコ"],
  })).status, 422);
  const navigationOption = (await agent.get("/api/bootstrap")).body.vehicle_options
    .find((option) => option.name === "ナビ");
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    options: ["ETC", "ナビ"],
  })).status, 200);
  assert.equal((await agent.delete(`/api/vehicle-options/${navigationOption.id}`)).status, 204);
  assert.deepEqual((await agent.get("/api/bootstrap")).body.vehicles
    .find((vehicle) => vehicle.id === vehicleId).options, ["ETC"]);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ unknown: true })).status, 422);
  assert.equal((await request(server).post("/api/vehicles").send({
    plate: "No auth",
    vehicle_type: "standard",
  })).status, 401);
});

test("manages tenant-specific vehicle statuses and removes deleted assignments", async () => {
  const defaults = (await agent.get("/api/bootstrap")).body.statuses;
  const unwashed = defaults.find((status) => status.key === "unwashed");
  assert.ok(unwashed);
  assert.ok((await agent.get("/api/bootstrap")).body.vehicles
    .find((vehicle) => vehicle.id === vehicleId).status_ids.includes(unwashed.id));
  const added = await agent.post("/api/statuses").send({ name: "書類確認待ち", icon: "📄" });
  assert.equal(added.status, 201);
  assert.equal(added.body.name, "書類確認待ち");
  const customStatusId = added.body.id;
  const assigned = await agent.patch(`/api/vehicles/${vehicleId}`).send({
    status_ids: [customStatusId],
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.status_ids, [customStatusId]);
  assert.equal(assigned.body.unwashed, false);
  assert.equal((await agent.get("/api/bootstrap")).body.statuses
    .some((status) => status.id === customStatusId), true);

  assert.equal((await agent.delete(`/api/statuses/${customStatusId}`)).status, 204);
  const afterDelete = (await agent.get("/api/bootstrap")).body;
  assert.equal(afterDelete.statuses.some((status) => status.id === customStatusId), false);
  assert.deepEqual(afterDelete.vehicles.find((vehicle) => vehicle.id === vehicleId).status_ids, []);
  assert.equal((await agent.post("/api/statuses").send({
    name: "   ",
  })).status, 422);
  assert.equal((await agent.post("/api/statuses").send({
    name: "洗車待ち",
  })).status, 409);
  assert.equal((await agent.post("/api/statuses").send({
    name: "異常アイコン",
    icon: { unsafe: true },
  })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    status_ids: [customStatusId],
  })).status, 422);

  const restored = await agent.patch(`/api/vehicles/${vehicleId}`).send({ status_ids: [unwashed.id] });
  assert.equal(restored.body.unwashed, true);
});

test("persists editable vehicle assessment fields and damage marks", async () => {
  const bootstrap = (await agent.get("/api/bootstrap")).body;
  const fields = bootstrap.assessment_fields;
  assert.equal(fields.find((field) => field.built_in_key === "exterior").field_type, "rating");
  assert.equal(fields.find((field) => field.built_in_key === "registration_document").suffix, "確認済み");
  assert.equal(fields.find((field) => field.built_in_key === "mileage").suffix, "km");
  const exterior = fields.find((field) => field.built_in_key === "exterior");
  const documentField = fields.find((field) => field.built_in_key === "registration_document");
  const mileage = fields.find((field) => field.built_in_key === "mileage");
  const year = fields.find((field) => field.built_in_key === "registration_year");
  const month = fields.find((field) => field.built_in_key === "registration_month");
  const scratch = bootstrap.damage_types.find((type) => type.built_in_key === "scratch");
  assert.ok(scratch);
  assert.equal(bootstrap.damage_types.find((type) => type.built_in_key === "dent").name, "凹み");

  const customField = await agent.post("/api/assessment-fields").send({
    name: "ガラスの状態",
    field_type: "rating",
    suffix: "点",
  });
  assert.equal(customField.status, 201);
  const customDamage = await agent.post("/api/damage-types").send({
    name: "ガラス割れ",
    icon: "💥",
    color: "#336699",
  });
  assert.equal(customDamage.status, 201);
  const mark = {
    id: "scratch-front-left",
    damage_type_id: scratch.id,
    x: 0.21,
    y: 0.42,
    world_x: -1.25,
    world_y: 0.9,
    world_z: 0.79,
    world_nx: 0,
    world_ny: 0,
    world_nz: 1,
  };
  const updated = await agent.patch(`/api/vehicles/${vehicleId}`).send({
    notes: "冬タイヤはトランクに保管しています。",
    assessment_values: {
      [exterior.id]: "4",
      [documentField.id]: true,
      [mileage.id]: "123456",
      [year.id]: "2022",
      [month.id]: "7",
      [customField.body.id]: "5",
    },
    inspection_marks: [mark, {
      id: "glass-crack",
      damage_type_id: customDamage.body.id,
      x: 0.67,
      y: 0.31,
    }],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.notes, "冬タイヤはトランクに保管しています。");
  assert.equal(updated.body.assessment_values[exterior.id], "4");
  assert.equal(updated.body.assessment_values[documentField.id], "true");
  assert.equal(updated.body.assessment_values[mileage.id], "123456");
  assert.equal(updated.body.inspection_marks.length, 2);
  assert.deepEqual(
    [updated.body.inspection_marks[0].x, updated.body.inspection_marks[0].y],
    [0.21, 0.42],
  );
  assert.deepEqual(
    [updated.body.inspection_marks[0].world_x, updated.body.inspection_marks[0].world_y, updated.body.inspection_marks[0].world_z],
    [-1.25, 0.9, 0.79],
  );
  assert.deepEqual(
    [updated.body.inspection_marks[0].world_nx, updated.body.inspection_marks[0].world_ny, updated.body.inspection_marks[0].world_nz],
    [0, 0, 1],
  );
  const boardVehicle = (await agent.get("/api/bootstrap")).body.vehicles
    .find((vehicle) => vehicle.id === vehicleId);
  assert.equal(boardVehicle.assessment_values[year.id], "2022");
  assert.equal(boardVehicle.notes, "冬タイヤはトランクに保管しています。");
  assert.equal(boardVehicle.inspection_marks[1].name, "ガラス割れ");

  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    assessment_values: { [exterior.id]: "6" },
  })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    assessment_values: { [month.id]: "13" },
  })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    inspection_marks: [{ ...mark, x: 1.1 }],
  })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    inspection_marks: [{ ...mark, world_z: 4 }],
  })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    inspection_marks: [{ ...mark, world_nz: 2 }],
  })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    notes: "x".repeat(5001),
  })).status, 422);
  assert.equal((await agent.post("/api/assessment-fields").send({
    name: "不正形式",
    field_type: "unknown",
  })).status, 422);
  assert.equal((await agent.post("/api/damage-types").send({
    name: "不正色",
    color: "red",
  })).status, 422);

  const unchanged = await agent.patch(`/api/vehicles/${vehicleId}`).send({ plate: "評価保持テスト" });
  assert.equal(unchanged.body.assessment_values[exterior.id], "4");
  assert.equal(unchanged.body.inspection_marks.length, 2);
  assert.equal(unchanged.body.notes, "冬タイヤはトランクに保管しています。");
  assert.equal((await agent.delete(`/api/assessment-fields/${customField.body.id}`)).status, 204);
  assert.equal((await agent.delete(`/api/damage-types/${customDamage.body.id}`)).status, 204);
  const afterDelete = (await agent.get("/api/bootstrap")).body.vehicles
    .find((vehicle) => vehicle.id === vehicleId);
  assert.equal(Object.hasOwn(afterDelete.assessment_values, customField.body.id), false);
  assert.equal(afterDelete.inspection_marks.length, 1);
});

test("exports tenant vehicle data as a MariaDB migration package without credentials", async () => {
  const response = await agent.get("/api/export/mariadb");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/json/);
  assert.match(response.headers["content-disposition"], /guts-parking-mariadb-1-\d{4}-\d{2}-\d{2}\.json/);
  assert.equal(response.headers["cache-control"], "no-store");
  const exported = JSON.parse(response.text);
  assert.equal(exported.format, "guts-parking-mariadb-export");
  assert.equal(exported.format_version, 1);
  assert.equal(exported.target_database, "MariaDB 10.11.10");
  assert.equal(exported.tenant.name, "本店");
  assert.equal(exported.tables.vehicles.find((vehicle) => vehicle.id === vehicleId).plate, "評価保持テスト");
  assert.equal(exported.tables.vehicles.find((vehicle) => vehicle.id === vehicleId).vehicle_model, "");
  assert.ok(exported.tables.vehicle_models.some((model) => model.name === "ミニカ"));
  assert.equal(exported.tables.vehicle_assessment_values.length > 0, true);
  assert.equal(exported.tables.vehicle_damage_marks.length, 1);
  assert.equal(Object.hasOwn(exported.tables, "users"), false);
  assert.equal(Object.hasOwn(exported.tables, "sessions"), false);
  assert.equal(response.text.includes("password_hash"), false);
});

test("operator accounts can add vehicles and manage locations without admin settings", async () => {
  application.db.prepare("INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, 1)").run(
    "staff",
    await hashPassword("staff-password-strong"),
    "operator",
  );
  const staffAgent = request.agent(server);
  const login = await staffAgent.post("/api/login").send({
    username: "staff",
    password: "staff-password-strong",
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.can_manage, false);
  assert.deepEqual((await staffAgent.get("/api/me")).body, {
    authenticated: true,
    version: appVersion,
    username: "staff",
    can_manage: false,
    can_manage_franchises: false,
    tenant_name: "本店",
  });
  assert.equal((await staffAgent.get("/api/bootstrap")).status, 200);
  const staffVehicle = await staffAgent.post("/api/vehicles").send({
    plate: "staff-add-allowed",
    vehicle_type: "A-1",
  });
  assert.equal(staffVehicle.status, 201);
  const staffLocation = await staffAgent.post("/api/parking-lots").send({ name: "staff-location-allowed" });
  assert.equal(staffLocation.status, 201);
  assert.equal((await staffAgent.patch(`/api/parking-lots/${staffLocation.body.id}`).send({
    name: "staff-location-renamed",
  })).status, 200);
  assert.equal((await staffAgent.delete(`/api/parking-lots/${staffLocation.body.id}`)).status, 204);
  assert.equal((await agent.delete(`/api/vehicles/${staffVehicle.body.id}`)).status, 204);
  assert.equal((await staffAgent.post("/api/statuses").send({ name: "staff-add-denied" })).status, 403);
  assert.equal((await staffAgent.post("/api/vehicle-options").send({ name: "staff-add-denied" })).status, 403);
  const defaultClassId = (await agent.get("/api/bootstrap")).body.vehicle_classes[0].id;
  assert.equal((await staffAgent.post(`/api/vehicle-classes/${defaultClassId}/models`)
    .send({ name: "staff-model-denied" })).status, 403);
  const adminStatus = await agent.post("/api/statuses").send({ name: "admin-only-status" });
  assert.equal(adminStatus.status, 201);
  assert.equal((await staffAgent.delete(`/api/statuses/${adminStatus.body.id}`)).status, 403);
  assert.equal((await agent.delete(`/api/statuses/${adminStatus.body.id}`)).status, 204);
  assert.equal((await staffAgent.delete("/api/franchises/2").send({ confirmation_name: "anything" })).status, 403);
  assert.equal((await staffAgent.put("/api/parking-lots/order").send({
    ids: Array.from({ length: 13 }, (_, index) => index + 1),
  })).status, 200);
  assert.equal((await staffAgent.delete(`/api/vehicles/${vehicleId}`)).status, 403);
  const updated = await staffAgent.patch(`/api/vehicles/${vehicleId}`).send({ no_fuel: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.no_fuel, true);
});

test("headquarters can create isolated franchise stores and suspend or restore access", async () => {
  const headquartersOnlyStatus = await agent.post("/api/statuses")
    .send({ name: "本店専用ステータス" });
  assert.equal(headquartersOnlyStatus.status, 201);
  const headquartersOnlyField = await agent.post("/api/assessment-fields").send({
    name: "本店専用チェック",
    field_type: "checkbox",
  });
  assert.equal(headquartersOnlyField.status, 201);
  const headquartersOnlyDamage = await agent.post("/api/damage-types").send({
    name: "本店専用損傷",
  });
  assert.equal(headquartersOnlyDamage.status, 201);
  assert.equal((await agent.post("/api/franchises").send({
    name: "東店",
    username: "east-admin",
    password: "franchise-password-strong",
  })).status, 201);
  const franchise = (await agent.get("/api/franchises")).body.franchises.find((store) => store.name === "東店");
  assert.ok(franchise);
  assert.equal(franchise.is_active, true);
  assert.equal(franchise.admin_usernames, "east-admin");
  assert.equal((await agent.post("/api/franchises").send({
    name: "東店",
    username: "east-admin-2",
    password: "franchise-password-strong",
  })).status, 409);
  assert.equal((await agent.post("/api/franchises").send({
    name: "短密碼店",
    username: "short-password",
    password: "short",
  })).status, 422);

  const franchiseAgent = request.agent(server);
  const login = await franchiseAgent.post("/api/login").send({
    username: "east-admin",
    password: "franchise-password-strong",
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.tenant_name, "東店");
  assert.equal(login.body.can_manage, true);
  assert.equal(login.body.can_manage_franchises, false);
  const franchiseCookie = login.headers["set-cookie"][0].split(";")[0];
  const headquartersBoard = (await agent.get("/api/bootstrap")).body;
  const franchiseBoard = (await franchiseAgent.get("/api/bootstrap")).body;
  assert.equal(headquartersBoard.parking_lots.length, 13);
  assert.equal(franchiseBoard.parking_lots.length, 13);
  assert.equal(new Set(franchiseBoard.parking_lots.map((lot) => lot.name)).size, 13);
  assert.equal(franchiseBoard.vehicles.length, 0);
  assert.deepEqual(franchiseBoard.vehicle_models
    .filter((model) => model.vehicle_type === "A-1").map((model) => model.name), ["ミニカ", "アルト", "ミラ"]);
  assert.equal(franchiseBoard.statuses.some((status) =>
    status.id === headquartersOnlyStatus.body.id), false);
  assert.equal(franchiseBoard.assessment_fields.some((field) =>
    field.id === headquartersOnlyField.body.id), false);
  assert.equal(franchiseBoard.damage_types.some((type) =>
    type.id === headquartersOnlyDamage.body.id), false);
  assert.equal(franchiseBoard.vehicle_options.some((option) => option.name === "ドラレコ"), false);
  assert.ok(franchiseBoard.vehicle_options.some((option) => option.name === "ETC"));
  const franchiseOption = await franchiseAgent.post("/api/vehicle-options").send({ name: "東店専用装備" });
  assert.equal(franchiseOption.status, 201);
  assert.equal((await agent.get("/api/bootstrap")).body.vehicle_options
    .some((option) => option.id === franchiseOption.body.id), false);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({
    parking_lot_id: franchiseBoard.parking_lots[0].id,
  })).status, 422);
  const franchiseMarking = [{
    id: "franchise-boundary",
    color: "#336699",
    x1: 0.1,
    y1: 0.1,
    x2: 0.9,
    y2: 0.9,
  }];
  assert.equal((await franchiseAgent.patch(`/api/parking-lots/${franchiseBoard.parking_lots[0].id}`)
    .send({ markings: franchiseMarking })).status, 200);
  assert.deepEqual(
    (await franchiseAgent.get("/api/bootstrap")).body.parking_lots[0].markings,
    franchiseMarking,
  );
  assert.deepEqual((await agent.get("/api/bootstrap")).body.parking_lots[0].markings, []);

  const franchiseVehicle = await franchiseAgent.post("/api/vehicles").send({
    plate: "東店 500 あ 0001",
    vehicle_type: "A-1",
  });
  assert.equal(franchiseVehicle.status, 201);
  assert.equal((await franchiseAgent.patch(`/api/vehicles/${franchiseVehicle.body.id}`).send({
    status_ids: [headquartersOnlyStatus.body.id],
  })).status, 422);
  assert.equal((await franchiseAgent.patch(`/api/vehicles/${franchiseVehicle.body.id}`).send({
    assessment_values: { [headquartersOnlyField.body.id]: true },
  })).status, 422);
  assert.equal((await franchiseAgent.patch(`/api/vehicles/${franchiseVehicle.body.id}`).send({
    inspection_marks: [{
      id: "foreign-tenant-mark",
      damage_type_id: headquartersOnlyDamage.body.id,
      x: 0.4,
      y: 0.6,
    }],
  })).status, 422);
  const franchiseStatus = await franchiseAgent.post("/api/statuses")
    .send({ name: "東店専用ステータス" });
  assert.equal(franchiseStatus.status, 201);
  assert.equal((await franchiseAgent.patch(`/api/vehicles/${franchiseVehicle.body.id}`).send({
    status_ids: [franchiseStatus.body.id],
  })).status, 200);
  assert.equal((await agent.patch(`/api/vehicles/${franchiseVehicle.body.id}`).send({ no_fuel: true })).status, 404);
  assert.equal((await franchiseAgent.patch(`/api/vehicles/${vehicleId}`).send({ no_fuel: true })).status, 404);
  assert.equal((await franchiseAgent.delete(`/api/vehicles/${vehicleId}`)).status, 404);
  assert.equal((await franchiseAgent.get("/api/franchises")).status, 403);
  assert.equal((await franchiseAgent.delete(`/api/parking-lots/${headquartersBoard.parking_lots[0].id}`)).status, 404);
  assert.equal(
    (await agent.get("/api/bootstrap")).body.vehicles.some((vehicle) => vehicle.plate === "東店 500 あ 0001"),
    false,
  );

  const headquartersSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: sessionCookie, Origin: baseUrl },
  });
  const franchiseSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: franchiseCookie, Origin: baseUrl },
  });
  await Promise.all([once(headquartersSocket, "open"), once(franchiseSocket, "open")]);
  const headquartersUnexpectedMessage = new Promise((resolve) =>
    headquartersSocket.once("message", () => resolve("message")));
  const franchiseMessage = once(franchiseSocket, "message");
  await franchiseAgent.patch(`/api/vehicles/${franchiseVehicle.body.id}`).send({ no_fuel: true });
  assert.deepEqual(JSON.parse((await franchiseMessage)[0].toString()), { type: "refresh" });
  assert.equal(await Promise.race([
    headquartersUnexpectedMessage,
    new Promise((resolve) => setTimeout(() => resolve("quiet"), 50)),
  ]), "quiet");

  const franchiseSocketClosed = once(franchiseSocket, "close");
  const suspended = await agent.patch(`/api/franchises/${franchise.id}/status`).send({ is_active: false });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.is_active, false);
  const [suspensionCode] = await franchiseSocketClosed;
  assert.equal(suspensionCode, 4003);
  assert.equal((await franchiseAgent.get("/api/bootstrap")).status, 403);
  assert.equal((await request(server).post("/api/login").send({
    username: "east-admin",
    password: "franchise-password-strong",
  })).status, 403);
  assert.equal((await agent.patch(`/api/franchises/${franchise.id}/status`).send({ is_active: true })).status, 200);
  assert.equal((await franchiseAgent.get("/api/bootstrap")).status, 200);
  assert.equal((await agent.delete(`/api/franchises/${franchise.id}`)
    .send({ confirmation_name: "wrong name" })).status, 422);
  const deletionSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: franchiseCookie, Origin: baseUrl },
  });
  await once(deletionSocket, "open");
  const deletionSocketClosed = once(deletionSocket, "close");
  assert.equal((await agent.delete(`/api/franchises/${franchise.id}`)
    .send({ confirmation_name: franchise.name })).status, 204);
  const [deletionCode] = await deletionSocketClosed;
  assert.equal(deletionCode, 4004);
  assert.equal((await agent.delete(`/api/statuses/${headquartersOnlyStatus.body.id}`)).status, 204);
  assert.equal((await agent.delete(`/api/assessment-fields/${headquartersOnlyField.body.id}`)).status, 204);
  assert.equal((await agent.delete(`/api/damage-types/${headquartersOnlyDamage.body.id}`)).status, 204);
  assert.equal((await franchiseAgent.get("/api/bootstrap")).status, 401);
  assert.equal(application.db.prepare("SELECT 1 FROM tenants WHERE id = ?").get(franchise.id), undefined);
  assert.equal(application.db.prepare("SELECT 1 FROM vehicles WHERE tenant_id = ?").get(franchise.id), undefined);
  const headquartersSocketClosed = once(headquartersSocket, "close");
  headquartersSocket.close();
  await headquartersSocketClosed;
});

test("rejects cross-origin changes and broadcasts edits only to authenticated websockets", async () => {
  const crossOrigin = await agent.patch(`/api/vehicles/${vehicleId}`)
    .set("Origin", "https://attacker.example")
    .send({ plate: "forbidden" });
  assert.equal(crossOrigin.status, 403);

  const unauthenticatedSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Origin: baseUrl },
  });
  const [, rejectedResponse] = await Promise.race([
    once(unauthenticatedSocket, "unexpected-response"),
    once(unauthenticatedSocket, "open").then(() => {
      throw new Error("Unauthenticated websocket connection unexpectedly opened.");
    }),
  ]);
  assert.equal(rejectedResponse.statusCode, 401);
  unauthenticatedSocket.terminate();

  const missingOriginSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: sessionCookie },
  });
  const [, missingOriginResponse] = await Promise.race([
    once(missingOriginSocket, "unexpected-response"),
    once(missingOriginSocket, "open").then(() => {
      throw new Error("Websocket connection without an Origin unexpectedly opened.");
    }),
  ]);
  assert.equal(missingOriginResponse.statusCode, 403);
  missingOriginSocket.terminate();

  const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: sessionCookie, Origin: baseUrl },
  });
  await once(websocket, "open");
  try {
    const assessmentFieldMessage = once(websocket, "message");
    const assessmentField = await agent.post("/api/assessment-fields").send({
      name: "リアルタイム検査項目",
      field_type: "text",
    });
    assert.equal(assessmentField.status, 201);
    assert.deepEqual(JSON.parse((await assessmentFieldMessage)[0].toString()), { type: "refresh" });
    const assessmentUpdateMessage = once(websocket, "message");
    const assessmentFieldValue = await agent.patch(`/api/vehicles/${vehicleId}`).send({
      assessment_values: { [assessmentField.body.id]: "同期済み" },
    });
    assert.equal(assessmentFieldValue.body.assessment_values[assessmentField.body.id], "同期済み");
    assert.deepEqual(JSON.parse((await assessmentUpdateMessage)[0].toString()), { type: "refresh" });
    const assessmentDeleteMessage = once(websocket, "message");
    assert.equal((await agent.delete(`/api/assessment-fields/${assessmentField.body.id}`)).status, 204);
    assert.deepEqual(JSON.parse((await assessmentDeleteMessage)[0].toString()), { type: "refresh" });

    const statusCreatedMessage = once(websocket, "message");
    const statusCreated = await agent.post("/api/statuses")
      .send({ name: "同期確認", icon: "📌" });
    assert.equal(statusCreated.status, 201);
    assert.deepEqual(JSON.parse((await statusCreatedMessage)[0].toString()), { type: "refresh" });
    const statusDeletedMessage = once(websocket, "message");
    assert.equal((await agent.delete(`/api/statuses/${statusCreated.body.id}`)).status, 204);
    assert.deepEqual(JSON.parse((await statusDeletedMessage)[0].toString()), { type: "refresh" });

    const message = once(websocket, "message");
    const updated = await agent.patch(`/api/vehicles/${vehicleId}`).send({
      parking_lot_id: 2,
      position_x: 0.6,
      position_y: 0.2,
      no_fuel: true,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.no_fuel, true);
    assert.equal(updated.body.parking_lot_id, 2);
    assert.deepEqual(JSON.parse((await message)[0].toString()), { type: "refresh" });
  } finally {
    websocket.close();
    await once(websocket, "close");
  }
});

test("syncs ERP records idempotently while preserving board-managed status and position", async () => {
  const payload = [{
    external_id: "fleet-vehicle-42",
    plate: "品川 500 あ 1111",
    vehicle_type: "A-2",
    parking_lot_id: 1,
  }];
  assert.equal((await agent.post("/api/integration/vehicles:sync").send(payload)).status, 503);

  const appWithErp = createApplication({
    databasePath: ":memory:",
    sessionSecret: "another-test-session-secret-value-123",
    erpApiKey: "erp-test-key",
  });
  try {
    const erpServer = appWithErp.createServer();
    erpServer.listen(0, "127.0.0.1");
    extraServers.push(erpServer);
    await once(erpServer, "listening");
    const erpAgent = request(erpServer);
    const headers = { "X-ERP-API-Key": "erp-test-key" };
    assert.equal((await erpAgent.post("/api/integration/vehicles:sync").send(payload)).status, 401);
    assert.deepEqual(
      (await erpAgent.post("/api/integration/vehicles:sync").set(headers).send(payload)).body,
      { synced: 1 },
    );
    const vehicle = appWithErp.db.prepare("SELECT * FROM vehicles WHERE external_id = ?").get("fleet-vehicle-42");
    appWithErp.db.prepare("UPDATE vehicles SET unwashed = 1, position_x = 0.8 WHERE id = ?").run(vehicle.id);
    payload[0].plate = "品川 500 あ 2222";
    assert.deepEqual(
      (await erpAgent.post("/api/integration/vehicles:sync").set(headers).send(payload)).body,
      { synced: 1 },
    );
    const updated = appWithErp.db.prepare("SELECT * FROM vehicles WHERE external_id = ?").get("fleet-vehicle-42");
    assert.equal(updated.plate, "品川 500 あ 2222");
    assert.equal(updated.unwashed, 1);
    assert.equal(updated.position_x, 0.8);

    const withoutLocation = {
      external_id: "fleet-vehicle-43",
      plate: "品川 500 あ 3333",
      vehicle_type: "B",
    };
    assert.deepEqual(
      (await erpAgent.post("/api/integration/vehicles:sync").set(headers).send([withoutLocation])).body,
      { synced: 1 },
    );
    const firstLotId = appWithErp.db.prepare(
      "SELECT id FROM parking_lots WHERE tenant_id = 1 ORDER BY display_order, id LIMIT 1",
    ).get().id;
    const defaultVehicle = appWithErp.db.prepare("SELECT * FROM vehicles WHERE external_id = ?")
      .get(withoutLocation.external_id);
    assert.equal(defaultVehicle.parking_lot_id, firstLotId);
    appWithErp.db.prepare("UPDATE vehicles SET parking_lot_id = 2 WHERE id = ?").run(defaultVehicle.id);
    withoutLocation.plate = "品川 500 あ 4444";
    await erpAgent.post("/api/integration/vehicles:sync").set(headers).send([withoutLocation]);
    assert.equal(
      appWithErp.db.prepare("SELECT parking_lot_id FROM vehicles WHERE id = ?").get(defaultVehicle.id).parking_lot_id,
      2,
    );
    assert.equal((await erpAgent.get("/api/v1/integration/vehicles")).status, 401);
    const exported = (await erpAgent.get("/api/v1/integration/vehicles").set(headers)).body.vehicles;
    const row = exported.find((item) => item.external_id === "fleet-vehicle-43");
    assert.equal(row.plate, "品川 500 あ 4444");
    assert.equal(row.parking_lot_id, 2);
    assert.ok(row.parking_lot_name);
    assert.equal(
      (await erpAgent.post("/api/v1/integration/vehicles:sync").set(headers).send([withoutLocation])).status,
      200,
    );
  } finally {
    appWithErp.db.close();
  }
});

test("exposes health, versioned API alias and PWA assets for mobile packaging", async () => {
  const health = await agent.get("/api/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal((await agent.get("/api/health")).body.version, health.body.version);
  assert.deepEqual((await agent.get("/api/v1/me")).body, (await agent.get("/api/me")).body);
  const manifest = await agent.get("/static/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.equal(JSON.parse(manifest.text).display, "standalone");
  assert.equal((await agent.get("/sw.js")).status, 200);
  assert.equal((await agent.get("/static/privacy.html")).status, 200);
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  assert.match(html, /rel="manifest"/);
  assert.match(html, /\/static\/pwa\.js/);
});

test("password hashes are unique, verifiable, and reject short passwords", async () => {
  const first = await hashPassword("correct-horse-battery");
  const second = await hashPassword("correct-horse-battery");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct-horse-battery", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
  await assert.rejects(hashPassword("short"), /at least 12/);
});

test("deletes a vehicle and reports missing ids", async () => {
  const staffAgent = request.agent(server);
  application.db.prepare("INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, 1)").run(
    "delete-test-staff",
    await hashPassword("staff-delete-test-password"),
    "operator",
  );
  await staffAgent.post("/api/login").send({
    username: "delete-test-staff",
    password: "staff-delete-test-password",
  });
  assert.equal((await staffAgent.delete(`/api/vehicles/${vehicleId}`)).status, 403);
  const deleted = await agent.delete(`/api/vehicles/${vehicleId}`);
  assert.equal(deleted.status, 204);
  assert.equal((await agent.delete(`/api/vehicles/${vehicleId}`)).status, 404);
  assert.equal((await agent.post("/api/vehicles").send({
    plate: "cross-origin",
    vehicle_type: "A-1",
  }).set("Origin", "https://attacker.example")).status, 403);
});

test("creates new vehicles in the top location and moves them between peer locations", async () => {
  const created = await agent.post("/api/vehicles").send({
    plate: "新規 100 あ 0001",
    vehicle_type: "A-1",
    options: ["禁煙", "スタッドレス"],
    notes: "ナビの調子を確認",
  });
  assert.equal(created.status, 201);
  const locations = (await agent.get("/api/bootstrap")).body.parking_lots;
  assert.equal(created.body.parking_lot_id, locations[0].id);
  assert.equal(Object.hasOwn(created.body, "board_section"), false);
  assert.deepEqual(created.body.options, ["禁煙", "スタッドレス"]);
  assert.equal(created.body.notes, "ナビの調子を確認");
  assert.equal((await agent.post("/api/vehicles").send({
    plate: "備考過長 100 あ 0002",
    vehicle_type: "A-1",
    notes: "x".repeat(5001),
  })).status, 422);
  const moved = await agent.patch(`/api/vehicles/${created.body.id}`).send({
    parking_lot_id: locations.find((lot) => lot.name === "駅前店貸出中").id,
    position_x: 0.37,
    position_y: 0.62,
    options: ["ETC"],
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.parking_lot_id, locations.find((lot) => lot.name === "駅前店貸出中").id);
  assert.deepEqual([moved.body.position_x, moved.body.position_y], [0.37, 0.62]);
  assert.deepEqual(moved.body.options, ["ETC"]);
  for (const location of locations) {
    const placed = await agent.patch(`/api/vehicles/${created.body.id}`).send({
      parking_lot_id: location.id,
      position_x: 0.25,
      position_y: 0.75,
    });
    assert.equal(placed.status, 200, `vehicle should move to ${location.name}`);
    assert.equal(placed.body.parking_lot_id, location.id);
  }
  assert.deepEqual(
    (await agent.get("/api/bootstrap")).body.vehicle_types,
    ["A-1", "A-2", "A-2P", "B", "B軽トラ", "C-1", "C-2", "D", "H-1", "H-2", "その他"],
  );
});

test("persists parking lot size and order and rejects invalid layouts", async () => {
  const initialLots = (await agent.get("/api/bootstrap")).body.parking_lots;
  assert.equal(initialLots.length, 13);
  assert.deepEqual(
    [initialLots[0].display_order, initialLots[0].area_height, initialLots[0].area_width],
    [0, 210, 50],
  );
  const resized = await agent.patch("/api/parking-lots/4").send({
    area_height: 370,
    area_width: 73,
  });
  assert.equal(resized.status, 200);
  assert.deepEqual([resized.body.area_height, resized.body.area_width], [370, 73]);
  assert.equal((await agent.patch("/api/parking-lots/4").send({ area_height: 900 })).status, 422);
  assert.equal((await agent.patch("/api/parking-lots/4").send({ area_width: 101 })).status, 422);
  assert.equal((await agent.patch("/api/parking-lots/4").send({ area_width: 29 })).status, 422);
  assert.equal((await agent.put("/api/parking-lots/order").send({ ids: [1, 2] })).status, 422);
  const reordered = await agent.put("/api/parking-lots/order").send({
    ids: [4, ...initialLots.filter((lot) => lot.id !== 4).map((lot) => lot.id)],
  });
  assert.equal(reordered.status, 200);
  assert.deepEqual(
    (await agent.get("/api/bootstrap")).body.parking_lots.map((lot) => lot.id),
    [4, ...initialLots.filter((lot) => lot.id !== 4).map((lot) => lot.id)],
  );
});

test("adds locations and renames them without moving their vehicles", async () => {
  const navigationUrl = "https://maps.app.goo.gl/example";
  const created = await agent.post("/api/parking-lots").send({
    name: "洗車待ち",
    navigation_url: navigationUrl,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    [created.body.name, created.body.display_order, created.body.area_height, created.body.area_width],
    ["洗車待ち", 13, 210, 50],
  );
  assert.equal(created.body.navigation_url, navigationUrl);
  assert.equal((await agent.post("/api/parking-lots").send({ name: "洗車待ち" })).status, 409);
  assert.equal((await agent.post("/api/parking-lots").send({ name: "   " })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({ name: "x".repeat(41) })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({
    name: "不正リンク",
    navigation_url: "https://attacker.example/maps",
  })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({
    name: "HTTPリンク",
    navigation_url: "http://maps.google.com/maps",
  })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({
    name: "偽装リンク",
    navigation_url: "https://attacker.example@maps.google.com/maps",
  })).status, 422);
  const vehicle = await agent.post("/api/vehicles").send({
    plate: "位置変更 100 あ 0001",
    vehicle_type: "A-1",
    parking_lot_id: created.body.id,
  });
  assert.equal(vehicle.status, 201);
  const renamed = await agent.patch(`/api/parking-lots/${created.body.id}`).send({
    name: "洗車エリア",
    navigation_url: "https://www.google.com/maps/dir/?api=1",
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "洗車エリア");
  assert.equal(renamed.body.navigation_url, "https://www.google.com/maps/dir/?api=1");
  assert.equal((await agent.patch(`/api/parking-lots/${created.body.id}`).send({
    navigation_url: "https://www.google.com.evil.example/maps",
  })).status, 422);
  const cleared = await agent.patch(`/api/parking-lots/${created.body.id}`).send({ navigation_url: "" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.navigation_url, "");
  await agent.patch(`/api/parking-lots/${created.body.id}`).send({
    navigation_url: "https://www.google.com/maps/search/?api=1",
  });
  assert.equal((await agent.patch(`/api/parking-lots/${created.body.id}`).send({ name: "駐車場 1" })).status, 409);
  const bootstrap = await agent.get("/api/bootstrap");
  assert.equal(bootstrap.body.parking_lots.find((lot) => lot.id === created.body.id).name, "洗車エリア");
  assert.equal(
    bootstrap.body.parking_lots.find((lot) => lot.id === created.body.id).navigation_url,
    "https://www.google.com/maps/search/?api=1",
  );
  assert.equal(
    bootstrap.body.vehicles.find((entry) => entry.id === vehicle.body.id).parking_lot_id,
    created.body.id,
  );
  assert.equal((await request(server).post("/api/parking-lots").send({ name: "認証なし" })).status, 401);
});

test("saves, validates, and clears colored parking location lines", async () => {
  const lot = (await agent.get("/api/bootstrap")).body.parking_lots[0];
  const markings = [{
    id: "driveway-center",
    color: "#e34b4b",
    x1: 0.1,
    y1: 0.25,
    x2: 0.9,
    y2: 0.75,
  }];
  const saved = await agent.post(`/api/parking-lots/${lot.id}/markings`).send({ markings });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.markings, markings);
  assert.equal((await request(server).post(`/api/parking-lots/${lot.id}/markings`).send({ markings })).status, 401);
  assert.equal((await agent.post(`/api/parking-lots/${lot.id}/markings`).send({
    markings,
    name: "should-not-be-accepted",
  })).status, 422);
  assert.deepEqual(
    (await agent.get("/api/bootstrap")).body.parking_lots.find((entry) => entry.id === lot.id).markings,
    markings,
  );
  assert.equal((await agent.patch(`/api/parking-lots/${lot.id}`).send({
    markings: [{ ...markings[0], color: "red" }],
  })).status, 422);
  assert.equal((await agent.patch(`/api/parking-lots/${lot.id}`).send({
    markings: [{ ...markings[0], x2: 1.01 }],
  })).status, 422);
  assert.equal((await agent.patch(`/api/parking-lots/${lot.id}`).send({
    markings: Array.from({ length: 101 }, (_, index) => ({ ...markings[0], id: `line-${index}` })),
  })).status, 422);
  assert.equal((await agent.post(`/api/parking-lots/${lot.id}/markings`).send({ markings: [] })).status, 200);
  assert.deepEqual(
    (await agent.get("/api/bootstrap")).body.parking_lots.find((entry) => entry.id === lot.id).markings,
    [],
  );
});

test("keeps a deleted built-in vehicle option removed after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentalcar-options-"));
  const databasePath = path.join(directory, "options.sqlite");
  try {
    const database = openDatabase(databasePath);
    const option = database.prepare(
      "SELECT id, built_in_key FROM vehicle_option_types WHERE tenant_id = 1 AND name = 'ETC'",
    ).get();
    database.prepare(
      "INSERT INTO vehicle_option_suppressions (tenant_id, built_in_key) VALUES (1, ?)",
    ).run(option.built_in_key);
    database.prepare("DELETE FROM vehicle_option_types WHERE id = ?").run(option.id);
    seedTenantVehicleOptions(database, 1);
    assert.equal(database.prepare(
      "SELECT 1 FROM vehicle_option_types WHERE tenant_id = 1 AND name = 'ETC'",
    ).get(), undefined);
    database.close();

    const reopened = openDatabase(databasePath);
    assert.equal(reopened.prepare(
      "SELECT 1 FROM vehicle_option_types WHERE tenant_id = 1 AND name = 'ETC'",
    ).get(), undefined);
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deletes empty parking locations but protects occupied locations and tenant data", async () => {
  const lot = await agent.post("/api/parking-lots").send({ name: "削除対象位置" });
  assert.equal(lot.status, 201);
  assert.equal((await agent.delete(`/api/parking-lots/${lot.body.id}`)).status, 204);
  assert.equal((await agent.get("/api/bootstrap")).body.parking_lots.some((entry) => entry.id === lot.body.id), false);
  assert.equal((await agent.delete("/api/parking-lots/1")).status, 409);
  const reserve = (await agent.get("/api/bootstrap")).body.parking_lots.find((entry) => entry.name === "予備");
  assert.equal((await agent.delete(`/api/parking-lots/${reserve.id}`)).status, 204);
  const afterReserveRemoval = (await agent.post("/api/vehicles").send({
    plate: "予備削除後テスト",
    vehicle_type: "A-1",
  }));
  assert.equal(afterReserveRemoval.status, 201);
  assert.equal(afterReserveRemoval.body.parking_lot_id,
    (await agent.get("/api/bootstrap")).body.parking_lots[0].id);
  const lastLocationStore = await agent.post("/api/franchises").send({
    name: "最後の位置検証店",
    username: "last-location-admin",
    password: "franchise-password-strong",
  });
  const lastLocationAgent = request.agent(server);
  await lastLocationAgent.post("/api/login").send({
    username: "last-location-admin",
    password: "franchise-password-strong",
  });
  const storeLots = (await lastLocationAgent.get("/api/bootstrap")).body.parking_lots;
  for (const location of storeLots.slice(0, -1)) {
    assert.equal((await lastLocationAgent.delete(`/api/parking-lots/${location.id}`)).status, 204);
  }
  assert.equal((await lastLocationAgent.delete(`/api/parking-lots/${storeLots.at(-1).id}`)).status, 409);
  assert.equal((await agent.delete(`/api/franchises/${lastLocationStore.body.franchise.id}`)
    .send({ confirmation_name: "最後の位置検証店" })).status, 204);
  const franchise = await agent.post("/api/franchises").send({
    name: "位置削除検証店",
    username: "lot-delete-admin",
    password: "franchise-password-strong",
  });
  assert.equal(franchise.status, 201);
  const franchiseLot = application.db.prepare(
    "SELECT id FROM parking_lots WHERE tenant_id = ? ORDER BY id LIMIT 1",
  ).get(franchise.body.franchise.id);
  assert.equal((await agent.delete(`/api/parking-lots/${franchiseLot.id}`)).status, 404);
});

test("flattens previous board sections into peer locations without losing vehicle data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentalcar-migration-"));
  const databasePath = path.join(directory, "legacy.db");
  const legacySchema = `
    CREATE TABLE parking_lots (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      area_height INTEGER NOT NULL DEFAULT 210,
      area_width INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY,
      external_id TEXT UNIQUE,
      plate TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      parking_lot_id INTEGER,
      position_x REAL NOT NULL DEFAULT 0.5,
      position_y REAL NOT NULL DEFAULT 0.5,
      unwashed INTEGER NOT NULL DEFAULT 0,
      no_fuel INTEGER NOT NULL DEFAULT 0,
      needs_repair INTEGER NOT NULL DEFAULT 0,
      board_section TEXT NOT NULL DEFAULT '予備',
      options TEXT NOT NULL DEFAULT '[]'
    )
  `;
  const migrationScript = `
    const assert = require("node:assert/strict");
    const { DatabaseSync } = require("node:sqlite");
    const { openDatabase } = require(${JSON.stringify(require.resolve("../app/db"))});
    const databasePath = ${JSON.stringify(databasePath)};
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(${JSON.stringify(legacySchema)});
    for (let index = 1; index <= 9; index += 1) {
      legacy.prepare("INSERT INTO parking_lots (name, display_order) VALUES (?, ?)")
        .run(\`駐車場 \${index}\`, index - 1);
    }
    legacy.prepare("UPDATE parking_lots SET area_width = 2 WHERE id = 7").run();
    legacy.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run("legacy-admin", "legacy-hash");
    legacy.prepare(\`
      INSERT INTO vehicles
        (plate, vehicle_type, parking_lot_id, position_x, position_y, unwashed, no_fuel,
         needs_repair, board_section, options)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`).run("旧データ", "hybrid", 4, 0.37, 0.62, 1, 0, 1, "駅前店貸出中", '["ETC"]');
    legacy.close();

    const migrated = openDatabase(databasePath);
    const vehicle = migrated.prepare("SELECT * FROM vehicles WHERE plate = ?").get("旧データ");
    assert.equal(vehicle.vehicle_type, "A-2");
    assert.equal(Object.hasOwn(vehicle, "board_section"), false);
    assert.equal(vehicle.parking_lot_id,
      migrated.prepare("SELECT id FROM parking_lots WHERE name = '駅前店貸出中'").get().id);
    assert.deepEqual(
      [vehicle.position_x, vehicle.position_y, vehicle.unwashed, vehicle.needs_repair],
      [0.37, 0.62, 1, 1],
    );
    assert.deepEqual(JSON.parse(vehicle.options), ["ETC"]);
    assert.equal(vehicle.vehicle_model, "");
    assert.deepEqual(
      migrated.prepare("SELECT s.key FROM vehicle_status_assignments a JOIN vehicle_statuses s ON s.id = a.status_id WHERE a.vehicle_id = ? ORDER BY s.key")
        .all(vehicle.id).map((status) => status.key),
      ["needs_repair", "unwashed"],
    );
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM parking_lots").get().count, 13);
    const lot = migrated.prepare("SELECT * FROM parking_lots WHERE id = 4").get();
    assert.deepEqual([lot.display_order, lot.area_height, lot.area_width], [3, 210, 50]);
    assert.equal(lot.navigation_url, "");
    assert.equal(lot.markings, "[]");
    assert.equal(migrated.prepare("PRAGMA table_info(users)").all().find((column) =>
      column.name === "role").dflt_value, "'admin'");
    assert.deepEqual(
      { ...migrated.prepare("SELECT role, tenant_id FROM users WHERE username = 'legacy-admin'").get() },
      { role: "admin", tenant_id: 1 },
    );
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(migrated.prepare("SELECT area_width FROM parking_lots WHERE id = 7").get().area_width, 100);
    migrated.close();

    const reopened = openDatabase(databasePath);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM tenants").get().count, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM parking_lots").get().count, 13);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM vehicles WHERE plate = '旧データ'").get().count, 1);
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    reopened.close();
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", migrationScript], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("translates the interface to Chinese and English without altering Japanese", () => {
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  assert.doesNotMatch(html, /class="eyebrow"/);
  assert.match(html, /class="language-select"/);
  assert.match(html, /\/static\/i18n\.js/);
  const window = { confirm: () => true };
  const context = vm.createContext({
    window,
    document: { readyState: "loading", addEventListener() {} },
    MutationObserver: class { observe() {} },
    Node: {}, NodeFilter: {}, localStorage: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/i18n.js"), "utf8"), context);
  const { translate } = window.gutsI18n;
  assert.equal(translate("ジョブ", "ja"), "ジョブ");
  assert.equal(translate("ジョブ", "en"), "Dispatch");
  assert.equal(translate("点検", "zh"), "点检");
  assert.equal(translate("タスク", "en"), "Tasks");
  assert.equal(translate("車検満了日", "zh"), "车检到期日");
  assert.equal(translate("ステータス別の車両", "en"), "Follow-up");
  assert.equal(translate("車両一覧", "zh"), "车辆一览");
  assert.equal(translate("3 台", "en"), "3 vehicles");
  assert.equal(translate("  ジョブはありません。 ", "zh"), "  没有任务。 ");
  assert.equal(translate("駐車場 1 · H-2", "en"), "Lot 1 · H-2");
  assert.equal(translate("ユーザー固有の名前", "en"), "ユーザー固有の名前");
  assert.match(translate("通信エラー 線はサーバーに保存されていません。", "en"), /not saved/);
});

test("wires catalog search, token blink and labelled job time inputs", () => {
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../static/style.css"), "utf8");
  assert.match(html, /id="catalog-search"/);
  assert.match(html, /<details id="catalog-panel" open>/);
  assert.doesNotMatch(html, /board-search/);
  assert.match(html, /<details id="job-panel">/);
  assert.match(css, /#status-panel,\s*#job-panel,\s*#inspection-panel,\s*#task-panel\s*\{[^}]*background:\s*var\(--surface\)/);
  assert.match(html, /貼り付け用可/);
  assert.match(html, /車番で検索/);
  assert.match(script, /token-blink/);
  assert.match(script, /catalog-search/);
  assert.match(script, /picker\.click\(\)/);
  assert.match(script, /\/api\/tasks/);
  assert.match(script, /\/api\/vehicle-inspections/);
  assert.match(script, /manage-locations-button"\)\.hidden = !canManageLocations/);
  assert.match(script, /add-vehicle-button"\)\.hidden = false/);
  assert.doesNotMatch(script, /board-search/);
  assert.match(css, /@keyframes token-blink/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.vehicle-catalog \{[^}]*order: -1;/);
});

test("manages dispatch jobs: ordering, completion, isolation, validation and midnight purge", async () => {
  const bootstrap = (await agent.get("/api/bootstrap")).body;
  const [, lotB] = bootstrap.parking_lots;
  const vehicle = (await agent.post("/api/vehicles").send({ plate: "1234", vehicle_type: "A-1" })).body;
  const create = (scheduled, extra = {}) => agent.post("/api/jobs").send({
    scheduled_at: scheduled, vehicle_id: vehicle.id, destination_lot_id: lotB.id, ...extra,
  });

  const late = await create("2026/10/13 15:30");
  const early = await create("2026/10/13 09：05");
  assert.equal(late.status, 201);
  assert.equal(early.status, 201);
  assert.equal((await create("not a date")).status, 422);
  assert.equal((await create("2026/02/30 10:00")).status, 422);
  assert.equal((await create("2026/10/13 10:00", { destination_lot_id: 999999 })).status, 422);
  assert.equal((await request(server).post("/api/jobs").send({})).status, 401);
  assert.equal((await create("2026/10/13 10:00").set("Origin", "https://attacker.example")).status, 403);

  let jobs = (await agent.get("/api/bootstrap")).body.jobs;
  assert.deepEqual(jobs.map((job) => job.scheduled_at), ["2026-10-13 09:05", "2026-10-13 15:30"]);

  const done = await agent.patch(`/api/jobs/${early.body.id}`).send({ completed: true });
  assert.equal(done.status, 200);
  jobs = (await agent.get("/api/bootstrap")).body.jobs;
  assert.deepEqual(jobs.map((job) => job.id), [late.body.id, early.body.id]);
  assert.equal((await agent.patch(`/api/jobs/${early.body.id}`).send({ completed: "yes" })).status, 422);

  assert.equal(application.purgeJobs(), 0);
  const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000);
  assert.equal(application.purgeJobs(tomorrow), 1);
  jobs = (await agent.get("/api/bootstrap")).body.jobs;
  assert.deepEqual(jobs.map((job) => job.id), [late.body.id]);

  assert.equal((await agent.delete(`/api/jobs/${late.body.id}`)).status, 204);
  assert.equal((await agent.delete(`/api/jobs/${late.body.id}`)).status, 404);
});

test("manages class colours, lot priority, stores and distances", async () => {
  const boot = (await agent.get("/api/bootstrap")).body;
  assert.equal(boot.vehicle_classes.length, boot.vehicle_types.length);
  assert.match(boot.vehicle_classes[0].color, /^#[0-9a-f]{6}$/i);
  assert.equal((await agent.post("/api/vehicle-classes").send({ name: "Z-1", color: "red" })).status, 422);
  const created = await agent.post("/api/vehicle-classes").send({ name: "Z-1", color: "#112233" });
  assert.equal(created.status, 201);
  assert.equal((await agent.post("/api/vehicle-classes").send({ name: "z-1", color: "#112233" })).status, 409);
  const recolored = await agent.patch(`/api/vehicle-classes/${created.body.id}`).send({ color: "#445566", name: "Z-2" });
  assert.equal(recolored.status, 200);
  const defaults = Object.fromEntries(boot.vehicle_classes.map((vehicleClass) => [
    vehicleClass.name,
    boot.vehicle_models.filter((model) => model.vehicle_type === vehicleClass.name).map((model) => model.name),
  ]));
  assert.deepEqual(defaults["A-1"], ["ミニカ", "アルト", "ミラ"]);
  assert.deepEqual(defaults["A-2"], ["EKワゴン", "ライフ", "MRワゴン"]);
  assert.deepEqual(defaults["D"], ["ステップワゴン", "ノア", "ヴィッシュ"]);
  const addedModel = await agent.post(`/api/vehicle-classes/${created.body.id}/models`)
    .send({ name: "オリジナル車種" });
  assert.equal(addedModel.status, 201);
  assert.equal((await agent.post(`/api/vehicle-classes/${created.body.id}/models`)
    .send({ name: "オリジナル車種" })).status, 409);
  assert.equal((await agent.post(`/api/vehicle-classes/${created.body.id}/models`)
    .send({ name: "   " })).status, 422);
  const lot = boot.parking_lots[0];
  const patched = await agent.patch(`/api/parking-lots/${lot.id}`).send({
    capacity: 5, is_active: false, class_priority: ["Z-2", "A-1"],
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.class_priority, ["Z-2", "A-1"]);
  assert.equal(patched.body.capacity, 5);
  assert.equal(patched.body.is_active, false);
  assert.equal((await agent.patch(`/api/parking-lots/${lot.id}`).send({ class_priority: ["nope"] })).status, 422);
  assert.equal((await agent.patch(`/api/parking-lots/${lot.id}`).send({ capacity: -1 })).status, 422);
  assert.equal((await agent.patch(`/api/parking-lots/${lot.id}`).send({ capacity: null, is_active: true })).status, 200);
  const vehicle = await agent.post("/api/vehicles").send({
    plate: "品川 300 ち 77-77", vehicle_type: "Z-2", vehicle_model: "オリジナル車種",
  });
  assert.equal(vehicle.status, 201);
  assert.equal(vehicle.body.vehicle_model, "オリジナル車種");
  assert.equal((await agent.post("/api/vehicles").send({
    plate: "wrong-model", vehicle_type: "Z-2", vehicle_model: "ミニカ",
  })).status, 422);
  const renamedModel = await agent.patch(`/api/vehicle-models/${addedModel.body.id}`)
    .send({ name: "変更後車種" });
  assert.equal(renamedModel.status, 200);
  assert.equal((await agent.get("/api/bootstrap")).body.vehicles
    .find((item) => item.id === vehicle.body.id).vehicle_model, "変更後車種");
  assert.equal((await agent.patch(`/api/vehicle-models/${addedModel.body.id}`)
    .send({ name: "変更後車種" })).status, 200);
  assert.equal((await agent.patch(`/api/vehicles/${vehicle.body.id}`)
    .send({ vehicle_model: "未登録車種" })).status, 422);
  assert.equal((await agent.delete(`/api/vehicle-models/${addedModel.body.id}`)).status, 204);
  const retainedModel = await agent.patch(`/api/vehicles/${vehicle.body.id}`)
    .send({ vehicle_model: "変更後車種" });
  assert.equal(retainedModel.status, 200);
  assert.equal(retainedModel.body.vehicle_model, "変更後車種");
  assert.equal((await agent.delete(`/api/vehicle-classes/${created.body.id}`)).status, 409);
  await agent.delete(`/api/vehicles/${vehicle.body.id}`);
  assert.equal((await agent.delete(`/api/vehicle-classes/${created.body.id}`)).status, 204);
  const store = (await agent.post("/api/stores").send({ name: "テスト店" })).body;
  const [a, b] = boot.parking_lots;
  assert.equal((await agent.put("/api/store-distances").send({ entries: [{ store_id: store.id, lot_id: a.id, minutes: 7 }] })).status, 200);
  assert.equal((await agent.put("/api/lot-distances").send({ entries: [{ from_lot_id: a.id, to_lot_id: b.id, minutes: 12 }] })).status, 200);
  const after = (await agent.get("/api/bootstrap")).body;
  assert.ok(after.store_lot_distances.some((d) => d.store_id === store.id && d.minutes === 7));
  assert.ok(after.lot_distances.some((d) => d.minutes === 12));
  await agent.put("/api/lot-distances").send({ entries: [{ from_lot_id: a.id, to_lot_id: b.id, minutes: null }] });
  assert.equal((await agent.get("/api/bootstrap")).body.lot_distances.length, 0);
  assert.equal((await agent.delete(`/api/stores/${store.id}`)).status, 204);
});
