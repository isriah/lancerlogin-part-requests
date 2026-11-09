// Worker contribution. Public routes deliberately do not use requireDashboardOrigin: the browser extension is not on the
// dashboard origin. They authenticate with a device key instead. Admin routes require an Admin and the dashboard's origin.
import { defineApiModule, type D1Database, type DiscordModuleInteraction, type ModuleRouteContext } from "@lancerlogin/module-sdk/api";
import { adminRoute } from "./admin.ts";
import { setupRoute, stepSql, type AdminRouteContext } from "./connection.ts";
import { json, object, refuse } from "./http.ts";
import { authenticateDevice, clientAddress, deviceRefusedMessage, exchangePin, installationId, issuePin, type Database } from "./pairing.ts";
import { refreshRecipients } from "./recipients.ts";
import { checkRepeats, createRequest, readOptions, readRequest, revokeSelf, saveRecipient, type DeviceRequest } from "./requests.ts";

const database = (db: D1Database) => db as unknown as Database;
const prefix = "/public/part-requests";

async function publicRoute(context: ModuleRouteContext<unknown>): Promise<Response | undefined> {
  const { pathname } = context.url;
  const { method } = context.request;
  const db = database(context.db);
  if (pathname === `${prefix}/pair` && method === "POST") {
    const input = object(await context.json(1024));
    const { status, retryAfterSeconds, ...body } = await exchangePin(db, input.pin, Date.now(), { label: input.deviceLabel, address: clientAddress(context.request.headers) }) as { status: number; retryAfterSeconds?: number } & Record<string, unknown>;
    return json({ ...body, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) }, status, retryAfterSeconds);
  }
  // The Phase 0 test route: proves a bearer key and a JSON body arrive together from the extension's service worker.
  if (pathname === `${prefix}/ping` && method === "POST") {
    const device = await authenticateDevice(db, context.request.headers.get("authorization"));
    if (!device) return refuse(401, "pair_again", deviceRefusedMessage);
    const input = object(await context.json(1024));
    return json({ ok: true, memberName: device.memberName, pairedDevices: device.pairedDevices, echo: typeof input.echo === "string" ? input.echo.slice(0, 200) : null });
  }
  const device: DeviceRequest = { db, authorization: context.request.headers.get("authorization"), credentials: context.services.credentials, now: Date.now() };
  if (pathname === `${prefix}/options` && method === "GET") return readOptions(device);
  if (pathname === `${prefix}/devices/self/revoke` && method === "POST") return revokeSelf(device);
  if (pathname === `${prefix}/recipient` && method === "POST") return saveRecipient(device, await context.json(1024));
  if (pathname === `${prefix}/check` && method === "POST") return checkRepeats(device, await context.json(8192));
  if (pathname === `${prefix}/requests` && method === "POST") return createRequest(device, await context.json(32_768));
  if (pathname.startsWith(`${prefix}/requests/`) && method === "GET") return readRequest(device, pathname.slice(`${prefix}/requests/`.length));
  return undefined;
}

const api = defineApiModule({
  moduleId: "part-requests",
  routes: {
    [prefix]: publicRoute,
    "/admin/part-requests": (context: ModuleRouteContext<unknown>) => adminRoute(context as unknown as AdminRouteContext),
    "/module-setup/part-requests": (context: ModuleRouteContext<unknown>) => setupRoute(context as unknown as AdminRouteContext),
  },
  privateResponseRoutes: [prefix, "/admin/part-requests", "/module-setup/part-requests"],
  // Core sends the reply as a private (ephemeral) message and has already checked the signature and the server.
  discord: {
    "ordering-pin": (db: D1Database, interaction: DiscordModuleInteraction, now: number) => issuePin(database(db), interaction.member?.user?.id ?? interaction.user?.id, now),
  },
  jobs: { "part-requests.recipients": (context) => refreshRecipients(context) },
  setup: {
    predicates: { "notion-connection": (installation: string) => ({ sql: stepSql, bindings: [installation, installation] }) },
    stepValid: async (db: D1Database, stepId: string) => stepId === "notion-connection" && Boolean(await db.prepare(`SELECT 1 AS present WHERE ${stepSql}`).bind(installationId, installationId).first()),
  },
  // Append only: Core stores deletion progress by position.
  cleanup: {
    steps: [
      { kind: "delete", table: "part_requests_pairing_pins" },
      { kind: "delete", table: "part_requests_devices" },
      { kind: "delete", table: "part_requests_pairing_limits" },
      { kind: "delete", table: "part_requests_settings" },
      { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["part-requests"] },
      { kind: "assignments" },
      { kind: "delete", table: "part_requests_notion" },
      { kind: "delete", table: "part_requests_submissions" },
      { kind: "delete", table: "part_requests_device_limits" },
      { kind: "delete", table: "part_requests_pairing_address_limits" },
      { kind: "delete", table: "part_requests_recipients" },
      { kind: "delete", table: "part_requests_recipient_refresh" },
      { kind: "delete", table: "part_requests_member_recipients" },
    ],
  },
  backup: { version: 1, tables: { part_requests_settings: ["installation_id", "site_address", "updated_ms"] } },
});

export default api;
