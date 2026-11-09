// Calls the plugin's routes the way Core does. The database reproduces Core's scoped database as far as cost goes: reads
// started in one tick share one batch, and every batch or lone statement counts as one D1 query.
import { createTestDatabase, type TestDatabase } from "./d1.ts";
import { dataSourceId, databaseId, memberPerson, testToken } from "./notion-stub.ts";
import type { Credentials } from "../../src/connection.ts";
import { exchangePin, issuePin, type Database, type Statement } from "../../src/pairing.ts";

export const dashboard = "https://site.example.test";
export const discordA = "100000000000000001";
export const discordB = "100000000000000002";

export class StatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Core's real AES-GCM, with a throwaway key, so a stored token is really ciphertext. */
export function testCredentials(available = true): Credentials {
  const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const encode = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString("base64url");
  return {
    available,
    async encrypt(value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return { ciphertext: encode(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, new TextEncoder().encode(JSON.stringify(value)))), iv: encode(iv) };
    },
    async decrypt(ciphertext, iv) {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url") }, await key, Buffer.from(ciphertext, "base64url"));
      return JSON.parse(new TextDecoder().decode(plain));
    },
  };
}

/** Core's read coalescing and query counting. `failing` makes matching statements throw, to test a D1 failure. */
export function coreDatabase(test: TestDatabase) {
  const state = { queries: 0, failing: undefined as RegExp | undefined };
  const originals = new WeakMap<object, any>();
  let queue: { statement: any; resolve: (result: any) => void; reject: (error: unknown) => void }[] | undefined;
  const flush = (items: NonNullable<typeof queue>) => {
    state.queries++;
    for (const item of items) { try { item.resolve(item.statement.execute()); } catch (error) { item.reject(error); } }
  };
  const read = (statement: any) => new Promise<any>((resolve, reject) => {
    if (!queue) { const items: NonNullable<typeof queue> = queue = []; queueMicrotask(() => { queue = undefined; flush(items); }); }
    queue.push({ statement, resolve, reject });
  });
  function wrap(original: any, sql: string): Statement {
    const reads = /^\s*(SELECT|WITH)\b/i.test(sql);
    const check = () => { if (state.failing?.test(sql)) throw new Error("D1_ERROR: simulated"); };
    const statement: Statement = {
      bind: (...values: unknown[]) => wrap(original.bind(...values), sql),
      async first<T>() { check(); if (reads) return ((await read(original)).results[0] as T) ?? null; state.queries++; return await original.first() as T; },
      async all<T>() { check(); if (reads) return await read(original) as { results?: T[] }; state.queries++; return await original.all(); },
      async run() { check(); state.queries++; return original.run(); },
    };
    originals.set(statement, { original, check });
    return statement;
  }
  const db: Database = {
    prepare: (sql: string) => wrap(test.prepare(sql), sql),
    async batch(statements: Statement[]) {
      state.queries++;
      const items = statements.map((statement) => originals.get(statement));
      for (const item of items) item.check();
      return test.batch(items.map((item) => item.original));
    },
  };
  return { db, state };
}

export type Harness = ReturnType<typeof createHarness>;

export function createHarness(api: any, options: { readonly credentials?: Credentials } = {}) {
  const test = createTestDatabase();
  test.sqlite.exec("CREATE TABLE audit_log(id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,actor_user_id TEXT,action TEXT NOT NULL,target_type TEXT,target_id TEXT,metadata_json TEXT,created_at TEXT NOT NULL)");
  test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-a','primary','9001','Test Student','A','student.a@example.test',?)", discordA);
  test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-b','primary','9002','Test Student','B','student.b@example.test',?)", discordB);
  const { db, state } = coreDatabase(test);
  const credentials = options.credentials ?? testCredentials();

  async function call(method: string, path: string, init: { body?: unknown; key?: string; role?: "admin" | "operator" | null; origin?: string; headers?: Record<string, string> } = {}) {
    const url = new URL(`https://worker.example.test${path}`);
    const family = ["/public/part-requests", "/admin/part-requests", "/module-setup/part-requests"].find((prefix) => url.pathname.startsWith(prefix))!;
    const request = new Request(url, { method, headers: { ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.origin ? { origin: init.origin } : {}), ...init.headers } });
    const role = init.role === undefined ? "admin" : init.role;
    const context = {
      request, url, db, services: { credentials }, dashboardOrigin: dashboard,
      respond: (body: unknown, status = 200) => Response.json(body, { status }),
      json: async () => init.body,
      body: async () => init.body,
      async requireRole(roles: readonly string[]) {
        if (!role) throw new StatusError(401, "Sign in");
        if (!roles.includes(role)) throw new StatusError(403, "Your role cannot perform this action");
        return { userId: "u-admin", role };
      },
      requireDashboardOrigin(message: string) { if (init.origin !== dashboard) throw new StatusError(403, message); },
    };
    let result: Response | undefined;
    try { result = await api.routes[family](context); }
    catch (error) { if (error instanceof StatusError) result = Response.json({ error: error.message }, { status: error.status }); else throw error; }
    if (!result) return { status: 404, body: undefined as any, text: "", headers: new Headers() };
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : undefined, text, headers: result.headers };
  }

  const admin = (method: string, path: string, body?: unknown) => call(method, `/module-setup/part-requests${path}`, { body, origin: dashboard });

  /** Runs the real setup routes against the Notion stub. */
  async function connect() {
    const token = await admin("PUT", "/token", { token: testToken });
    if (token.status !== 200) throw new Error(`token ${token.text}`);
    const connection = await admin("POST", "/connection", { databaseUrl: `https://app.notion.com/p/${databaseId.replaceAll("-", "")}?v=99999999999999999999999999999999`, dataSourceId });
    if (connection.status !== 200) throw new Error(`connection ${connection.text}`);
    // The person goodDraft names, as the refresh job would have found them.
    test.run("INSERT OR IGNORE INTO part_requests_recipients(installation_id,notion_user_id,name,last_seen_ms) VALUES ('primary',?,'Test Member',?)", memberPerson, Date.now());
  }

  /** The real command and exchange, with a real clock so route timestamps line up. */
  async function pair(discordId = discordA, label?: string) {
    const reply = await issuePin(db, discordId, Date.now());
    const pin = /\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\*/.exec(reply)?.[1];
    if (!pin) throw new Error(reply);
    const result = await exchangePin(db, pin, Date.now(), { label });
    if (result.status !== 201) throw new Error(result.error);
    return result.deviceKey;
  }

  /** The refresh job until it stops, as the scheduler would run it. */
  async function runJob(steps = true, limit = 60) {
    const outcomes: any[] = [];
    for (let run = 0; run < limit; run++) {
      const outcome = await api.jobs["part-requests.recipients"]({ db, services: { credentials }, scheduler: { steps } });
      outcomes.push(outcome);
      if (!outcome?.more) break;
    }
    return outcomes;
  }

  return { test, db, state, credentials, call, admin, connect, pair, runJob };
}

export const goodDraft = (overrides: Record<string, unknown> = {}) => ({
  description: "Test bracket", status: "NORMAL Request", url: "https://www.revrobotics.com/rev-41-1600/", sku: "REV-41-1600",
  team: "team-1", recipient: memberPerson, quantity: 2, price: 12.5, currencyConfirmed: true, ...overrides,
});
