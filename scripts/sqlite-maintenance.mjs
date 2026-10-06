import { mkdirSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [operation, source, destination] = process.argv.slice(2);
if (!operation || !source) throw new Error("Usage: sqlite-maintenance.mjs <backup|verify> <database> [destination]");

function verify(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get();
    if (row.integrity_check !== "ok") throw new Error(`Integrity check failed: ${row.integrity_check}`);
  } finally {
    database.close();
  }
}

if (operation === "verify") {
  verify(source);
  process.stdout.write(`Verified: ${source}\n`);
} else if (operation === "backup") {
  if (!destination) throw new Error("A backup destination is required.");
  mkdirSync(path.dirname(destination), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
  verify(destination);
  process.stdout.write(`Backup verified: ${destination}\n`);
} else {
  throw new Error(`Unknown operation: ${operation}`);
}
