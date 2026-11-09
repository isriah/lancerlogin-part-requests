// Small helpers shared by the route files. Every refusal has the same shape: { error, code, ...details }.

export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A JSON response with a Retry-After header when asked, which Core's `respond` cannot set. */
export function json(body: unknown, status = 200, retryAfterSeconds?: number): Response {
  return Response.json(body, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }) } });
}

export const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}, retryAfterSeconds?: number) =>
  json({ error, code, ...extra, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) }, status, retryAfterSeconds);
