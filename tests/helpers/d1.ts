// A small D1-shaped adapter over Node's built-in node:sqlite, in memory: prepare, bind, first, all, run and an atomic batch.
// It applies the plugin's real migrations after minimal stand-ins for Core's `installations` and `members` tables, with
// foreign keys enforced as D1 enforces them. Modelled on Guest Visits' test helper.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;
const returning = /\bRETURNING\b/i;
const reads = /^\s*(SELECT|WITH)\b/i;

class TestStatement {
  readonly db: DatabaseSync; readonly sql: string; readonly values: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, values: SQLInputValue[] = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: unknown[]) {
    if (values.some((value) => value === undefined)) throw new TypeError("D1 does not bind undefined");
    return new TestStatement(this.db, this.sql, values as SQLInputValue[]);
  }
  async first<T = Row>(): Promise<T | null> { return (this.execute().results[0] as T | undefined) ?? null; }
  async all<T = Row>() { return this.execute() as { results: T[]; meta: { changes: number } }; }
  async run() { return this.execute(); }
  execute(): { results: Row[]; meta: { changes: number } } {
    const statement = this.db.prepare(this.sql);
    if (returning.test(this.sql) || reads.test(this.sql)) {
      const results = statement.all(...this.values).map((row) => ({ ...(row as Row) }));
      return { results, meta: { changes: reads.test(this.sql) ? 0 : results.length } };
    }
    return { results: [], meta: { changes: Number(statement.run(...this.values).changes) } };
  }
}

export class TestDatabase {
  readonly sqlite: DatabaseSync;
  constructor(sqlite: DatabaseSync) { this.sqlite = sqlite; }
  prepare(sql: string) { return new TestStatement(this.sqlite, sql); }
  /** Run statements in one transaction, as a D1 batch does: all of them apply, or none. */
  async batch(statements: TestStatement[]) {
    this.sqlite.exec("BEGIN");
    try { const results = statements.map((statement) => statement.execute()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  rows<T = Row>(sql: string, ...values: SQLInputValue[]) { return this.sqlite.prepare(sql).all(...values) as T[]; }
  run(sql: string, ...values: SQLInputValue[]) { this.sqlite.prepare(sql).run(...values); }
}

const migrations = new URL("../../migrations/", import.meta.url);

/** A fresh database with Core stand-ins and every plugin migration applied, each in its own transaction as Core does. */
export function createTestDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  sqlite.exec(`
    CREATE TABLE installations (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, external_id TEXT NOT NULL,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, discord_user_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '2026-01-01');
    INSERT INTO installations(id) VALUES ('primary');
  `);
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec("BEGIN");
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    sqlite.exec("COMMIT");
  }
  return new TestDatabase(sqlite);
}
