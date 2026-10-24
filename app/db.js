const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LOT_NAMES = [
  ...Array.from({ length: 9 }, (_, index) => `駐車場 ${index + 1}`),
  "本店貸出中",
  "駅前店貸出中",
  "予備",
  "立駐",
];
const VEHICLE_TYPES = ["A-1", "A-2", "A-2P", "B", "B軽トラ", "C-1", "C-2", "D", "H-1", "H-2", "その他"];
const DEFAULT_CLASS_COLORS = [
  "#4f86f7", "#9b6ad8", "#f0a043", "#38a9d0", "#e56b7a",
  "#c7b23c", "#6f8794", "#7fb24f", "#d98a57", "#6d78c8", "#9aa5b1",
];
const DEFAULT_STORES = ["本店", "駅前店"];
const DEFAULT_VEHICLE_OPTIONS = ["ETC", "車載器", "禁煙", "喫煙", "ナビ", "スタッドレス"];
const DEFAULT_STATUSES = [
  { key: "unwashed", name: "洗車待ち", icon: "🫧" },
  { key: "no_fuel", name: "給油待ち", icon: "⛽" },
  { key: "needs_repair", name: "要修理", icon: "🔧" },
];
const DEFAULT_ASSESSMENT_FIELDS = [
  { key: "exterior", group: "body", name: "外装（ボディ・塗装・鈑金）", type: "rating", sort: 0 },
  { key: "interior", group: "body", name: "内装（シート・天井・フロア）", type: "rating", sort: 1 },
  { key: "wheels", group: "body", name: "ホイール", type: "rating", sort: 2 },
  { key: "registration_document", group: "electrical", name: "車検証", type: "checkbox", sort: 0, suffix: "確認済み" },
  { key: "radio", group: "electrical", name: "ラジオ", type: "checkbox", sort: 1 },
  { key: "navigation", group: "electrical", name: "ナビ（５年以内）", type: "checkbox", sort: 2 },
  { key: "air_conditioning", group: "electrical", name: "エアコン", type: "checkbox", sort: 3 },
  { key: "side_mirror", group: "electrical", name: "サイドミラー調整", type: "checkbox", sort: 4 },
  { key: "mileage", group: "basic", name: "走行距離", type: "number", sort: 0, suffix: "km" },
  { key: "registration_year", group: "basic", name: "初年度登録（年）", type: "number", sort: 1, suffix: "年" },
  { key: "registration_month", group: "basic", name: "初年度登録（月）", type: "number", sort: 2, suffix: "月" },
];
const DEFAULT_DAMAGE_TYPES = [
  { key: "scratch", name: "傷", icon: "〰️", color: "#e34b4b" },
  { key: "dent", name: "凹み", icon: "◉", color: "#805ad5" },
];
const ASSESSMENT_FIELD_TYPES = ["rating", "checkbox", "text", "number"];
const TENANT_DATA_MIGRATION = "tenant-isolation-v1";

function seedTenantStatuses(db, tenantId) {
  const addStatus = db.prepare(`
    INSERT OR IGNORE INTO vehicle_statuses (tenant_id, key, name, icon)
    VALUES (?, ?, ?, ?)
  `);
  for (const status of DEFAULT_STATUSES) {
    addStatus.run(tenantId, status.key, status.name, status.icon);
  }
}

function seedTenantVehicleClasses(db, tenantId) {
  const addClass = db.prepare(`
    INSERT OR IGNORE INTO vehicle_classes (tenant_id, name, color, display_order)
    VALUES (?, ?, ?, ?)
  `);
  VEHICLE_TYPES.forEach((name, index) => {
    addClass.run(tenantId, name, DEFAULT_CLASS_COLORS[index % DEFAULT_CLASS_COLORS.length], index);
  });
  const extra = db.prepare(`
    SELECT DISTINCT vehicle_type AS name FROM vehicles WHERE tenant_id = ?
    AND vehicle_type NOT IN (SELECT name FROM vehicle_classes WHERE tenant_id = ?)
  `).all(tenantId, tenantId);
  let order = VEHICLE_TYPES.length;
  for (const { name } of extra) addClass.run(tenantId, name, "#9aa5b1", order++);
}

