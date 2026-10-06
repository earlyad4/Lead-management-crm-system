import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./db.js";
import { getPool } from "./db.js";

export async function runMigrations(db: Database = getPool()): Promise<string[]> {
  const migrationsDirectory = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  const applied: string[] = [];

  for (const name of files) {
    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await db.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name = $1", [name]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Migration ${name} was modified after being applied.`);
      continue;
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN IMMEDIATE");
      for (const statement of sql.split("-- statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
        await client.query(statement);
      }
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await db.query("PRAGMA optimize");
  return applied;
}

// The basename guard matters when this module is bundled into the production
// gateway: a plain import.meta.url comparison would mistake the bundle entry
// point for the migration CLI and terminate the server after migrating.
const migrationCliEntry=process.argv[1]&&/^migrate\.(?:ts|js|mjs)$/.test(path.basename(process.argv[1]));
if (migrationCliEntry && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations().then(async (applied) => {
    process.stdout.write(applied.length ? `Applied migrations: ${applied.join(", ")}\n` : "Database is up to date.\n");
    await getPool().end();
  }).catch(async (error) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    try { await getPool().end(); } catch { /* Preserve the migration failure. */ }
    process.exitCode = 1;
  });
}
