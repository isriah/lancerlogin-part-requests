// Requests to this plugin's Worker routes. These behave like the SDK's `dashboardApi` (same base, session cookie, JSON body)
// and also keep the `code`, data sources and field errors of a refusal, which `dashboardApi` drops, so a form can mark the right field.
import { dashboardApi, dashboardApiBaseUrl } from "@lancerlogin/module-sdk/dashboard";

export type DataSource = { readonly id: string; readonly name: string };
export const setupRoute = "/module-setup/part-requests";
export const adminRoute = "/admin/part-requests";

export class RequestError extends Error {
  readonly status: number; readonly code: string | undefined; readonly dataSources: readonly DataSource[]; readonly errors: Readonly<Record<string, string>> | undefined;
  constructor(message: string, status: number, code?: string, dataSources: readonly DataSource[] = [], errors?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "RequestError"; this.status = status; this.code = code; this.dataSources = dataSources; this.errors = errors;
  }
}

export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export async function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${dashboardApiBaseUrl}${path}`, { method, credentials: "include", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new RequestError("The server could not be reached. Check your connection and try again.", 0); }
  const parsed = await response.json().catch(() => ({})) as T & { error?: string; code?: string; dataSources?: readonly DataSource[]; errors?: Record<string, string> };
  if (!response.ok) throw new RequestError(parsed.error ?? "That did not work. Try again.", response.status, parsed.code, parsed.dataSources ?? [], parsed.errors && typeof parsed.errors === "object" ? parsed.errors : undefined);
  return parsed;
}

/** Tell Core the setup step passed. It opens the module the first time and is harmless afterwards. */
export async function recordSetupStep(): Promise<void> {
  const path = "/admin/modules/part-requests/setup";
  const { generation } = await dashboardApi<{ generation: number }>(path);
  await dashboardApi(path, { method: "PUT", body: JSON.stringify({ generation, stepId: "notion-connection", outcome: "completed" }) });
}
