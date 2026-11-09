// Requests to this plugin's Worker routes. These behave like the SDK's `dashboardApi` (same base, session cookie, JSON body)
// and also keep the `code` and data sources of a refusal, which `dashboardApi` drops, so the form can mark the right field.
import { dashboardApi, dashboardApiBaseUrl } from "@lancerlogin/module-sdk/dashboard";

export type DataSource = { readonly id: string; readonly name: string };
export const setupRoute = "/module-setup/part-requests";
export const adminRoute = "/admin/part-requests";

export class RequestError extends Error {
  readonly status: number; readonly code: string | undefined; readonly dataSources: readonly DataSource[];
  constructor(message: string, status: number, code?: string, dataSources: readonly DataSource[] = []) {
    super(message);
    this.name = "RequestError"; this.status = status; this.code = code; this.dataSources = dataSources;
  }
}

export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export async function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${dashboardApiBaseUrl}${path}`, { method, credentials: "include", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new RequestError("The server could not be reached. Check your connection and try again.", 0); }
  const parsed = await response.json().catch(() => ({})) as T & { error?: string; code?: string; dataSources?: readonly DataSource[] };
  if (!response.ok) throw new RequestError(parsed.error ?? "That did not work. Try again.", response.status, parsed.code, parsed.dataSources ?? []);
  return parsed;
}

/** Tell Core the setup step passed. It opens the module the first time and is harmless afterwards. */
export async function recordSetupStep(): Promise<void> {
  const path = "/admin/modules/part-requests/setup";
  const { generation } = await dashboardApi<{ generation: number }>(path);
  await dashboardApi(path, { method: "PUT", body: JSON.stringify({ generation, stepId: "notion-connection", outcome: "completed" }) });
}
