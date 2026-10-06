import { mkdirSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import { getConfig } from "./config.js";

export type QueryResultRow = Record<string, unknown>;
export type QueryResult<T extends QueryResultRow = QueryResultRow> = { rows: T[]; rowCount: number };

export type DatabaseClient = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};

export type Database = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<DatabaseClient>;
  close(): void;
  end(): Promise<void>;
  backup(destination: string): Promise<void>;
};

const jsonColumns = new Set(["value", "metadata"]);

function sqliteValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function translate(text: string, values: unknown[]) {
  const parameters: Array<string | number | bigint | null | Uint8Array> = [];
  let sql = text.replace(/\$(\d+)(?:::[A-Za-z0-9_\[\]]+)?/g, (_match, rawIndex: string) => {
    parameters.push(sqliteValue(values[Number(rawIndex) - 1]));
    return "?";
  });
  sql = sql
    .replace(/::(?:int|integer|text|jsonb|numeric|bigint|boolean|timestamptz)(?:\[\])?/gi, "")
    .replace(/\s+ILIKE\s+/gi, " LIKE ")
    .replace(/\s+FOR\s+UPDATE\b/gi, "");
  return { sql, parameters };
}

function normalizeRows<T extends QueryResultRow>(rows: QueryResultRow[]): T[] {
  return rows.map((source) => {
    const row: QueryResultRow = { ...source };
    for (const column of jsonColumns) {
      const value = row[column];
      if (typeof value === "string") {
        try { row[column] = JSON.parse(value); } catch { /* Preserve non-JSON text. */ }
      }
    }
    return row as T;
  });
}

export function createDatabase(filename: string): Database {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename, { timeout: 5_000 });
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  sqlite.function("NOW", { deterministic: false }, () => new Date().toISOString());

  const client: DatabaseClient = {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
      const { sql, parameters } = translate(text, values);
      const statement: StatementSync = sqlite.prepare(sql);
      const rows = statement.all(...parameters) as QueryResultRow[];
      return { rows: normalizeRows<T>(rows), rowCount: rows.length };
    },
    release() { /* A single embedded connection is shared by the process. */ },
  };

  return {
    query: client.query,
    async connect() { return client; },
    close() { sqlite.close(); },
    async end() { sqlite.close(); },
    async backup(destination: string) {
      mkdirSync(path.dirname(destination), { recursive: true });
      await backup(sqlite, destination);
    },
  };
}

let sharedDatabase: Database | null = null;

export function getPool(): Database {
  if (!sharedDatabase) sharedDatabase = createDatabase(getConfig().DATABASE_FILE);
  return sharedDatabase;
}

const transactionQueues = new WeakMap<Database, Promise<void>>();

export async function withTransaction<T>(db: Database, callback: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const previous = transactionQueues.get(db) ?? Promise.resolve();
  let unlock!: () => void;
  const lock = new Promise<void>(resolve => { unlock = resolve; });
  transactionQueues.set(db, previous.then(() => lock));
  await previous;
  const client = await db.connect();
  try {
    await client.query("BEGIN IMMEDIATE");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* The original error is more useful. */ }
    throw error;
  } finally {
    client.release();
    unlock();
  }
}

export async function one<T extends QueryResultRow>(client: Pick<DatabaseClient, "query"> | Database, text: string, values: unknown[] = []): Promise<T> {
  const result = await client.query<T>(text, values);
  if (result.rows.length !== 1) throw new Error(`Expected exactly one row, received ${result.rows.length}.`);
  return result.rows[0];
}
