const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

function assertDatabaseIsHealthy(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA integrity_check").get();
    if (result?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${result?.integrity_check || "no result"}`);
    }
  } finally {
    db.close();
  }
}

async function backupDatabase(sourcePath, destinationPath) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error("Backup destination must differ from the source database.");
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);

  assertDatabaseIsHealthy(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const reservation = fs.openSync(destination, "wx", 0o600);
  fs.closeSync(reservation);
  try {
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(sourceDb, destination);
    } finally {
      sourceDb.close();
    }
    fs.chmodSync(destination, 0o600);
    assertDatabaseIsHealthy(destination);
    return destination;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

async function main() {
  const source = path.resolve(process.env.DATABASE_PATH || "data/rentalcar.db");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const destination = process.argv[2]
    ? path.resolve(process.argv[2])
    : `${source}.backup-${stamp}.sqlite`;
  const backupPath = await backupDatabase(source, destination);
  console.log(`Verified SQLite backup: ${backupPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { backupDatabase };