function seedTenantAssessment(db, tenantId) {
  const addField = db.prepare(`
    INSERT OR IGNORE INTO vehicle_assessment_fields
      (tenant_id, built_in_key, group_key, name, field_type, suffix, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const field of DEFAULT_ASSESSMENT_FIELDS) {
    addField.run(tenantId, field.key, field.group, field.name, field.type, field.suffix || "", field.sort);
  }
  const addDamageType = db.prepare(`
    INSERT OR IGNORE INTO vehicle_damage_types (tenant_id, built_in_key, name, icon, color)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const type of DEFAULT_DAMAGE_TYPES) {
    addDamageType.run(tenantId, type.key, type.name, type.icon, type.color);
  }
}

function seedTenantVehicleOptions(db, tenantId) {
  const addOption = db.prepare(`
    INSERT OR IGNORE INTO vehicle_option_types (tenant_id, name, built_in_key)
    SELECT ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM vehicle_option_suppressions
      WHERE tenant_id = ? AND built_in_key = ?
    )
  `);
  for (const name of DEFAULT_VEHICLE_OPTIONS) addOption.run(tenantId, name, name, tenantId, name);
}

function openDatabase(databasePath) {
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_headquarters INTEGER NOT NULL DEFAULT 0 CHECK(is_headquarters IN (0, 1)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, is_headquarters, is_active)
    VALUES (1, '本店', 1, 1)
  `).run();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'operator')),
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS parking_lots (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      area_height INTEGER NOT NULL DEFAULT 210,
      area_width INTEGER NOT NULL DEFAULT 50,
      navigation_url TEXT NOT NULL DEFAULT '',
      markings TEXT NOT NULL DEFAULT '[]',
      tenant_id INTEGER NOT NULL REFERENCES tenants(id)
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY,
      external_id TEXT UNIQUE,
      plate TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      parking_lot_id INTEGER REFERENCES parking_lots(id) ON DELETE SET NULL,
      position_x REAL NOT NULL DEFAULT 0.5 CHECK(position_x >= 0 AND position_x <= 1),
      position_y REAL NOT NULL DEFAULT 0.5 CHECK(position_y >= 0 AND position_y <= 1),
      unwashed INTEGER NOT NULL DEFAULT 0 CHECK(unwashed IN (0, 1)),
      no_fuel INTEGER NOT NULL DEFAULT 0 CHECK(no_fuel IN (0, 1)),
      needs_repair INTEGER NOT NULL DEFAULT 0 CHECK(needs_repair IN (0, 1)),
      options TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      inspection_expiry_date TEXT,
      statutory_inspection_date TEXT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS vehicles_lot_idx ON vehicles(parking_lot_id);
    CREATE INDEX IF NOT EXISTS vehicles_plate_idx ON vehicles(plate);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(vehicles)").all().map((column) => column.name));
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  const lotColumns = new Set(db.prepare("PRAGMA table_info(parking_lots)").all().map((column) => column.name));
  if (!userColumns.has("tenant_id")) {
    db.exec("ALTER TABLE users ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1");
  }
  if (!lotColumns.has("tenant_id")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.has("tenant_id")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1");
  }
  if (!userColumns.has("role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'operator'))");
  }
  if (!lotColumns.has("display_order")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE parking_lots SET display_order = id - 1");
  }
  if (!lotColumns.has("area_height")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN area_height INTEGER NOT NULL DEFAULT 210");
  }
  if (!lotColumns.has("area_width")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN area_width INTEGER NOT NULL DEFAULT 50");
  }
  if (!lotColumns.has("navigation_url")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN navigation_url TEXT NOT NULL DEFAULT ''");
  }
  if (!lotColumns.has("markings")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN markings TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("options")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("notes")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("inspection_expiry_date")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN inspection_expiry_date TEXT");
  }
  if (!columns.has("statutory_inspection_date")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN statutory_inspection_date TEXT");
  }
  const headquartersId = db.prepare("SELECT id FROM tenants WHERE is_headquarters = 1").get()?.id;
  if (!headquartersId) throw new Error("Headquarters tenant is missing.");
  db.exec(`
    CREATE INDEX IF NOT EXISTS vehicles_tenant_idx ON vehicles(tenant_id);
    CREATE INDEX IF NOT EXISTS parking_lots_tenant_idx ON parking_lots(tenant_id);
    CREATE INDEX IF NOT EXISTS users_tenant_idx ON users(tenant_id);
    CREATE UNIQUE INDEX IF NOT EXISTS tenants_single_headquarters_idx ON tenants(is_headquarters) WHERE is_headquarters = 1;
  `);
  const tenantDataMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
    .get(TENANT_DATA_MIGRATION);
  if (!tenantDataMigration) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      const seedHeadquartersLot = db.prepare(
        "INSERT OR IGNORE INTO parking_lots (tenant_id, name, display_order) VALUES (?, ?, ?)",
      );
      LOT_NAMES.forEach((name, index) => seedHeadquartersLot.run(headquartersId, name, index));
      const legacySectionsMigration = "flatten-board-sections-into-locations";
      if (columns.has("board_section") &&
          !db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(legacySectionsMigration)) {
        const moveToLocation = db.prepare(`
          UPDATE vehicles
          SET parking_lot_id = (
            SELECT id FROM parking_lots WHERE tenant_id = ? AND name = ?
          )
          WHERE tenant_id = ? AND board_section = ?
        `);
        for (const name of ["本店貸出中", "駅前店貸出中", "予備"]) {
          moveToLocation.run(headquartersId, name, headquartersId, name);
        }
        db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(legacySectionsMigration);
      }
      db.exec(`
        CREATE TABLE parking_lots_tenant_new (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          display_order INTEGER NOT NULL DEFAULT 0,
          area_height INTEGER NOT NULL DEFAULT 210,
          area_width INTEGER NOT NULL DEFAULT 50,
          navigation_url TEXT NOT NULL DEFAULT '',
          markings TEXT NOT NULL DEFAULT '[]',
          tenant_id INTEGER NOT NULL REFERENCES tenants(id)
        );
        INSERT INTO parking_lots_tenant_new
          (id, name, display_order, area_height, area_width, navigation_url, markings, tenant_id)
        SELECT id, name, display_order, area_height, area_width, navigation_url, markings, tenant_id
        FROM parking_lots;
        DROP TABLE parking_lots;
        ALTER TABLE parking_lots_tenant_new RENAME TO parking_lots;

        CREATE TABLE vehicles_tenant_new (
          id INTEGER PRIMARY KEY,
          external_id TEXT,
          plate TEXT NOT NULL,
          vehicle_type TEXT NOT NULL,
          parking_lot_id INTEGER REFERENCES parking_lots(id) ON DELETE SET NULL,
          position_x REAL NOT NULL DEFAULT 0.5 CHECK(position_x >= 0 AND position_x <= 1),
          position_y REAL NOT NULL DEFAULT 0.5 CHECK(position_y >= 0 AND position_y <= 1),
          unwashed INTEGER NOT NULL DEFAULT 0 CHECK(unwashed IN (0, 1)),
          no_fuel INTEGER NOT NULL DEFAULT 0 CHECK(no_fuel IN (0, 1)),
          needs_repair INTEGER NOT NULL DEFAULT 0 CHECK(needs_repair IN (0, 1)),
          options TEXT NOT NULL DEFAULT '[]',
          notes TEXT NOT NULL DEFAULT '',
          inspection_expiry_date TEXT,
          statutory_inspection_date TEXT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id)
        );
        INSERT INTO vehicles_tenant_new
          (id, external_id, plate, vehicle_type, parking_lot_id, position_x, position_y,
           unwashed, no_fuel, needs_repair, options, notes,
           inspection_expiry_date, statutory_inspection_date, tenant_id)
        SELECT id, external_id, plate, vehicle_type, parking_lot_id, position_x, position_y,
               unwashed, no_fuel, needs_repair, options, notes,
               inspection_expiry_date, statutory_inspection_date, tenant_id
        FROM vehicles;
        DROP TABLE vehicles;
        ALTER TABLE vehicles_tenant_new RENAME TO vehicles;

        CREATE UNIQUE INDEX vehicles_external_id_tenant_idx
          ON vehicles(tenant_id, external_id) WHERE external_id IS NOT NULL;
        CREATE INDEX vehicles_lot_idx ON vehicles(parking_lot_id);
        CREATE INDEX vehicles_plate_idx ON vehicles(plate);
        CREATE INDEX vehicles_tenant_idx ON vehicles(tenant_id);
        CREATE INDEX parking_lots_tenant_idx ON parking_lots(tenant_id);
        CREATE UNIQUE INDEX parking_lots_name_tenant_idx ON parking_lots(tenant_id, name COLLATE NOCASE);
      `);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(TENANT_DATA_MIGRATION);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  db.exec(`
    UPDATE vehicles
    SET vehicle_type = CASE vehicle_type
      WHEN 'standard' THEN 'A-1'
      WHEN 'hybrid' THEN 'A-2'
      WHEN 'ev' THEN 'A-2P'
      WHEN 'van' THEN 'B'
      ELSE 'その他'
    END
    WHERE vehicle_type NOT IN ('A-1', 'A-2', 'A-2P', 'B', 'B軽トラ', 'C-1', 'C-2', 'D', 'H-1', 'H-2', 'その他')
  `);
  const addLot = db.prepare(
    "INSERT OR IGNORE INTO parking_lots (tenant_id, name, display_order) VALUES (?, ?, ?)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    LOT_NAMES.forEach((name, index) => addLot.run(headquartersId, name, index));
    const widthMigration = "parking-lot-width-percent-v1";
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(widthMigration)) {
      db.exec("UPDATE parking_lots SET area_width = CASE area_width WHEN 1 THEN 50 WHEN 2 THEN 100 ELSE area_width END");
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(widthMigration);
    }
    const migration = "flatten-board-sections-into-locations";
    if (columns.has("board_section") &&
        !db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migration)) {
      const moveToLocation = db.prepare(`
        UPDATE vehicles
        SET parking_lot_id = (
          SELECT id FROM parking_lots WHERE name = ?
        )
        WHERE board_section = ?
      `);
      for (const name of ["本店貸出中", "駅前店貸出中", "予備"]) {
        moveToLocation.run(name, name);
      }
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(migration);
    }
    const reserveLotId = db.prepare("SELECT id FROM parking_lots WHERE tenant_id = ? AND name = '予備'")
      .get(headquartersId).id;
    db.prepare("UPDATE vehicles SET parking_lot_id = ? WHERE tenant_id = ? AND parking_lot_id IS NULL")
      .run(reserveLotId, headquartersId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicle_statuses (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key TEXT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🔔',
      UNIQUE (tenant_id, key),
      UNIQUE (tenant_id, name COLLATE NOCASE)
    );
    CREATE TABLE IF NOT EXISTS vehicle_status_assignments (
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      status_id INTEGER NOT NULL REFERENCES vehicle_statuses(id) ON DELETE CASCADE,
      PRIMARY KEY (vehicle_id, status_id)
    );
    CREATE INDEX IF NOT EXISTS vehicle_statuses_tenant_idx ON vehicle_statuses(tenant_id);
    CREATE INDEX IF NOT EXISTS vehicle_status_assignments_status_idx
      ON vehicle_status_assignments(status_id);
    CREATE TABLE IF NOT EXISTS vehicle_assessment_fields (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      built_in_key TEXT,
      group_key TEXT NOT NULL DEFAULT 'custom',
      name TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK(field_type IN ('rating', 'checkbox', 'text', 'number')),
      suffix TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (tenant_id, built_in_key),
      UNIQUE (tenant_id, group_key, name COLLATE NOCASE)
    );
    CREATE TABLE IF NOT EXISTS vehicle_assessment_values (
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES vehicle_assessment_fields(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      PRIMARY KEY (vehicle_id, field_id)
    );
    CREATE TABLE IF NOT EXISTS vehicle_damage_types (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      built_in_key TEXT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '⚠️',
      color TEXT NOT NULL DEFAULT '#e34b4b',
      UNIQUE (tenant_id, built_in_key),
      UNIQUE (tenant_id, name COLLATE NOCASE)
    );
    CREATE TABLE IF NOT EXISTS vehicle_damage_marks (
      id TEXT PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      damage_type_id INTEGER NOT NULL REFERENCES vehicle_damage_types(id) ON DELETE CASCADE,
      x REAL NOT NULL CHECK(x >= 0 AND x <= 1),
      y REAL NOT NULL CHECK(y >= 0 AND y <= 1),
      world_x REAL,
      world_y REAL,
      world_z REAL
    );
    CREATE INDEX IF NOT EXISTS vehicle_assessment_fields_tenant_idx
      ON vehicle_assessment_fields(tenant_id, group_key, display_order);
    CREATE INDEX IF NOT EXISTS vehicle_assessment_values_field_idx
      ON vehicle_assessment_values(field_id);
    CREATE INDEX IF NOT EXISTS vehicle_damage_types_tenant_idx ON vehicle_damage_types(tenant_id);
    CREATE INDEX IF NOT EXISTS vehicle_damage_marks_vehicle_idx ON vehicle_damage_marks(vehicle_id);
    CREATE TABLE IF NOT EXISTS vehicle_option_types (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      built_in_key TEXT,
      UNIQUE (tenant_id, name COLLATE NOCASE),
      UNIQUE (tenant_id, built_in_key)
    );
    CREATE TABLE IF NOT EXISTS vehicle_option_suppressions (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      built_in_key TEXT NOT NULL,
      PRIMARY KEY (tenant_id, built_in_key)
    );
    CREATE INDEX IF NOT EXISTS vehicle_option_types_tenant_idx ON vehicle_option_types(tenant_id, id);
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      destination_lot_id INTEGER NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
      scheduled_at TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_tenant_idx ON jobs(tenant_id, completed, scheduled_at);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scheduled_date TEXT NOT NULL,
      content TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS scheduled_tasks_tenant_idx
      ON scheduled_tasks(tenant_id, scheduled_date, completed);
    CREATE TABLE IF NOT EXISTS vehicle_inspection_completions (
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      inspection_type TEXT NOT NULL CHECK(inspection_type IN ('vehicle_inspection', 'statutory_inspection')),
      due_date TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (vehicle_id, inspection_type, due_date)
    );
  `);
  const optionColumns = new Set(
    db.prepare("PRAGMA table_info(vehicle_option_types)").all().map((column) => column.name),
  );
  if (!optionColumns.has("built_in_key")) {
    db.exec("ALTER TABLE vehicle_option_types ADD COLUMN built_in_key TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS vehicle_option_types_builtin_idx ON vehicle_option_types(tenant_id, built_in_key)");
  const damageMarkColumns = new Set(
    db.prepare("PRAGMA table_info(vehicle_damage_marks)").all().map((column) => column.name),
  );
  for (const column of ["world_x", "world_y", "world_z"]) {
    if (!damageMarkColumns.has(column)) {
      db.exec(`ALTER TABLE vehicle_damage_marks ADD COLUMN ${column} REAL`);
    }
  }
  for (const column of ["world_nx", "world_ny", "world_nz"]) {
    if (!damageMarkColumns.has(column)) {
      db.exec(`ALTER TABLE vehicle_damage_marks ADD COLUMN ${column} REAL`);
    }
  }
  for (const tenant of db.prepare("SELECT id FROM tenants").all()) {
    seedTenantVehicleOptions(db, tenant.id);
  }
  const statusMigration = "custom-vehicle-statuses-v1";
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(statusMigration)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const tenants = db.prepare("SELECT id FROM tenants").all();
      for (const tenant of tenants) {
        seedTenantStatuses(db, tenant.id);
      }
      for (const status of DEFAULT_STATUSES) {
        for (const tenant of tenants) {
          db.prepare(`
            INSERT OR IGNORE INTO vehicle_status_assignments (vehicle_id, status_id)
            SELECT v.id, s.id FROM vehicles v
            JOIN vehicle_statuses s ON s.tenant_id = v.tenant_id AND s.key = ?
            WHERE v.tenant_id = ? AND v.${status.key} = 1
          `).run(status.key, tenant.id);
        }
      }
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(statusMigration);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicle_classes (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#9aa5b1',
      display_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (tenant_id, name COLLATE NOCASE)
    );
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      UNIQUE (tenant_id, name COLLATE NOCASE)
    );
    CREATE TABLE IF NOT EXISTS lot_distances (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      from_lot_id INTEGER NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
      to_lot_id INTEGER NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
      minutes REAL NOT NULL CHECK(minutes >= 0),
      km REAL CHECK(km IS NULL OR km >= 0),
      PRIMARY KEY (from_lot_id, to_lot_id)
    );
    CREATE TABLE IF NOT EXISTS store_lot_distances (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      lot_id INTEGER NOT NULL REFERENCES parking_lots(id) ON DELETE CASCADE,
      minutes REAL NOT NULL CHECK(minutes >= 0),
      km REAL CHECK(km IS NULL OR km >= 0),
      PRIMARY KEY (store_id, lot_id)
    );
  `);
  const currentLotColumns = new Set(db.prepare("PRAGMA table_info(parking_lots)").all().map((column) => column.name));
  if (!currentLotColumns.has("capacity")) db.exec("ALTER TABLE parking_lots ADD COLUMN capacity INTEGER");
  if (!currentLotColumns.has("is_active")) db.exec("ALTER TABLE parking_lots ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  if (!currentLotColumns.has("class_priority")) db.exec("ALTER TABLE parking_lots ADD COLUMN class_priority TEXT NOT NULL DEFAULT '[]'");
  const logisticsMigration = "vehicle-classes-and-logistics-v1";
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(logisticsMigration)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const tenant of db.prepare("SELECT id FROM tenants").all()) {
        seedTenantVehicleClasses(db, tenant.id);
      }
      const headquarters = db.prepare("SELECT id FROM tenants WHERE is_headquarters = 1 ORDER BY id").get();
      if (headquarters) {
        for (const name of DEFAULT_STORES) {
          db.prepare("INSERT OR IGNORE INTO stores (tenant_id, name) VALUES (?, ?)").run(headquarters.id, name);
        }
      }
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(logisticsMigration);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  const assessmentMigration = "vehicle-assessment-sheet-v1";
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(assessmentMigration)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const tenant of db.prepare("SELECT id FROM tenants").all()) {
        seedTenantAssessment(db, tenant.id);
      }
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(assessmentMigration);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  return db;
}

module.exports = {
  ASSESSMENT_FIELD_TYPES,
  DEFAULT_STATUSES,
  LOT_NAMES,
  VEHICLE_TYPES,
  openDatabase,
  seedTenantAssessment,
  seedTenantStatuses,
  seedTenantVehicleClasses,
  seedTenantVehicleOptions,
};
