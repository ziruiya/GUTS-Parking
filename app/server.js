const http = require("node:http");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const cookie = require("cookie");
const signature = require("cookie-signature");
const { rateLimit } = require("express-rate-limit");
const { WebSocket, WebSocketServer } = require("ws");
const { version } = require("../package.json");

const {
  ASSESSMENT_FIELD_TYPES,
  DEFAULT_STATUSES,
  LOT_NAMES,
  openDatabase,
  seedTenantAssessment,
  seedTenantStatuses,
  seedTenantVehicleClasses,
  seedTenantVehicleOptions,
} = require("./db");
const { SQLiteSessionStore } = require("./session-store");
const { hashPassword, verifyPassword } = require("./security");
const { ErrorLogger } = require("./error-logger");

const STATIC_DIR = path.resolve(__dirname, "..", "static");
const THREE_BUILD_DIR = path.resolve(__dirname, "..", "node_modules", "three", "build");
const STATUSES = DEFAULT_STATUSES.map((status) => status.key);
const POSITION_GRID = Array.from({ length: 32 }, (_, index) => [
  [0.125, 0.375, 0.625, 0.875][index % 4],
  [0.0625, 0.1875, 0.3125, 0.4375, 0.5625, 0.6875, 0.8125, 0.9375][Math.floor(index / 4)],
]);
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$00112233445566778899aabbccddeeff$".concat("00".repeat(64));
const CLIENT_ERROR_TYPES = new Set([
  "browser-error",
  "unhandled-rejection",
  "resource-load-error",
  "network-error",
  "server-response",
  "interaction-error",
]);

function isGoogleMapsUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (["maps.app.goo.gl", "maps.google.com"].includes(url.hostname)) return true;
    if (url.hostname === "goo.gl") return url.pathname.startsWith("/maps");
    return ["google.com", "www.google.com", "www.google.co.jp", "google.co.jp"].includes(url.hostname) &&
      url.pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

function vehicleOptionsAreValid(db, options, tenantId) {
  if (!Array.isArray(options) || options.some((name) =>
    typeof name !== "string" || !name.trim() || name.length > 40) ||
      new Set(options).size !== options.length) return false;
  if (!options.length) return true;
  const placeholders = options.map(() => "?").join(", ");
  return db.prepare(
    `SELECT COUNT(*) AS count FROM vehicle_option_types WHERE tenant_id = ? AND name IN (${placeholders})`,
  ).get(tenantId, ...options).count === options.length;
}

class RealtimeBoard {
  constructor(db, sessionSecret, errorLogger) {
    this.db = db;
    this.sessionSecret = sessionSecret;
    this.errorLogger = errorLogger;
    this.clients = new Set();
    this.webSocketServer = new WebSocketServer({ noServer: true });
  }

  attach(server) {
    server.on("upgrade", (request, socket, head) => {
      this.acceptUpgrade(request, socket, head).catch((error) => {
        this.errorLogger.capture("websocket-upgrade-error", error);
        socket.destroy();
      });
    });
  }

  async acceptUpgrade(request, socket, head) {
    if (request.url?.split("?")[0] !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const forwardedProto = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
    const expectedScheme = forwardedProto || (socket.encrypted ? "https" : "http");
    if (!origin || origin !== `${expectedScheme}://${request.headers.host}`) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    let sessionId;
    try {
      const cookies = cookie.parse(request.headers.cookie || "");
      const signedId = cookies.rentalcar_session;
      if (signedId?.startsWith("s:")) {
        sessionId = signature.unsign(signedId.slice(2), this.sessionSecret);
      }
    } catch {
      sessionId = undefined;
    }
    if (!sessionId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    const row = this.db.prepare("SELECT sess FROM sessions WHERE sid = ?").get(sessionId);
    const username = row ? JSON.parse(row.sess).username : null;
    const user = username && this.db.prepare(`
      SELECT u.tenant_id, t.is_active
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = ?
    `).get(username);
    if (!user || !user.is_active) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocket.tenantId = user.tenant_id;
      websocket.username = username;
      this.clients.add(websocket);
      websocket.on("close", () => this.clients.delete(websocket));
      websocket.on("error", (error) => {
        this.errorLogger.capture("websocket-error", error);
        this.clients.delete(websocket);
      });
      websocket.on("message", () => {
        if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify({ type: "pong" }));
      });
    });
  }

  notify(tenantId) {
    const message = JSON.stringify({ type: "refresh" });
    for (const websocket of this.clients) {
      if (websocket.tenantId === tenantId && websocket.readyState === WebSocket.OPEN) {
        websocket.send(message);
      }
    }
  }

  closeTenant(tenantId, code = 4003, reason = "Store access suspended") {
    for (const websocket of this.clients) {
      if (websocket.tenantId === tenantId) websocket.close(code, reason);
    }
  }

  closeUser(username, code, reason) {
    for (const websocket of this.clients) {
      if (websocket.username === username) websocket.close(code, reason);
    }
  }
}

const LOT_COLUMNS = `id, name, display_order, area_height, area_width, navigation_url, markings,
  capacity, is_active, class_priority`;

function parkingLotFromRow(row) {
  const lot = { ...row, is_active: row.is_active !== 0 };
  try {
    lot.markings = JSON.parse(row.markings || "[]");
  } catch {
    lot.markings = [];
  }
  try {
    const priority = JSON.parse(row.class_priority || "[]");
    lot.class_priority = Array.isArray(priority) ? priority : [];
  } catch {
    lot.class_priority = [];
  }
  return lot;
}

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function parseDistanceValue(value, { max }) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

function validateMarkings(markings) {
  if (!Array.isArray(markings) || markings.length > 100) return false;
  const ids = new Set();
  return markings.every((marking) => {
    if (!marking || typeof marking !== "object" ||
        typeof marking.id !== "string" || !/^[\w-]{1,64}$/.test(marking.id) ||
        ids.has(marking.id) || typeof marking.color !== "string" ||
        !/^#[0-9a-fA-F]{6}$/.test(marking.color)) return false;
    ids.add(marking.id);
    return ["x1", "y1", "x2", "y2"].every((key) =>
      typeof marking[key] === "number" && Number.isFinite(marking[key]) &&
      marking[key] >= 0 && marking[key] <= 1);
  });
}

function vehicleFromRow(row, statusIds = []) {
  const { board_section: _legacyBoardSection, ...vehicle } = row;
  for (const status of STATUSES) vehicle[status] = Boolean(vehicle[status]);
  vehicle.status_ids = statusIds;
  try {
    vehicle.options = JSON.parse(vehicle.options || "[]");
  } catch {
    vehicle.options = [];
  }
  return vehicle;
}

function getVehicleStatusIds(db, vehicleId) {
  return db.prepare(
    "SELECT status_id FROM vehicle_status_assignments WHERE vehicle_id = ? ORDER BY status_id",
  ).all(vehicleId).map((row) => row.status_id);
}

function vehicleResponse(db, row) {
  const vehicle = vehicleFromRow(row, getVehicleStatusIds(db, row.id));
  vehicle.assessment_values = Object.fromEntries(db.prepare(
    "SELECT field_id, value FROM vehicle_assessment_values WHERE vehicle_id = ? ORDER BY field_id",
  ).all(row.id).map((entry) => [entry.field_id, entry.value]));
  vehicle.inspection_marks = db.prepare(`
    SELECT m.id, m.damage_type_id, m.x, m.y, m.world_x, m.world_y, m.world_z,
           m.world_nx, m.world_ny, m.world_nz, t.name, t.icon, t.color, t.built_in_key
    FROM vehicle_damage_marks m
    JOIN vehicle_damage_types t ON t.id = m.damage_type_id
    WHERE m.vehicle_id = ? ORDER BY m.rowid
  `).all(row.id);
  return vehicle;
}

function statusIdsAreValid(db, statusIds, tenantId) {
  if (!Array.isArray(statusIds) || statusIds.some((id) => !Number.isSafeInteger(id)) ||
      new Set(statusIds).size !== statusIds.length) return false;
  if (!statusIds.length) return true;
  const placeholders = statusIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT COUNT(*) AS count FROM vehicle_statuses WHERE tenant_id = ? AND id IN (${placeholders})`,
  ).get(tenantId, ...statusIds).count === statusIds.length;
}

function assessmentValuesAreValid(db, values, tenantId) {
  if (!values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).length > 100) return false;
  for (const [rawId, value] of Object.entries(values)) {
    const fieldId = parseVehicleId(rawId);
    if (fieldId === null) return false;
    const field = db.prepare(
      "SELECT field_type, built_in_key FROM vehicle_assessment_fields WHERE id = ? AND tenant_id = ?",
    ).get(fieldId, tenantId);
    if (!field) return false;
    if (field.field_type === "rating") {
      if (!["1", "2", "3", "4", "5"].includes(String(value))) return false;
    } else if (field.field_type === "checkbox") {
      if (typeof value !== "boolean" && value !== "true" && value !== "false") return false;
    } else if (field.field_type === "number") {
      if (value !== "" && (typeof value !== "number" && typeof value !== "string" ||
          !/^\d{1,12}$/.test(String(value)))) return false;
      if (value !== "" && field.built_in_key === "registration_month" &&
          (Number(value) < 1 || Number(value) > 12)) return false;
      if (value !== "" && field.built_in_key === "registration_year" &&
          (Number(value) < 1900 || Number(value) > new Date().getFullYear())) return false;
    } else if (typeof value !== "string" || value.length > 500) {
      return false;
    }
  }
  return true;
}

function inspectionMarksAreValid(db, marks, tenantId) {
  if (!Array.isArray(marks) || marks.length > 200) return false;
  const ids = new Set();
  return marks.every((mark) => {
    if (!mark || typeof mark !== "object" || Array.isArray(mark) ||
        typeof mark.id !== "string" || !/^[\w-]{1,64}$/.test(mark.id) || ids.has(mark.id) ||
        !Number.isSafeInteger(mark.damage_type_id) ||
        ![mark.x, mark.y].every((coordinate) =>
          typeof coordinate === "number" && Number.isFinite(coordinate) &&
          coordinate >= 0 && coordinate <= 1) ||
        (["world_x", "world_y", "world_z"].some((key) => Object.hasOwn(mark, key)) &&
          !["world_x", "world_y", "world_z"].every((key) =>
            typeof mark[key] === "number" && Number.isFinite(mark[key]) &&
            mark[key] >= -3 && mark[key] <= 3)) ||
        (["world_nx", "world_ny", "world_nz"].some((key) => Object.hasOwn(mark, key)) &&
          !["world_nx", "world_ny", "world_nz"].every((key) =>
            typeof mark[key] === "number" && Number.isFinite(mark[key]) &&
            mark[key] >= -1 && mark[key] <= 1)) ||
        !db.prepare("SELECT 1 FROM vehicle_damage_types WHERE id = ? AND tenant_id = ?")
          .get(mark.damage_type_id, tenantId)) return false;
    ids.add(mark.id);
    return true;
  });
}

function saveInspectionData(db, vehicleId, values, marks) {
  if (values !== undefined) {
    db.prepare("DELETE FROM vehicle_assessment_values WHERE vehicle_id = ?").run(vehicleId);
    const saveValue = db.prepare(
      "INSERT INTO vehicle_assessment_values (vehicle_id, field_id, value) VALUES (?, ?, ?)",
    );
    for (const [fieldId, rawValue] of Object.entries(values)) {
      const value = typeof rawValue === "boolean" ? String(rawValue) : String(rawValue).trim();
      if (value) saveValue.run(vehicleId, Number(fieldId), value);
    }
  }
  if (marks !== undefined) {
    db.prepare("DELETE FROM vehicle_damage_marks WHERE vehicle_id = ?").run(vehicleId);
    const saveMark = db.prepare(`
      INSERT INTO vehicle_damage_marks
        (id, vehicle_id, damage_type_id, x, y, world_x, world_y, world_z, world_nx, world_ny, world_nz)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const mark of marks) {
      saveMark.run(
        mark.id, vehicleId, mark.damage_type_id, mark.x, mark.y,
        mark.world_x ?? null, mark.world_y ?? null, mark.world_z ?? null,
        mark.world_nx ?? null, mark.world_ny ?? null, mark.world_nz ?? null,
      );
    }
  }
}

