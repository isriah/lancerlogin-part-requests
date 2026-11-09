// Worker contribution. Phase 0: the /ordering-pin command, the PIN exchange and one authenticated test route.
// Public routes deliberately do not use requireDashboardOrigin: the browser extension is not on the dashboard origin.
import { defineApiModule, type D1Database, type DiscordModuleInteraction, type ModuleRouteContext } from "@lancerlogin/module-sdk/api";
import { authenticateDevice, deviceRefusedMessage, exchangePin, installationId, issuePin, type Database } from "./pairing.ts";

const database = (db: D1Database) => db as unknown as Database;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function publicRoute(context: ModuleRouteContext<unknown>): Promise<Response | undefined> {
  const { pathname } = context.url;
  if (pathname === "/public/part-requests/pair" && context.request.method === "POST") {
    const input = object(await context.json(1024));
    const { status, ...body } = await exchangePin(database(context.db), input.pin, Date.now());
    return context.respond(body, status);
  }
  // The test route: proves a bearer key and a JSON body arrive together from the extension's service worker.
  if (pathname === "/public/part-requests/ping" && context.request.method === "POST") {
    const device = await authenticateDevice(database(context.db), context.request.headers.get("authorization"));
    if (!device) return context.respond({ error: deviceRefusedMessage, code: "pair_again" }, 401);
    const input = object(await context.json(1024));
    return context.respond({ ok: true, memberName: device.memberName, pairedDevices: device.pairedDevices, echo: typeof input.echo === "string" ? input.echo.slice(0, 200) : null });
  }
  return undefined;
}

const api = defineApiModule({
  moduleId: "part-requests",
  routes: { "/public/part-requests": publicRoute },
  // Core sends the reply as a private (ephemeral) message and has already checked the signature and the server.
  discord: {
    "ordering-pin": (db: D1Database, interaction: DiscordModuleInteraction, now: number) => issuePin(database(db), interaction.member?.user?.id ?? interaction.user?.id, now),
  },
  setup: {
    predicates: { "site-address": (installation: string) => ({ sql: "EXISTS(SELECT 1 FROM part_requests_settings WHERE installation_id=?)", bindings: [installation] }) },
    stepValid: async (db: D1Database, stepId: string) => stepId === "site-address" && Boolean(await db.prepare("SELECT 1 AS present FROM part_requests_settings WHERE installation_id=?").bind(installationId).first()),
  },
  cleanup: {
    steps: [
      { kind: "delete", table: "part_requests_pairing_pins" },
      { kind: "delete", table: "part_requests_devices" },
      { kind: "delete", table: "part_requests_pairing_limits" },
      { kind: "delete", table: "part_requests_settings" },
      { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["part-requests"] },
      { kind: "assignments" },
    ],
  },
  backup: { version: 1, tables: { part_requests_settings: ["installation_id", "site_address", "updated_ms"] } },
});

export default api;