function defaultErrorLogPath(databasePath) {
  const resolvedDatabasePath = databasePath === ":memory:"
    ? path.resolve("data/rentalcar.db")
    : path.resolve(databasePath);
  return path.join(path.dirname(resolvedDatabasePath), "errors.log");
}

function parseVehicleId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueConstraint(error) {
  return error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.errcode === 2067;
}

// Accepts "2026/10/13 10:30", "2026-10-13T10:30" and full-width colons; returns "YYYY-MM-DD HH:MM".
function normalizeJobTime(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().replace(/：/g, ":").replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[T\s]+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  const pad = (number, size = 2) => String(number).padStart(size, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

function localDay(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Removes completed jobs finished before the current local day (i.e. cleared at midnight).
function purgeCompletedJobs(db, now = new Date(), timeZone = process.env.JOBS_TIMEZONE || "Asia/Tokyo") {
  const today = localDay(now, timeZone);
  const stale = db.prepare("SELECT id, completed_at FROM jobs WHERE completed = 1").all()
    .filter((job) => !job.completed_at || localDay(new Date(job.completed_at), timeZone) < today)
    .map((job) => job.id);
  const remove = db.prepare("DELETE FROM jobs WHERE id = ?");
  for (const id of stale) remove.run(id);
  return stale.length;
}

function getNextPosition(db, lotId) {
  if (lotId === null || lotId === undefined) return { positionX: 0.5, positionY: 0.5 };
  const counts = new Map();
  for (const row of db.prepare(
    "SELECT position_x, position_y FROM vehicles WHERE parking_lot_id = ?",
  ).all(lotId)) {
    const key = `${row.position_x.toFixed(2)},${row.position_y.toFixed(2)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [positionX, positionY] = POSITION_GRID.reduce((best, point) => {
    const key = `${point[0].toFixed(2)},${point[1].toFixed(2)}`;
    const bestKey = `${best[0].toFixed(2)},${best[1].toFixed(2)}`;
    return (counts.get(key) || 0) < (counts.get(bestKey) || 0) ? point : best;
  }, POSITION_GRID[0]);
  return { positionX, positionY };
}

function getDefaultParkingLotId(db, tenantId) {
  return db.prepare(`
    SELECT id FROM parking_lots
    WHERE tenant_id = ?
    ORDER BY display_order, id
    LIMIT 1
  `).get(tenantId)?.id;
}

function createApplication(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || "data/rentalcar.db";
  const errorLogger = options.errorLogger || new ErrorLogger(
    options.errorLogPath || process.env.ERROR_LOG_PATH ||
      defaultErrorLogPath(databasePath),
  );
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
  }
  const cookieSecure = options.cookieSecure ?? process.env.COOKIE_SECURE === "1";
  const erpApiKey = options.erpApiKey ?? process.env.ERP_API_KEY;
  const db = openDatabase(databasePath);
  const headquarters = db.prepare("SELECT id FROM tenants WHERE is_headquarters = 1").get();
  if (!headquarters) throw new Error("Headquarters tenant is missing.");
  const headquartersId = headquarters.id;
  const sessionStore = new SQLiteSessionStore(db);
  const realtime = new RealtimeBoard(db, sessionSecret, errorLogger);
  const app = express();
  const clientErrorLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        styleSrc: ["'self'", "'unsafe-inline'"],
        ...(cookieSecure ? {} : { upgradeInsecureRequests: null }),
      },
    },
  }));
  app.use((request, _response, next) => {
    if (request.url.startsWith("/api/v1/")) request.url = `/api/${request.url.slice(8)}`;
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use(session({
    name: "rentalcar_session",
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "strict",
      maxAge: 12 * 60 * 60 * 1000,
    },
  }));

  app.post("/api/client-errors", clientErrorLimiter, requireSameOrigin, (request, response) => {
    const origin = request.get("origin");
    if (!origin || origin !== `${request.protocol}://${request.get("host")}`) {
      return response.status(403).json({ detail: "Same-origin error reports are required." });
    }
    const body = request.body || {};
    if (!CLIENT_ERROR_TYPES.has(body.type) ||
        typeof body.message !== "string" || !body.message.trim() ||
        body.message.length > 2000 ||
        (body.stack !== undefined && (typeof body.stack !== "string" || body.stack.length > 8000)) ||
        (body.source !== undefined && (typeof body.source !== "string" || body.source.length > 1000)) ||
        (body.path !== undefined && (typeof body.path !== "string" || body.path.length > 300)) ||
        (body.status !== undefined && (!Number.isInteger(body.status) || body.status < 100 || body.status > 599)) ||
        (body.line !== undefined && (!Number.isInteger(body.line) || body.line < 0)) ||
        (body.column !== undefined && (!Number.isInteger(body.column) || body.column < 0))) {
      return response.status(422).json({ detail: "Invalid error report." });
    }
    errorLogger.write({
      type: `client-${body.type}`,
      message: body.message,
      ...(body.stack ? { stack: body.stack } : {}),
      ...(body.source ? { source: body.source } : {}),
      ...(body.path ? { path: body.path } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.line ? { line: body.line } : {}),
      ...(body.column ? { column: body.column } : {}),
    });
    return response.status(202).end();
  });

  function requireUser(request, response, next) {
    if (!request.session.username) return response.status(401).json({ detail: "Please sign in." });
    const user = db.prepare(`
      SELECT u.id, u.role, u.tenant_id, t.is_active, t.is_headquarters, t.name AS tenant_name
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = ?
    `).get(request.session.username);
    if (!user) return response.status(401).json({ detail: "Please sign in." });
    if (!user.is_active) {
      return response.status(403).json({ detail: "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。" });
    }
    request.user = user;
    request.tenantId = user.tenant_id;
    next();
  }

  function removeUserSessions(username) {
    const remove = db.prepare("DELETE FROM sessions WHERE sid = ?");
    for (const row of db.prepare("SELECT sid, sess FROM sessions").all()) {
      if (JSON.parse(row.sess).username === username) remove.run(row.sid);
    }
  }

  function requireAdmin(request, response, next) {
    if (request.user.role !== "admin") {
      return response.status(403).json({ detail: "Administrator permission is required." });
    }
    next();
  }

  function requireHeadquartersAdmin(request, response, next) {
    if (request.user.role !== "admin" || !request.user.is_headquarters) {
      return response.status(403).json({ detail: "Headquarters administrator permission is required." });
    }
    next();
  }

  function requireSameOrigin(request, response, next) {
    const origin = request.get("origin");
    if (origin && origin !== `${request.protocol}://${request.get("host")}`) {
      return response.status(403).json({ detail: "Cross-origin request rejected." });
    }
    next();
  }

  function saveParkingLotMarkings(request, response, next) {
    try {
      const lotId = parseVehicleId(request.params.id);
      const lot = lotId === null ? null : db.prepare(
        "SELECT id FROM parking_lots WHERE id = ? AND tenant_id = ?",
      ).get(lotId, request.tenantId);
      if (!lot) return response.status(404).json({ detail: "Parking lot not found." });
      const body = request.body || {};
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "markings") ||
          !validateMarkings(body.markings)) {
        return response.status(422).json({
          detail: "線は最大100本までで、色と座標を正しく指定してください。",
        });
      }
      db.prepare("UPDATE parking_lots SET markings = ? WHERE id = ? AND tenant_id = ?")
        .run(JSON.stringify(body.markings), lotId, request.tenantId);
      realtime.notify(request.tenantId);
      response.json({ markings: body.markings });
    } catch (error) {
      next(error);
    }
  }

  function validateLot(lotId, tenantId) {
    return lotId === null || lotId === undefined ||
      Boolean(db.prepare("SELECT 1 FROM parking_lots WHERE id = ? AND tenant_id = ?").get(lotId, tenantId));
  }

  function classExists(name, tenantId) {
    return typeof name === "string" &&
      Boolean(db.prepare("SELECT 1 FROM vehicle_classes WHERE tenant_id = ? AND name = ?").get(tenantId, name));
  }

  app.use("/static", express.static(STATIC_DIR));
  app.use("/vendor", express.static(THREE_BUILD_DIR, { maxAge: "1d" }));
  app.use(express.static(STATIC_DIR));
  app.get("/api/me", (request, response) => {
    if (!request.session.username) return response.json({ authenticated: false, version });
    const user = db.prepare(`
      SELECT u.role, u.tenant_id, t.name AS tenant_name, t.is_active, t.is_headquarters
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = ?
    `).get(request.session.username);
    if (!user) return response.json({ authenticated: false, version });
    if (!user.is_active) return response.json({ authenticated: false, suspended: true, version });
    response.json({
      authenticated: true,
      version,
      username: request.session.username,
      can_manage: user.role === "admin",
      can_manage_franchises: user.role === "admin" && Boolean(user.is_headquarters),
      tenant_name: user.tenant_name,
    });
  });

  app.post(
    "/api/login",
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    requireSameOrigin,
    async (request, response, next) => {
      try {
        const { username, password } = request.body || {};
        if (
          typeof username !== "string" || !username.trim() || username.length > 80 ||
          typeof password !== "string" || !password || password.length > 1024
        ) {
          return response.status(422).json({ detail: "Valid username and password are required." });
        }
        const row = db.prepare(`
          SELECT u.password_hash, u.role, u.tenant_id, t.name AS tenant_name,
                 t.is_active, t.is_headquarters
          FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.username = ?
        `).get(username.trim());
        const matches = await verifyPassword(password, row?.password_hash || DUMMY_PASSWORD_HASH);
        if (!row || !matches) {
          return response.status(401).json({ detail: "Username or password is incorrect." });
        }
        if (!row.is_active) {
          return response.status(403).json({ detail: "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。" });
        }
        request.session.regenerate((error) => {
          if (error) return next(error);
          request.session.username = username.trim();
          request.session.tenant_id = row.tenant_id;
          request.session.save((saveError) => {
            if (saveError) return next(saveError);
            response.json({
              username: request.session.username,
              can_manage: row.role === "admin",
              can_manage_franchises: row.role === "admin" && Boolean(row.is_headquarters),
              tenant_name: row.tenant_name,
            });
          });
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/logout", requireUser, requireSameOrigin, (request, response, next) => {
    request.session.destroy((error) => {
      if (error) return next(error);
      response.clearCookie("rentalcar_session", {
        httpOnly: true, secure: cookieSecure, sameSite: "strict",
      });
      response.json({ ok: true });
    });
  });

  app.get("/api/employees", requireUser, requireAdmin, (request, response) => {
    const employees = db.prepare(`
      SELECT id, username, created_at
      FROM users
      WHERE tenant_id = ? AND role = 'operator'
      ORDER BY username COLLATE NOCASE, id
    `).all(request.tenantId);
    response.json({ employees });
  });

  app.post("/api/employees", requireUser, requireAdmin, requireSameOrigin, async (request, response, next) => {
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    if (!username || username.length > 80) {
      return response.status(422).json({ detail: "ユーザー名は1〜80文字で入力してください。" });
    }
    const password = randomBytes(18).toString("base64url");
    try {
      const passwordHash = await hashPassword(password);
      const result = db.prepare(`
        INSERT INTO users (username, password_hash, role, tenant_id)
        VALUES (?, ?, 'operator', ?)
      `).run(username, passwordHash, request.tenantId);
      response.set("Cache-Control", "no-store");
      response.status(201).json({
        employee: db.prepare("SELECT id, username, created_at FROM users WHERE id = ?")
          .get(result.lastInsertRowid),
        password,
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "同じユーザー名のアカウントが既にあります。" });
      }
      next(error);
    }
  });

  app.patch(
    "/api/employees/:id/password",
    requireUser,
    requireAdmin,
    requireSameOrigin,
    async (request, response, next) => {
      const employeeId = parseVehicleId(request.params.id);
      const employee = employeeId === null ? null : db.prepare(`
        SELECT id, username FROM users
        WHERE id = ? AND tenant_id = ? AND role = 'operator'
      `).get(employeeId, request.tenantId);
      if (!employee) return response.status(404).json({ detail: "従業員アカウントが見つかりません。" });
      const password = randomBytes(18).toString("base64url");
      try {
        const passwordHash = await hashPassword(password);
        db.exec("BEGIN IMMEDIATE");
        try {
          const updated = db.prepare(`
            UPDATE users SET password_hash = ?
            WHERE id = ? AND tenant_id = ? AND role = 'operator'
          `).run(passwordHash, employee.id, request.tenantId);
          if (!updated.changes) {
            db.exec("ROLLBACK");
            return response.status(404).json({ detail: "従業員アカウントが見つかりません。" });
          }
          removeUserSessions(employee.username);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        realtime.closeUser(employee.username, 4005, "Password reset");
        response.set("Cache-Control", "no-store");
        response.json({ employee: { id: employee.id, username: employee.username }, password });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/employees/:id",
    requireUser,
    requireAdmin,
    requireSameOrigin,
    (request, response, next) => {
      const employeeId = parseVehicleId(request.params.id);
      const employee = employeeId === null ? null : db.prepare(`
        SELECT id, username FROM users
        WHERE id = ? AND tenant_id = ? AND role = 'operator'
      `).get(employeeId, request.tenantId);
      if (!employee) return response.status(404).json({ detail: "従業員アカウントが見つかりません。" });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          removeUserSessions(employee.username);
          db.prepare("DELETE FROM users WHERE id = ?").run(employee.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        realtime.closeUser(employee.username, 4006, "Account deleted");
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/export/mariadb", requireUser, requireAdmin, (request, response) => {
    const tenantId = request.tenantId;
    const vehicles = db.prepare("SELECT * FROM vehicles WHERE tenant_id = ? ORDER BY id").all(tenantId);
    const exportData = {
      format: "guts-parking-mariadb-export",
      format_version: 1,
      target_database: "MariaDB 10.11.10",
      exported_at: new Date().toISOString(),
      tenant: db.prepare(`
        SELECT id, name, is_headquarters FROM tenants WHERE id = ?
      `).get(tenantId),
      tables: {
        parking_lots: db.prepare("SELECT * FROM parking_lots WHERE tenant_id = ? ORDER BY id").all(tenantId),
        vehicles,
        vehicle_statuses: db.prepare("SELECT * FROM vehicle_statuses WHERE tenant_id = ? ORDER BY id").all(tenantId),
        vehicle_status_assignments: db.prepare(`
          SELECT a.vehicle_id, a.status_id FROM vehicle_status_assignments a
          JOIN vehicles v ON v.id = a.vehicle_id
          WHERE v.tenant_id = ? ORDER BY a.vehicle_id, a.status_id
        `).all(tenantId),
        vehicle_assessment_fields: db.prepare(
          "SELECT * FROM vehicle_assessment_fields WHERE tenant_id = ? ORDER BY id",
        ).all(tenantId),
        vehicle_assessment_values: db.prepare(`
          SELECT a.vehicle_id, a.field_id, a.value FROM vehicle_assessment_values a
          JOIN vehicles v ON v.id = a.vehicle_id
          WHERE v.tenant_id = ? ORDER BY a.vehicle_id, a.field_id
        `).all(tenantId),
        vehicle_damage_types: db.prepare(
          "SELECT * FROM vehicle_damage_types WHERE tenant_id = ? ORDER BY id",
        ).all(tenantId),
        vehicle_damage_marks: db.prepare(`
          SELECT m.* FROM vehicle_damage_marks m
          JOIN vehicles v ON v.id = m.vehicle_id
          WHERE v.tenant_id = ? ORDER BY m.vehicle_id, m.id
        `).all(tenantId),
        vehicle_option_types: db.prepare(
          "SELECT * FROM vehicle_option_types WHERE tenant_id = ? ORDER BY id",
        ).all(tenantId),
        vehicle_option_suppressions: db.prepare(
          "SELECT * FROM vehicle_option_suppressions WHERE tenant_id = ? ORDER BY built_in_key",
        ).all(tenantId),
        jobs: db.prepare("SELECT * FROM jobs WHERE tenant_id = ? ORDER BY id").all(tenantId),
        vehicle_classes: db.prepare("SELECT * FROM vehicle_classes WHERE tenant_id = ? ORDER BY id").all(tenantId),
        stores: db.prepare("SELECT * FROM stores WHERE tenant_id = ? ORDER BY id").all(tenantId),
        lot_distances: db.prepare("SELECT * FROM lot_distances WHERE tenant_id = ? ORDER BY from_lot_id, to_lot_id")
          .all(tenantId),
        store_lot_distances: db.prepare(
          "SELECT * FROM store_lot_distances WHERE tenant_id = ? ORDER BY store_id, lot_id",
        ).all(tenantId),
      },
    };
    const date = exportData.exported_at.slice(0, 10);
    response.set("Cache-Control", "no-store");
    response.attachment(`guts-parking-mariadb-${tenantId}-${date}.json`);
    response.type("application/json; charset=utf-8").send(JSON.stringify(exportData, null, 2));
  });

  app.get("/api/bootstrap", requireUser, (request, response) => {
    const parkingLots = db.prepare(
      `SELECT ${LOT_COLUMNS} FROM parking_lots WHERE tenant_id = ? ORDER BY display_order, id`,
    ).all(request.tenantId).map(parkingLotFromRow);
    const vehicleRows = db.prepare(`
      SELECT id, external_id, plate, vehicle_type, parking_lot_id,
             position_x, position_y, unwashed, no_fuel, needs_repair, options, notes
      FROM vehicles WHERE tenant_id = ? ORDER BY plate, id
    `).all(request.tenantId);
    const statusAssignments = new Map();
    for (const assignment of db.prepare(`
      SELECT a.vehicle_id, a.status_id
      FROM vehicle_status_assignments a
      JOIN vehicles v ON v.id = a.vehicle_id
      WHERE v.tenant_id = ?
      ORDER BY a.status_id
    `).all(request.tenantId)) {
      if (!statusAssignments.has(assignment.vehicle_id)) {
        statusAssignments.set(assignment.vehicle_id, []);
      }
      statusAssignments.get(assignment.vehicle_id).push(assignment.status_id);
    }
    const vehicles = vehicleRows.map((row) =>
      vehicleFromRow(row, statusAssignments.get(row.id) || []));
    const statuses = db.prepare(
      "SELECT id, name, icon, key FROM vehicle_statuses WHERE tenant_id = ? ORDER BY id",
    ).all(request.tenantId);
    const inspectionValues = new Map();
    for (const entry of db.prepare(`
      SELECT a.vehicle_id, a.field_id, a.value
      FROM vehicle_assessment_values a
      JOIN vehicles v ON v.id = a.vehicle_id
      WHERE v.tenant_id = ? ORDER BY a.vehicle_id, a.field_id
    `).all(request.tenantId)) {
      if (!inspectionValues.has(entry.vehicle_id)) inspectionValues.set(entry.vehicle_id, {});
      inspectionValues.get(entry.vehicle_id)[entry.field_id] = entry.value;
    }
    const inspectionMarks = new Map();
    for (const mark of db.prepare(`
      SELECT m.id, m.vehicle_id, m.damage_type_id, m.x, m.y,
             m.world_x, m.world_y, m.world_z, m.world_nx, m.world_ny, m.world_nz,
             t.name, t.icon, t.color, t.built_in_key
      FROM vehicle_damage_marks m
      JOIN vehicles v ON v.id = m.vehicle_id
      JOIN vehicle_damage_types t ON t.id = m.damage_type_id
      WHERE v.tenant_id = ? ORDER BY m.rowid
    `).all(request.tenantId)) {
      if (!inspectionMarks.has(mark.vehicle_id)) inspectionMarks.set(mark.vehicle_id, []);
      const { vehicle_id: _vehicleId, ...vehicleMark } = mark;
      inspectionMarks.get(mark.vehicle_id).push(vehicleMark);
    }
    for (const vehicle of vehicles) {
      vehicle.assessment_values = inspectionValues.get(vehicle.id) || {};
      vehicle.inspection_marks = inspectionMarks.get(vehicle.id) || [];
    }
    const assessmentFields = db.prepare(`
      SELECT id, built_in_key, group_key, name, field_type, suffix, display_order
      FROM vehicle_assessment_fields WHERE tenant_id = ?
      ORDER BY CASE group_key WHEN 'body' THEN 0 WHEN 'electrical' THEN 1 WHEN 'basic' THEN 2 ELSE 3 END,
               display_order, id
    `).all(request.tenantId);
    const damageTypes = db.prepare(`
      SELECT id, built_in_key, name, icon, color
      FROM vehicle_damage_types WHERE tenant_id = ? ORDER BY id
    `).all(request.tenantId);
    const vehicleOptions = db.prepare(
      "SELECT id, name FROM vehicle_option_types WHERE tenant_id = ? ORDER BY id",
    ).all(request.tenantId);
    const jobs = db.prepare(`
      SELECT id, vehicle_id, destination_lot_id, scheduled_at, completed
      FROM jobs WHERE tenant_id = ?
      ORDER BY completed, scheduled_at, id
    `).all(request.tenantId);
    const vehicleClasses = db.prepare(
      "SELECT id, name, color, display_order FROM vehicle_classes WHERE tenant_id = ? ORDER BY display_order, id",
    ).all(request.tenantId);
    const stores = db.prepare("SELECT id, name FROM stores WHERE tenant_id = ? ORDER BY id").all(request.tenantId);
    const lotDistances = db.prepare(
      "SELECT from_lot_id, to_lot_id, minutes, km FROM lot_distances WHERE tenant_id = ? ORDER BY from_lot_id, to_lot_id",
    ).all(request.tenantId);
    const storeLotDistances = db.prepare(
      "SELECT store_id, lot_id, minutes, km FROM store_lot_distances WHERE tenant_id = ? ORDER BY store_id, lot_id",
    ).all(request.tenantId);
    response.json({
      parking_lots: parkingLots,
      vehicles,
      jobs,
      statuses,
      assessment_fields: assessmentFields,
      damage_types: damageTypes,
      vehicle_types: vehicleClasses.map((item) => item.name),
      vehicle_classes: vehicleClasses,
      stores,
      lot_distances: lotDistances,
      store_lot_distances: storeLotDistances,
      vehicle_options: vehicleOptions,
    });
  });

  function parseClassBody(body, { partial }) {
    const name = typeof body?.name === "string" ? body.name.trim() : body?.name;
    if (name !== undefined || !partial) {
      if (typeof name !== "string" || !name || name.length > 40) {
        return { error: "クラス名は1〜40文字で入力してください。" };
      }
    }
    if (body?.color !== undefined || !partial) {
      if (!isHexColor(body?.color)) return { error: "色は #RRGGBB 形式で指定してください。" };
    }
    return { name, color: body?.color };
  }

  app.post("/api/vehicle-classes", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const parsed = parseClassBody(request.body, { partial: false });
    if (parsed.error) return response.status(422).json({ detail: parsed.error });
    try {
      const result = db.prepare(`
        INSERT INTO vehicle_classes (tenant_id, name, color, display_order)
        VALUES (?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM vehicle_classes WHERE tenant_id = ?))
      `).run(request.tenantId, parsed.name, parsed.color, request.tenantId);
      realtime.notify(request.tenantId);
      response.status(201).json(db.prepare(
        "SELECT id, name, color, display_order FROM vehicle_classes WHERE id = ?",
      ).get(result.lastInsertRowid));
    } catch (error) {
      if (isUniqueConstraint(error)) return response.status(409).json({ detail: "同じ名前のクラスが既にあります。" });
      next(error);
    }
  });

  app.patch("/api/vehicle-classes/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const classId = parseVehicleId(request.params.id);
    const current = classId === null ? null : db.prepare(
      "SELECT id, name, color FROM vehicle_classes WHERE id = ? AND tenant_id = ?",
    ).get(classId, request.tenantId);
    if (!current) return response.status(404).json({ detail: "Vehicle class not found." });
    const parsed = parseClassBody(request.body, { partial: true });
    if (parsed.error) return response.status(422).json({ detail: parsed.error });
    const name = parsed.name ?? current.name;
    const color = parsed.color ?? current.color;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE vehicle_classes SET name = ?, color = ? WHERE id = ?").run(name, color, classId);
        if (name !== current.name) {
          db.prepare("UPDATE vehicles SET vehicle_type = ? WHERE tenant_id = ? AND vehicle_type = ?")
            .run(name, request.tenantId, current.name);
          const lots = db.prepare("SELECT id, class_priority FROM parking_lots WHERE tenant_id = ?")
            .all(request.tenantId);
          for (const lot of lots) {
            const priority = parkingLotFromRow({ ...lot, markings: "[]" }).class_priority;
            if (priority.includes(current.name)) {
              db.prepare("UPDATE parking_lots SET class_priority = ? WHERE id = ?")
                .run(JSON.stringify(priority.map((item) => (item === current.name ? name : item))), lot.id);
            }
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.json({ id: classId, name, color });
    } catch (error) {
      if (isUniqueConstraint(error)) return response.status(409).json({ detail: "同じ名前のクラスが既にあります。" });
      next(error);
    }
  });

  app.delete("/api/vehicle-classes/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const classId = parseVehicleId(request.params.id);
    const current = classId === null ? null : db.prepare(
      "SELECT id, name FROM vehicle_classes WHERE id = ? AND tenant_id = ?",
    ).get(classId, request.tenantId);
    if (!current) return response.status(404).json({ detail: "Vehicle class not found." });
    try {
      if (db.prepare("SELECT 1 FROM vehicles WHERE tenant_id = ? AND vehicle_type = ? LIMIT 1")
        .get(request.tenantId, current.name)) {
        return response.status(409).json({ detail: "このクラスの車両が登録されているため削除できません。" });
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM vehicle_classes WHERE id = ?").run(classId);
        for (const lot of db.prepare("SELECT id, class_priority FROM parking_lots WHERE tenant_id = ?")
          .all(request.tenantId)) {
          const priority = parkingLotFromRow({ ...lot, markings: "[]" }).class_priority;
          if (priority.includes(current.name)) {
            db.prepare("UPDATE parking_lots SET class_priority = ? WHERE id = ?")
              .run(JSON.stringify(priority.filter((item) => item !== current.name)), lot.id);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/stores", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name || name.length > 40) {
      return response.status(422).json({ detail: "店舗名は1〜40文字で入力してください。" });
    }
    try {
      const result = db.prepare("INSERT INTO stores (tenant_id, name) VALUES (?, ?)")
        .run(request.tenantId, name);
      realtime.notify(request.tenantId);
      response.status(201).json({ id: Number(result.lastInsertRowid), name });
    } catch (error) {
      if (isUniqueConstraint(error)) return response.status(409).json({ detail: "同じ名前の店舗が既にあります。" });
      next(error);
    }
  });

  app.delete("/api/stores/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const storeId = parseVehicleId(request.params.id);
    try {
      const result = storeId === null ? { changes: 0 } :
        db.prepare("DELETE FROM stores WHERE id = ? AND tenant_id = ?").run(storeId, request.tenantId);
      if (!result.changes) return response.status(404).json({ detail: "Store not found." });
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  function parseDistanceEntries(entries, fields) {
    if (!Array.isArray(entries) || entries.length > 2000) return null;
    const parsed = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return null;
      const ids = fields.map((field) => entry[field]);
      if (ids.some((id) => !Number.isInteger(id))) return null;
      const minutes = parseDistanceValue(entry.minutes, { max: 100000 });
      const km = parseDistanceValue(entry.km, { max: 100000 });
      if (minutes === undefined || km === undefined) return null;
      parsed.push({ ids, minutes, km });
    }
    return parsed;
  }

  app.put("/api/lot-distances", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const entries = parseDistanceEntries(request.body?.entries, ["from_lot_id", "to_lot_id"]);
    if (!entries) return response.status(422).json({ detail: "距離データの形式が正しくありません。" });
    if (entries.some(({ ids }) => ids[0] === ids[1] ||
        !validateLot(ids[0], request.tenantId) || !validateLot(ids[1], request.tenantId))) {
      return response.status(422).json({ detail: "停車場の指定が正しくありません。" });
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { ids, minutes, km } of entries) {
          if (minutes === null) {
            db.prepare("DELETE FROM lot_distances WHERE from_lot_id = ? AND to_lot_id = ?").run(ids[0], ids[1]);
          } else {
            db.prepare(`
              INSERT INTO lot_distances (tenant_id, from_lot_id, to_lot_id, minutes, km) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(from_lot_id, to_lot_id) DO UPDATE SET minutes = excluded.minutes, km = excluded.km
            `).run(request.tenantId, ids[0], ids[1], minutes, km);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.json({ updated: entries.length });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/store-distances", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const entries = parseDistanceEntries(request.body?.entries, ["store_id", "lot_id"]);
    if (!entries) return response.status(422).json({ detail: "距離データの形式が正しくありません。" });
    const storeExists = db.prepare("SELECT 1 FROM stores WHERE id = ? AND tenant_id = ?");
    if (entries.some(({ ids }) => !storeExists.get(ids[0], request.tenantId) ||
        !validateLot(ids[1], request.tenantId))) {
      return response.status(422).json({ detail: "店舗または停車場の指定が正しくありません。" });
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { ids, minutes, km } of entries) {
          if (minutes === null) {
            db.prepare("DELETE FROM store_lot_distances WHERE store_id = ? AND lot_id = ?").run(ids[0], ids[1]);
          } else {
            db.prepare(`
              INSERT INTO store_lot_distances (tenant_id, store_id, lot_id, minutes, km) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(store_id, lot_id) DO UPDATE SET minutes = excluded.minutes, km = excluded.km
            `).run(request.tenantId, ids[0], ids[1], minutes, km);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.json({ updated: entries.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/franchises", requireUser, requireHeadquartersAdmin, (_request, response) => {
    const stores = db.prepare(`
      SELECT t.id, t.name, t.is_active, t.created_at,
             group_concat(u.username, '、') AS admin_usernames
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'admin'
      WHERE t.is_headquarters = 0
      GROUP BY t.id
      ORDER BY t.created_at, t.id
    `).all().map((store) => ({
      ...store,
      is_active: Boolean(store.is_active),
      admin_usernames: store.admin_usernames || "",
    }));
    response.json({ franchises: stores });
  });

  app.post("/api/franchises", requireUser, requireHeadquartersAdmin, requireSameOrigin, async (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = request.body?.password;
    if (!name || name.length > 80 || !username || username.length > 80 ||
        typeof password !== "string" || password.length < 12 || password.length > 1024) {
      return response.status(422).json({
        detail: "店舗名・アカウント名は1〜80文字、パスワードは12〜1024文字で入力してください。",
      });
    }
    if (db.prepare("SELECT 1 FROM tenants WHERE name = ? COLLATE NOCASE").get(name) ||
        db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      return response.status(409).json({ detail: "店舗名またはアカウント名は既に使用されています。" });
    }
    try {
      const passwordHash = await hashPassword(password);
      db.exec("BEGIN IMMEDIATE");
      let tenantId;
      try {
        const tenantResult = db.prepare(
          "INSERT INTO tenants (name, is_headquarters, is_active) VALUES (?, 0, 1)",
        ).run(name);
        tenantId = Number(tenantResult.lastInsertRowid);
        seedTenantStatuses(db, tenantId);
        seedTenantAssessment(db, tenantId);
        seedTenantVehicleOptions(db, tenantId);
        seedTenantVehicleClasses(db, tenantId);
        db.prepare(`
          INSERT INTO users (username, password_hash, role, tenant_id)
          VALUES (?, ?, 'admin', ?)
        `).run(username, passwordHash, tenantId);
        const addLot = db.prepare(`
          INSERT INTO parking_lots (tenant_id, name, display_order, area_height, area_width)
          VALUES (?, ?, ?, 210, 50)
        `);
        LOT_NAMES.forEach((lotName, index) => addLot.run(tenantId, lotName, index));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.status(201).json({
        franchise: { id: tenantId, name, is_active: true, admin_usernames: username },
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "店舗名またはアカウント名は既に使用されています。" });
      }
      next(error);
    }
  });

  app.patch(
    "/api/franchises/:id/status",
    requireUser,
    requireHeadquartersAdmin,
    requireSameOrigin,
    (request, response, next) => {
      const tenantId = parseVehicleId(request.params.id);
      if (tenantId === null || typeof request.body?.is_active !== "boolean") {
        return response.status(422).json({ detail: "有効・停止の状態を指定してください。" });
      }
      const store = db.prepare(`
        SELECT id, name, is_active FROM tenants
        WHERE id = ? AND is_headquarters = 0
      `).get(tenantId);
      if (!store) return response.status(404).json({ detail: "加盟店が見つかりません。" });
      try {
        db.prepare("UPDATE tenants SET is_active = ? WHERE id = ?")
          .run(Number(request.body.is_active), tenantId);
        if (request.body.is_active) realtime.notify(tenantId);
        else realtime.closeTenant(tenantId);
        realtime.notify(request.tenantId);
        response.json({ ...store, is_active: request.body.is_active });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete("/api/franchises/:id", requireUser, requireHeadquartersAdmin, requireSameOrigin, (request, response, next) => {
    const tenantId = parseVehicleId(request.params.id);
    const confirmationName = typeof request.body?.confirmation_name === "string"
      ? request.body.confirmation_name.trim()
      : "";
    const store = tenantId === null ? null : db.prepare(
      "SELECT id, name FROM tenants WHERE id = ? AND is_headquarters = 0",
    ).get(tenantId);
    if (!store) return response.status(404).json({ detail: "加盟店が見つかりません。" });
    if (confirmationName !== store.name) {
      return response.status(422).json({ detail: "削除するには加盟店名を正確に入力してください。" });
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const usernames = new Set(db.prepare("SELECT username FROM users WHERE tenant_id = ?").all(tenantId)
          .map((user) => user.username));
        const sessions = db.prepare("SELECT sid, sess FROM sessions").all();
        const deleteSession = db.prepare("DELETE FROM sessions WHERE sid = ?");
        for (const session of sessions) {
          let username;
          try {
            username = JSON.parse(session.sess).username;
          } catch {
            continue;
          }
          if (usernames.has(username)) deleteSession.run(session.sid);
        }
        db.prepare("DELETE FROM vehicles WHERE tenant_id = ?").run(tenantId);
        db.prepare("DELETE FROM parking_lots WHERE tenant_id = ?").run(tenantId);
        db.prepare("DELETE FROM users WHERE tenant_id = ?").run(tenantId);
        db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.closeTenant(tenantId, 4004, "Store deleted");
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/parking-lots", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const rawNavigationUrl = request.body?.navigation_url ?? "";
    const navigationUrl = typeof rawNavigationUrl === "string" ? rawNavigationUrl.trim() : rawNavigationUrl;
    if (!name || name.length > 40) {
      return response.status(422).json({ detail: "Parking location name must be between 1 and 40 characters." });
    }
    if (navigationUrl !== "" && !isGoogleMapsUrl(navigationUrl)) {
      return response.status(422).json({ detail: "Navigation link must be a valid HTTPS Google Maps URL." });
    }
    if (db.prepare("SELECT 1 FROM parking_lots WHERE tenant_id = ? AND name = ? COLLATE NOCASE")
      .get(request.tenantId, name)) {
      return response.status(409).json({ detail: "A parking location with that name already exists." });
    }
    try {
      const result = db.prepare(`
        INSERT INTO parking_lots (tenant_id, name, display_order, area_height, area_width, navigation_url)
        VALUES (?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM parking_lots WHERE tenant_id = ?), 210, 50, ?)
      `).run(request.tenantId, name, request.tenantId, navigationUrl);
      realtime.notify(request.tenantId);
      response.status(201).json(parkingLotFromRow(db.prepare(
        `SELECT ${LOT_COLUMNS} FROM parking_lots WHERE id = ? AND tenant_id = ?`,
      ).get(result.lastInsertRowid, request.tenantId)));
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "A parking location with that name already exists." });
      }
      next(error);
    }
  });

  app.patch("/api/parking-lots/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    try {
      const lotId = parseVehicleId(request.params.id);
      const lot = lotId === null ? null : db.prepare(
        "SELECT * FROM parking_lots WHERE id = ? AND tenant_id = ?",
      ).get(lotId, request.tenantId);
      if (!lot) return response.status(404).json({ detail: "Parking lot not found." });
      const body = request.body || {};
      const entries = Object.entries(body);
      if (!entries.length || entries.some(([key]) =>
        !["name", "navigation_url", "area_height", "area_width", "markings",
          "capacity", "is_active", "class_priority"].includes(key))) {
        return response.status(422).json({ detail: "Unsupported parking location field." });
      }
      const {
        name: rawName,
        navigation_url: rawNavigationUrl,
        area_height: height,
        area_width: width,
        markings,
        capacity,
        is_active: isActive,
        class_priority: classPriority,
      } = body;
      if (capacity !== undefined && capacity !== null &&
          (!Number.isInteger(capacity) || capacity < 0 || capacity > 1000)) {
        return response.status(422).json({ detail: "収容台数は0〜1000の整数で指定してください。" });
      }
      if (isActive !== undefined && typeof isActive !== "boolean") {
        return response.status(422).json({ detail: "is_active must be true or false." });
      }
      if (classPriority !== undefined &&
          (!Array.isArray(classPriority) || classPriority.length > 100 ||
           new Set(classPriority).size !== classPriority.length ||
           classPriority.some((name) => !classExists(name, request.tenantId)))) {
        return response.status(422).json({ detail: "優先クラスは登録済みのクラスを重複なく指定してください。" });
      }
      const name = typeof rawName === "string" ? rawName.trim() : rawName;
      const navigationUrl = typeof rawNavigationUrl === "string" ? rawNavigationUrl.trim() : rawNavigationUrl;
      if (rawName !== undefined && (typeof name !== "string" || !name || name.length > 40)) {
        return response.status(422).json({ detail: "Parking location name must be between 1 and 40 characters." });
      }
      if (name !== undefined &&
          db.prepare("SELECT 1 FROM parking_lots WHERE tenant_id = ? AND name = ? COLLATE NOCASE AND id != ?")
            .get(request.tenantId, name, lotId)) {
        return response.status(409).json({ detail: "A parking location with that name already exists." });
      }
      if (navigationUrl !== undefined && navigationUrl !== "" && !isGoogleMapsUrl(navigationUrl)) {
        return response.status(422).json({ detail: "Navigation link must be a valid HTTPS Google Maps URL." });
      }
      if (height !== undefined && (!Number.isInteger(height) || height < 160 || height > 600)) {
        return response.status(422).json({ detail: "Parking area height must be between 160 and 600 pixels." });
      }
      if (width !== undefined && (!Number.isInteger(width) || width < 30 || width > 100)) {
        return response.status(422).json({ detail: "Parking area width must be between 30 and 100 percent." });
      }
      if (markings !== undefined && !validateMarkings(markings)) {
        return response.status(422).json({ detail: "線は最大100本までで、色と座標を正しく指定してください。" });
      }
      const values = Object.fromEntries(entries);
      if (name !== undefined) values.name = name;
      if (navigationUrl !== undefined) values.navigation_url = navigationUrl;
      if (markings !== undefined) values.markings = JSON.stringify(markings);
      if (isActive !== undefined) values.is_active = isActive ? 1 : 0;
      if (classPriority !== undefined) values.class_priority = JSON.stringify(classPriority);
      const assignments = Object.keys(values).map((key) => `${key} = ?`).join(", ");
      db.prepare(`UPDATE parking_lots SET ${assignments} WHERE id = ? AND tenant_id = ?`)
        .run(...Object.values(values), lotId, request.tenantId);
      realtime.notify(request.tenantId);
      response.json(parkingLotFromRow(db.prepare(
        `SELECT ${LOT_COLUMNS} FROM parking_lots WHERE id = ? AND tenant_id = ?`,
      ).get(lotId, request.tenantId)));
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "A parking location with that name already exists." });
      }
      next(error);
    }
  });

  app.post(
    "/api/parking-lots/:id/markings",
    requireUser,
    requireAdmin,
    requireSameOrigin,
    saveParkingLotMarkings,
  );

  app.delete("/api/parking-lots/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const lotId = parseVehicleId(request.params.id);
    if (lotId === null) return response.status(404).json({ detail: "Parking location not found." });
    try {
      const lot = db.prepare("SELECT id FROM parking_lots WHERE id = ? AND tenant_id = ?")
        .get(lotId, request.tenantId);
      if (!lot) return response.status(404).json({ detail: "Parking location not found." });
      if (db.prepare("SELECT COUNT(*) AS count FROM parking_lots WHERE tenant_id = ?")
        .get(request.tenantId).count <= 1) {
        return response.status(409).json({ detail: "最後の位置は削除できません。" });
      }
      if (db.prepare("SELECT 1 FROM vehicles WHERE tenant_id = ? AND parking_lot_id = ? LIMIT 1")
        .get(request.tenantId, lotId)) {
        return response.status(409).json({ detail: "車両が配置されている位置は削除できません。先に車両を別の位置へ移動してください。" });
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM parking_lots WHERE id = ? AND tenant_id = ?").run(lotId, request.tenantId);
        const remaining = db.prepare(
          "SELECT id FROM parking_lots WHERE tenant_id = ? ORDER BY display_order, id",
        ).all(request.tenantId);
        const setOrder = db.prepare("UPDATE parking_lots SET display_order = ? WHERE id = ? AND tenant_id = ?");
        remaining.forEach((row, index) => setOrder.run(index, row.id, request.tenantId));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/parking-lots/order", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const { ids } = request.body || {};
    const actualIds = db.prepare("SELECT id FROM parking_lots WHERE tenant_id = ?")
      .all(request.tenantId).map((lot) => lot.id).sort((a, b) => a - b);
    if (!Array.isArray(ids) || ids.length !== actualIds.length ||
        ids.some((id) => !Number.isInteger(id)) ||
        [...ids].sort((a, b) => a - b).some((id, index) => id !== actualIds[index])) {
      return response.status(422).json({ detail: "Order must contain every parking lot exactly once." });
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      const updateOrder = db.prepare(
        "UPDATE parking_lots SET display_order = ? WHERE id = ? AND tenant_id = ?",
      );
      ids.forEach((id, index) => updateOrder.run(index, id, request.tenantId));
      db.exec("COMMIT");
      realtime.notify(request.tenantId);
      response.json({ ids });
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      next(error);
    }
  });

  app.post("/api/vehicle-options", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name || name.length > 40) {
      return response.status(422).json({ detail: "オプション名は1〜40文字で入力してください。" });
    }
    try {
      const result = db.prepare(
        "INSERT INTO vehicle_option_types (tenant_id, name) VALUES (?, ?)",
      ).run(request.tenantId, name);
      realtime.notify(request.tenantId);
      response.status(201).json(db.prepare(
        "SELECT id, name FROM vehicle_option_types WHERE id = ? AND tenant_id = ?",
      ).get(result.lastInsertRowid, request.tenantId));
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "同じ名前のオプションは既に登録されています。" });
      }
      next(error);
    }
  });

  app.delete("/api/vehicle-options/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const optionId = parseVehicleId(request.params.id);
    if (optionId === null) return response.status(404).json({ detail: "オプションが見つかりません。" });
    const option = db.prepare(
      "SELECT id, name, built_in_key FROM vehicle_option_types WHERE id = ? AND tenant_id = ?",
    ).get(optionId, request.tenantId);
    if (!option) return response.status(404).json({ detail: "オプションが見つかりません。" });
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const vehicles = db.prepare("SELECT id, options FROM vehicles WHERE tenant_id = ?")
          .all(request.tenantId);
        const updateVehicleOptions = db.prepare("UPDATE vehicles SET options = ? WHERE id = ?");
        for (const vehicle of vehicles) {
          const savedOptions = JSON.parse(vehicle.options || "[]");
          const nextOptions = savedOptions.filter((name) => name !== option.name);
          if (nextOptions.length !== savedOptions.length) {
            updateVehicleOptions.run(JSON.stringify(nextOptions), vehicle.id);
          }
        }
        if (option.built_in_key) {
          db.prepare(`
            INSERT OR IGNORE INTO vehicle_option_suppressions (tenant_id, built_in_key)
            VALUES (?, ?)
          `).run(request.tenantId, option.built_in_key);
        }
        db.prepare("DELETE FROM vehicle_option_types WHERE id = ? AND tenant_id = ?")
          .run(optionId, request.tenantId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/assessment-fields", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const type = request.body?.field_type;
    const suffix = typeof request.body?.suffix === "string" ? request.body.suffix.trim() : "";
    if (!name || name.length > 60 || !ASSESSMENT_FIELD_TYPES.includes(type) || suffix.length > 16) {
      return response.status(422).json({ detail: "項目名・入力形式・単位を正しく指定してください。" });
    }
    try {
      const result = db.prepare(`
        INSERT INTO vehicle_assessment_fields
          (tenant_id, group_key, name, field_type, suffix, display_order)
        VALUES (?, 'custom', ?, ?, ?, (
          SELECT COALESCE(MAX(display_order), -1) + 1
          FROM vehicle_assessment_fields WHERE tenant_id = ? AND group_key = 'custom'
        ))
      `).run(request.tenantId, name, type, suffix, request.tenantId);
      realtime.notify(request.tenantId);
      response.status(201).json(db.prepare(`
        SELECT id, built_in_key, group_key, name, field_type, suffix, display_order
        FROM vehicle_assessment_fields WHERE id = ? AND tenant_id = ?
      `).get(result.lastInsertRowid, request.tenantId));
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "同じ名前の評価項目は既に登録されています。" });
      }
      next(error);
    }
  });

  app.delete("/api/assessment-fields/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const fieldId = parseVehicleId(request.params.id);
    if (fieldId === null) return response.status(404).json({ detail: "評価項目が見つかりません。" });
    try {
      const result = db.prepare(
        "DELETE FROM vehicle_assessment_fields WHERE id = ? AND tenant_id = ?",
      ).run(fieldId, request.tenantId);
      if (!result.changes) return response.status(404).json({ detail: "評価項目が見つかりません。" });
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/damage-types", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const rawIcon = request.body?.icon;
    const icon = rawIcon === undefined ? "⚠️" : typeof rawIcon === "string" ? rawIcon.trim() : null;
    const rawColor = request.body?.color;
    const color = rawColor === undefined ? "#e34b4b" : rawColor;
    if (!name || name.length > 40 || icon === null || icon.length > 8 ||
        typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return response.status(422).json({ detail: "問題の名前・アイコン・色を正しく指定してください。" });
    }
    try {
      const result = db.prepare(`
        INSERT INTO vehicle_damage_types (tenant_id, name, icon, color)
        VALUES (?, ?, ?, ?)
      `).run(request.tenantId, name, icon || "⚠️", color);
      realtime.notify(request.tenantId);
      response.status(201).json(db.prepare(
        "SELECT id, built_in_key, name, icon, color FROM vehicle_damage_types WHERE id = ? AND tenant_id = ?",
      ).get(result.lastInsertRowid, request.tenantId));
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "同じ名前の問題種類は既に登録されています。" });
      }
      next(error);
    }
  });

  app.delete("/api/damage-types/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const typeId = parseVehicleId(request.params.id);
    if (typeId === null) return response.status(404).json({ detail: "問題種類が見つかりません。" });
    try {
      const result = db.prepare(
        "DELETE FROM vehicle_damage_types WHERE id = ? AND tenant_id = ?",
      ).run(typeId, request.tenantId);
      if (!result.changes) return response.status(404).json({ detail: "問題種類が見つかりません。" });
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/jobs", requireUser, requireSameOrigin, (request, response, next) => {
    const body = request.body || {};
    const scheduledAt = normalizeJobTime(body.scheduled_at);
    const vehicleId = parseVehicleId(String(body.vehicle_id ?? ""));
    const lotId = parseVehicleId(String(body.destination_lot_id ?? ""));
    if (!scheduledAt || vehicleId === null || lotId === null) {
      return response.status(422).json({ detail: "日時・車両・送り先を正しく入力してください。" });
    }
    try {
      const vehicle = db.prepare("SELECT id FROM vehicles WHERE id = ? AND tenant_id = ?")
        .get(vehicleId, request.tenantId);
      const lot = db.prepare("SELECT id FROM parking_lots WHERE id = ? AND tenant_id = ?")
        .get(lotId, request.tenantId);
      if (!vehicle || !lot) {
        return response.status(422).json({ detail: "車両または送り先が見つかりません。" });
      }
      const result = db.prepare(`
        INSERT INTO jobs (tenant_id, vehicle_id, destination_lot_id, scheduled_at)
        VALUES (?, ?, ?, ?)
      `).run(request.tenantId, vehicleId, lotId, scheduledAt);
      realtime.notify(request.tenantId);
      response.status(201).json({ id: Number(result.lastInsertRowid) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/jobs/:id", requireUser, requireSameOrigin, (request, response, next) => {
    const jobId = parseVehicleId(request.params.id);
    if (jobId === null || typeof request.body?.completed !== "boolean") {
      return response.status(422).json({ detail: "ジョブの状態が正しくありません。" });
    }
    try {
      const completed = request.body.completed;
      const result = db.prepare(
        "UPDATE jobs SET completed = ?, completed_at = ? WHERE id = ? AND tenant_id = ?",
      ).run(completed ? 1 : 0, completed ? new Date().toISOString() : null, jobId, request.tenantId);
      if (!result.changes) return response.status(404).json({ detail: "ジョブが見つかりません。" });
      realtime.notify(request.tenantId);
      response.json({ id: jobId, completed });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/jobs/:id", requireUser, requireSameOrigin, (request, response, next) => {
    const jobId = parseVehicleId(request.params.id);
    if (jobId === null) return response.status(404).json({ detail: "ジョブが見つかりません。" });
    try {
      const result = db.prepare("DELETE FROM jobs WHERE id = ? AND tenant_id = ?")
        .run(jobId, request.tenantId);
      if (!result.changes) return response.status(404).json({ detail: "ジョブが見つかりません。" });
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/statuses", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const rawIcon = request.body?.icon;
    const icon = rawIcon === undefined ? "🔔" : typeof rawIcon === "string" ? rawIcon.trim() : null;
    if (!name || name.length > 40 || icon === null || icon.length > 8) {
      return response.status(422).json({ detail: "ステータス名は1〜40文字、アイコンは8文字以内で入力してください。" });
    }
    try {
      const result = db.prepare(`
        INSERT INTO vehicle_statuses (tenant_id, name, icon)
        VALUES (?, ?, ?)
      `).run(request.tenantId, name, icon || "🔔");
      realtime.notify(request.tenantId);
      response.status(201).json(db.prepare(
        "SELECT id, name, icon, key FROM vehicle_statuses WHERE id = ? AND tenant_id = ?",
      ).get(result.lastInsertRowid, request.tenantId));
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return response.status(409).json({ detail: "同じ名前のステータスは既に登録されています。" });
      }
      next(error);
    }
  });

  app.delete("/api/statuses/:id", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    const statusId = parseVehicleId(request.params.id);
    if (statusId === null) return response.status(404).json({ detail: "ステータスが見つかりません。" });
    const status = db.prepare(
      "SELECT id, key FROM vehicle_statuses WHERE id = ? AND tenant_id = ?",
    ).get(statusId, request.tenantId);
    if (!status) return response.status(404).json({ detail: "ステータスが見つかりません。" });
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (STATUSES.includes(status.key)) {
          db.prepare(`UPDATE vehicles SET ${status.key} = 0 WHERE tenant_id = ?`)
            .run(request.tenantId);
        }
        db.prepare("DELETE FROM vehicle_statuses WHERE id = ? AND tenant_id = ?")
          .run(statusId, request.tenantId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/vehicles", requireUser, requireAdmin, requireSameOrigin, (request, response, next) => {
    try {
      const body = request.body || {};
      const { plate, vehicle_type: vehicleType } = body;
      if (
        typeof plate !== "string" || !plate.trim() || plate.trim().length > 40 ||
        !classExists(vehicleType, request.tenantId)
      ) {
        return response.status(422).json({ detail: "Valid plate and vehicle type are required." });
      }
      if (body.notes !== undefined &&
          (typeof body.notes !== "string" || body.notes.length > 5000)) {
        return response.status(422).json({ detail: "Vehicle notes must be 5000 characters or fewer." });
      }
      const lotId = body.parking_lot_id ?? getDefaultParkingLotId(db, request.tenantId);
      if (!Number.isInteger(lotId) || !validateLot(lotId, request.tenantId)) {
        return response.status(422).json({ detail: "Unknown parking lot." });
      }
      const hasX = Object.hasOwn(body, "position_x");
      const hasY = Object.hasOwn(body, "position_y");
      if (hasX !== hasY) {
        return response.status(422).json({ detail: "Supply both position coordinates or neither." });
      }
      let position;
      if (hasX) {
        const { position_x: x, position_y: y } = body;
        if (![x, y].every((value) => typeof value === "number" && value >= 0 && value <= 1)) {
          return response.status(422).json({ detail: "Vehicle coordinates must be between 0 and 1." });
        }
        position = { positionX: x, positionY: y };
      } else {
        position = getNextPosition(db, lotId);
      }
      const options = body.options ?? [];
      if (!vehicleOptionsAreValid(db, options, request.tenantId)) {
        return response.status(422).json({ detail: "Invalid vehicle options." });
      }
      if (STATUSES.some((status) => Object.hasOwn(body, status) && typeof body[status] !== "boolean")) {
        return response.status(422).json({ detail: "Vehicle statuses must be boolean." });
      }
      const assessmentValues = body.assessment_values ?? {};
      const inspectionMarks = body.inspection_marks ?? [];
      if (!assessmentValuesAreValid(db, assessmentValues, request.tenantId) ||
          !inspectionMarksAreValid(db, inspectionMarks, request.tenantId)) {
        return response.status(422).json({ detail: "車両評価または車体マークの内容が正しくありません。" });
      }
      const legacyStatuses = db.prepare(
        `SELECT id, key FROM vehicle_statuses WHERE tenant_id = ? AND key IN (${STATUSES.map(() => "?").join(", ")})`,
      ).all(request.tenantId, ...STATUSES);
      let statusIds;
      if (Object.hasOwn(body, "status_ids")) {
        statusIds = body.status_ids;
        if (!statusIdsAreValid(db, statusIds, request.tenantId)) {
          return response.status(422).json({ detail: "Invalid vehicle status list." });
        }
      } else {
        statusIds = legacyStatuses.filter((status) => body[status.key] === true)
          .map((status) => status.id);
      }
      const legacyStatusIds = new Map(legacyStatuses.map((status) => [status.key, status.id]));
      const assignedStatusIds = new Set(statusIds);
      db.exec("BEGIN IMMEDIATE");
      let result;
      try {
        result = db.prepare(`
          INSERT INTO vehicles
            (plate, vehicle_type, parking_lot_id, position_x, position_y,
             unwashed, no_fuel, needs_repair, options, notes, tenant_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          plate.trim(), vehicleType.trim(), lotId ?? null, position.positionX, position.positionY,
          ...STATUSES.map((status) => Number(assignedStatusIds.has(legacyStatusIds.get(status)))),
          JSON.stringify(options), (body.notes || "").trim(), request.tenantId,
        );
        const addAssignment = db.prepare(
          "INSERT INTO vehicle_status_assignments (vehicle_id, status_id) VALUES (?, ?)",
        );
        for (const statusId of statusIds) addAssignment.run(result.lastInsertRowid, statusId);
        saveInspectionData(db, result.lastInsertRowid, assessmentValues, inspectionMarks);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.status(201).json(vehicleResponse(db, db.prepare(
        "SELECT * FROM vehicles WHERE id = ? AND tenant_id = ?",
      ).get(result.lastInsertRowid, request.tenantId)));
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_CHECK") {
        return response.status(422).json({ detail: "Invalid vehicle data." });
      }
      next(error);
    }
  });

  app.patch("/api/vehicles/:id", requireUser, requireSameOrigin, (request, response, next) => {
    try {
      const vehicleId = parseVehicleId(request.params.id);
      if (vehicleId === null) return response.status(404).json({ detail: "Vehicle not found." });
      const existingVehicle = db.prepare("SELECT id FROM vehicles WHERE id = ? AND tenant_id = ?")
        .get(vehicleId, request.tenantId);
      if (!existingVehicle) return response.status(404).json({ detail: "Vehicle not found." });
      const allowed = new Set([
        "plate", "vehicle_type", "parking_lot_id", "position_x", "position_y",
        "options", "status_ids", "assessment_values", "inspection_marks", "notes", ...STATUSES,
      ]);
      const entries = Object.entries(request.body || {});
      if (!entries.length) return response.status(422).json({ detail: "No vehicle fields supplied." });
      if (entries.some(([key]) => !allowed.has(key))) {
        return response.status(422).json({ detail: "Unknown vehicle field." });
      }
      const data = Object.fromEntries(entries);
      const assessmentValues = Object.hasOwn(data, "assessment_values") ? data.assessment_values : undefined;
      const inspectionMarks = Object.hasOwn(data, "inspection_marks") ? data.inspection_marks : undefined;
      if (assessmentValues !== undefined &&
          !assessmentValuesAreValid(db, assessmentValues, request.tenantId)) {
        return response.status(422).json({ detail: "車両評価の内容が正しくありません。" });
      }
      if (inspectionMarks !== undefined &&
          !inspectionMarksAreValid(db, inspectionMarks, request.tenantId)) {
        return response.status(422).json({ detail: "車体マークの内容が正しくありません。" });
      }
      delete data.assessment_values;
      delete data.inspection_marks;
      const hasStatusIds = Object.hasOwn(data, "status_ids");
      let nextStatusIds = null;
      if (hasStatusIds) {
        if (!statusIdsAreValid(db, data.status_ids, request.tenantId)) {
          return response.status(422).json({ detail: "Invalid vehicle status list." });
        }
        nextStatusIds = data.status_ids;
      } else if (STATUSES.some((status) => Object.hasOwn(data, status))) {
        const currentStatusIds = new Set(getVehicleStatusIds(db, vehicleId));
        const legacyStatuses = db.prepare(
          `SELECT id, key FROM vehicle_statuses WHERE tenant_id = ? AND key IN (${STATUSES.map(() => "?").join(", ")})`,
        ).all(request.tenantId, ...STATUSES);
        for (const status of legacyStatuses) {
          if (!Object.hasOwn(data, status.key)) continue;
          if (data[status.key] === true) currentStatusIds.add(status.id);
          else currentStatusIds.delete(status.id);
        }
        nextStatusIds = [...currentStatusIds];
      }
      delete data.status_ids;
      if (
        ["plate", "vehicle_type"].some((field) =>
          Object.hasOwn(data, field) &&
          (typeof data[field] !== "string" || !data[field].trim() || data[field].trim().length > 40))
      ) {
        return response.status(422).json({ detail: "Plate and vehicle type cannot be empty." });
      }
      if (Object.hasOwn(data, "vehicle_type") && !classExists(data.vehicle_type, request.tenantId)) {
        return response.status(422).json({ detail: "Unknown vehicle type." });
      }
      if (Object.hasOwn(data, "notes")) {
        if (typeof data.notes !== "string" || data.notes.length > 5000) {
          return response.status(422).json({ detail: "Vehicle notes must be 5000 characters or fewer." });
        }
        data.notes = data.notes.trim();
      }
      if (Object.hasOwn(data, "options")) {
        if (!vehicleOptionsAreValid(db, data.options, request.tenantId)) {
          return response.status(422).json({ detail: "Invalid vehicle options." });
        }
        data.options = JSON.stringify(data.options);
      }
      if (["position_x", "position_y"].some((field) =>
        Object.hasOwn(data, field) &&
        (typeof data[field] !== "number" || data[field] < 0 || data[field] > 1))
      ) {
        return response.status(422).json({ detail: "Vehicle coordinates must be between 0 and 1." });
      }
      if (Object.hasOwn(data, "parking_lot_id") && data.parking_lot_id === null) {
        data.parking_lot_id = getDefaultParkingLotId(db, request.tenantId);
      }
      if (Object.hasOwn(data, "parking_lot_id") &&
          (!Number.isInteger(data.parking_lot_id) || !validateLot(data.parking_lot_id, request.tenantId))) {
        return response.status(422).json({ detail: "Unknown parking lot." });
      }
      if (STATUSES.some((field) => Object.hasOwn(data, field) && typeof data[field] !== "boolean")) {
        return response.status(422).json({ detail: "Vehicle statuses must be boolean." });
      }
      for (const field of ["position_x", "position_y"]) {
        if (Object.hasOwn(data, field) && !Object.hasOwn(data, field === "position_x" ? "position_y" : "position_x")) {
          return response.status(422).json({ detail: "Supply both position coordinates or neither." });
        }
      }
      for (const field of ["plate", "vehicle_type"]) {
        if (Object.hasOwn(data, field)) data[field] = data[field].trim();
      }
      if (nextStatusIds !== null) {
        const legacyStatuses = db.prepare(
          `SELECT id, key FROM vehicle_statuses WHERE tenant_id = ? AND key IN (${STATUSES.map(() => "?").join(", ")})`,
        ).all(request.tenantId, ...STATUSES);
        const assignedStatusIds = new Set(nextStatusIds);
        for (const status of STATUSES) {
          data[status] = Number(legacyStatuses.some((entry) =>
            entry.key === status && assignedStatusIds.has(entry.id)));
        }
      }
      for (const field of STATUSES) {
        if (Object.hasOwn(data, field)) data[field] = Number(data[field]);
      }
      const assignments = Object.keys(data).map((field) => `${field} = ?`).join(", ");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (assignments) {
          db.prepare(`UPDATE vehicles SET ${assignments} WHERE id = ? AND tenant_id = ?`)
            .run(...Object.values(data), vehicleId, request.tenantId);
        }
        if (nextStatusIds !== null) {
          db.prepare("DELETE FROM vehicle_status_assignments WHERE vehicle_id = ?").run(vehicleId);
          const addAssignment = db.prepare(
            "INSERT INTO vehicle_status_assignments (vehicle_id, status_id) VALUES (?, ?)",
          );
          for (const statusId of nextStatusIds) addAssignment.run(vehicleId, statusId);
        }
        saveInspectionData(db, vehicleId, assessmentValues, inspectionMarks);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      realtime.notify(request.tenantId);
      response.json(vehicleResponse(db, db.prepare(
        "SELECT * FROM vehicles WHERE id = ? AND tenant_id = ?",
      ).get(vehicleId, request.tenantId)));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/vehicles/:id", requireUser, requireAdmin, requireSameOrigin, (request, response) => {
    const vehicleId = parseVehicleId(request.params.id);
    if (vehicleId === null) return response.status(404).json({ detail: "Vehicle not found." });
    const result = db.prepare("DELETE FROM vehicles WHERE id = ? AND tenant_id = ?")
      .run(vehicleId, request.tenantId);
    if (!result.changes) return response.status(404).json({ detail: "Vehicle not found." });
    realtime.notify(request.tenantId);
    response.status(204).end();
  });

  function requireErpKey(request, response, next) {
    if (!erpApiKey) return response.status(503).json({ detail: "ERP integration is not enabled." });
    const expected = Buffer.from(erpApiKey);
    const provided = Buffer.from(request.get("x-erp-api-key") || "");
    if (expected.length !== provided.length || !require("node:crypto").timingSafeEqual(expected, provided)) {
      return response.status(401).json({ detail: "Invalid ERP API key." });
    }
    next();
  }

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", version });
  });

  app.get("/api/integration/vehicles", requireErpKey, (_request, response) => {
    const vehicles = db.prepare(`
      SELECT v.id, v.external_id, v.plate, v.vehicle_type, v.parking_lot_id, l.name AS parking_lot_name
      FROM vehicles v LEFT JOIN parking_lots l ON l.id = v.parking_lot_id
      WHERE v.tenant_id = ? ORDER BY v.id
    `).all(headquartersId);
    response.json({ vehicles });
  });

  app.post("/api/integration/vehicles:sync", requireSameOrigin, requireErpKey, (request, response, next) => {
    const payload = request.body;
    if (!Array.isArray(payload)) return response.status(422).json({ detail: "Expected a vehicle array." });
    if (payload.length > 500) return response.status(413).json({ detail: "A sync batch may contain at most 500 vehicles." });
    try {
      for (const vehicle of payload) {
        if (
          !vehicle || typeof vehicle.external_id !== "string" || !vehicle.external_id.trim() ||
          vehicle.external_id.length > 120 || typeof vehicle.plate !== "string" ||
          !vehicle.plate.trim() || vehicle.plate.trim().length > 40 ||
          !classExists(vehicle.vehicle_type, headquartersId)
        ) return response.status(422).json({ detail: "Each vehicle requires external_id, plate, and vehicle_type." });
        if (vehicle.parking_lot_id != null &&
            (!Number.isInteger(vehicle.parking_lot_id) || !validateLot(vehicle.parking_lot_id, headquartersId))) {
          return response.status(422).json({ detail: "Unknown parking lot." });
        }
      }
      const existing = db.prepare("SELECT id FROM vehicles WHERE tenant_id = ? AND external_id = ?");
      const update = db.prepare(`
        UPDATE vehicles
        SET plate = ?, vehicle_type = ?, parking_lot_id = COALESCE(?, parking_lot_id)
        WHERE tenant_id = ? AND external_id = ?
      `);
      const insert = db.prepare(`
        INSERT INTO vehicles
          (external_id, plate, vehicle_type, parking_lot_id, position_x, position_y, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const vehicle of payload) {
          const externalId = vehicle.external_id.trim();
          if (existing.get(headquartersId, externalId)) {
            update.run(
              vehicle.plate.trim(), vehicle.vehicle_type.trim(), vehicle.parking_lot_id ?? null,
              headquartersId, externalId,
            );
          } else {
            const lotId = vehicle.parking_lot_id ?? getDefaultParkingLotId(db, headquartersId);
            const position = getNextPosition(db, lotId);
            insert.run(
              externalId, vehicle.plate.trim(), vehicle.vehicle_type.trim(),
              lotId, position.positionX, position.positionY, headquartersId,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (payload.length) realtime.notify(headquartersId);
      response.json({ synced: payload.length });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, request, response, _next) => {
    if (error.type === "entity.parse.failed") {
      errorLogger.capture("malformed-json", error, { status: 400, path: request.path });
      return response.status(400).json({ detail: "Malformed JSON." });
    }
    if (error.type === "entity.too.large") {
      errorLogger.capture("request-too-large", error, { status: 413, path: request.path });
      return response.status(413).json({ detail: "Request body is too large." });
    }
    errorLogger.capture("server-error", error, {
      status: 500,
      method: request.method,
      path: request.path,
    });
    response.status(500).json({ detail: "Internal server error." });
  });

  function purgeJobs(now = new Date()) {
    try {
      const removed = purgeCompletedJobs(db, now);
      if (removed) {
        for (const tenant of db.prepare("SELECT id FROM tenants").all()) realtime.notify(tenant.id);
      }
      return removed;
    } catch (error) {
      errorLogger.capture("job-purge-error", error);
      return 0;
    }
  }

  function createServer() {
    const server = http.createServer(app);
    realtime.attach(server);
    return server;
  }

  return { app, db, sessionStore, errorLogger, createServer, purgeJobs };
}

async function start() {
  const application = createApplication();
  process.on("unhandledRejection", (error) => {
    application.errorLogger.capture("unhandled-rejection", error);
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    application.errorLogger.capture("uncaught-exception", error);
    process.exit(1);
  });
  const server = application.createServer();
  application.purgeJobs();
  setInterval(() => application.purgeJobs(), 60_000).unref();
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`Guts board listening on http://${host}:${port}`));
  const shutdown = () => {
    server.close(() => {
      application.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  try {
    start().catch((error) => {
      const logger = new ErrorLogger(
        process.env.ERROR_LOG_PATH ||
          defaultErrorLogPath(process.env.DATABASE_PATH || "data/rentalcar.db"),
      );
      logger.capture("startup-error", error);
      process.exitCode = 1;
    });
  } catch (error) {
    const logger = new ErrorLogger(
      process.env.ERROR_LOG_PATH ||
        defaultErrorLogPath(process.env.DATABASE_PATH || "data/rentalcar.db"),
    );
    logger.capture("startup-error", error);
    process.exitCode = 1;
  }
}

module.exports = { createApplication, getNextPosition, vehicleFromRow };
