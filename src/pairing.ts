// Pairing rules and queries. Every function takes the database and the time, so tests run them without Core. PINs and
// device keys follow Guest Visits' manage-link tokens: random values, SHA-256 at rest, one refusal message for every reason.
// A PIN is short because a person types it, so it depends on its 10-minute life, single use and the wrong-PIN pause.

export const installationId = "primary";
export const pinLifetimeMs = 10 * 60_000;
export const maximumDevicesPerMember = 5;
/** Wrong PINs allowed across the installation in one window before pairing pauses for everybody. */
export const maximumWrongPins = 20;
export const wrongPinWindowMs = 10 * 60_000;
export const pairingPauseMs = 15 * 60_000;

/** Letters and digits that are hard to confuse when read from Discord: no 0, O, 1, I or L. */
export const pinAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const pinPattern = new RegExp(`^[${pinAlphabet}]{8}$`);

export const pinRefusedMessage = "That PIN does not work. Run /ordering-pin in Discord to get a new one.";
export const pairingPausedMessage = "Pairing is paused because of repeated wrong PINs. Try again later.";
export const deviceLimitMessage = `You already have ${maximumDevicesPerMember} paired devices, the most allowed. Ask an Admin to remove a device, then run /ordering-pin again.`;
export const deviceRefusedMessage = "This device is no longer paired. Run /ordering-pin in Discord and pair it again.";
export const notLinkedMessage = "Your Discord account is not linked to a roster member. Use /pair with your member ID, or ask an Operator to link it, then run /ordering-pin again.";
export const notActiveMessage = "You are not on the active roster, so you cannot pair a device. Ask an Operator if this is wrong.";

export type Statement = { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results?: T[] }>; run(): Promise<{ meta?: { changes?: number } }> };
export type Database = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ results?: unknown[]; meta?: { changes?: number } }[]> };
type Random = (bytes: Uint8Array) => Uint8Array;
const systemRandom: Random = (bytes) => crypto.getRandomValues(bytes);

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Eight characters from the alphabet, chosen without bias. */
export function generatePin(random: Random = systemRandom): string {
  const limit = 256 - (256 % pinAlphabet.length);
  let pin = "";
  while (pin.length < 8) for (const byte of random(new Uint8Array(16))) if (byte < limit && pin.length < 8) pin += pinAlphabet[byte % pinAlphabet.length];
  return pin;
}

/** The PIN as a person reads it: K7M2-9QXP. */
export const formatPin = (pin: string) => `${pin.slice(0, 4)}-${pin.slice(4)}`;

/** The stored and compared form of what someone typed, or undefined when it cannot be a PIN. Case, spaces and the hyphen do not matter. */
export function normalizePin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const pin = value.toUpperCase().replace(/[\s-]/g, "");
  return pinPattern.test(pin) ? pin : undefined;
}

/** 32 random bytes in unpadded base64url. */
export function generateDeviceKey(random: Random = systemRandom): string {
  let binary = "";
  for (const byte of random(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The device key in an `Authorization: Bearer` header, or undefined. Check the shape before hashing anything a request sent. */
export function bearerDeviceKey(header: string | null): string | undefined {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
}

const openDeviceCount = "(SELECT COUNT(*) FROM part_requests_devices d WHERE d.installation_id=? AND d.member_id=? AND d.revoked_ms IS NULL)";

/** The private reply to /ordering-pin. Never throws for a person's situation: the reply says what to do. */
export async function issuePin(db: Database, discordUserId: unknown, now: number, random: Random = systemRandom): Promise<string> {
  if (typeof discordUserId !== "string" || !/^\d{10,24}$/.test(discordUserId)) return notLinkedMessage;
  const linked = (await db.prepare("SELECT id,active FROM members WHERE installation_id=? AND discord_user_id=? LIMIT 2").bind(installationId, discordUserId).all<{ id: string; active: number }>()).results ?? [];
  if (!linked.length) return notLinkedMessage;
  if (linked.length !== 1) return "Your Discord account is linked to more than one roster member. Ask an Operator to fix your roster link.";
  const member = linked[0]!;
  if (member.active !== 1) return notActiveMessage;
  const [settings, devices] = await Promise.all([
    db.prepare("SELECT site_address AS siteAddress FROM part_requests_settings WHERE installation_id=?").bind(installationId).first<{ siteAddress: string }>(),
    db.prepare(`SELECT ${openDeviceCount} AS count`).bind(installationId, member.id).first<{ count: number }>(),
  ]);
  if (!settings) return "Part Requests is not set up yet. Ask an Admin to finish its setup.";
  const paired = Number(devices?.count ?? 0);
  if (paired >= maximumDevicesPerMember) return deviceLimitMessage;
  const pin = generatePin(random);
  const results = await db.batch([
    db.prepare("DELETE FROM part_requests_pairing_pins WHERE installation_id=? AND member_id=? AND expires_ms<?").bind(installationId, member.id, now - 86_400_000),
    db.prepare("UPDATE part_requests_pairing_pins SET cancelled_ms=? WHERE installation_id=? AND member_id=? AND used_ms IS NULL AND cancelled_ms IS NULL").bind(now, installationId, member.id),
    db.prepare(`INSERT INTO part_requests_pairing_pins(installation_id,pin_hash,member_id,created_ms,expires_ms)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=? AND active=1) AND ${openDeviceCount}<?`)
      .bind(installationId, await sha256Hex(pin), member.id, now, now + pinLifetimeMs, installationId, member.id, installationId, member.id, maximumDevicesPerMember),
  ]);
  if (results[2]?.meta?.changes !== 1) return "Your paired devices changed while this PIN was being made. Run /ordering-pin again.";
  return [
    `Your Part Requests PIN is **${formatPin(pin)}**. It works once and expires in 10 minutes.`,
    `Site address: ${settings.siteAddress}`,
    "Enter both in the browser extension. Any earlier unused PIN no longer works.",
    paired ? `You have ${paired} of ${maximumDevicesPerMember} devices paired, and they stay paired.` : "",
  ].filter(Boolean).join("\n");
}

export type ExchangeResult =
  | { readonly status: 201; readonly deviceKey: string; readonly memberName: string }
  | { readonly status: 400 | 401 | 409 | 429; readonly error: string; readonly code: string; readonly retryAfterSeconds?: number };

const paused = (until: number, now: number): ExchangeResult => ({ status: 429, error: pairingPausedMessage, code: "pairing_paused", retryAfterSeconds: Math.ceil((until - now) / 1000) });

/** Exchange a PIN for a new device key. The PIN's use and the device row commit together or not at all. */
export async function exchangePin(db: Database, submitted: unknown, now: number, random: Random = systemRandom): Promise<ExchangeResult> {
  const limits = await db.prepare("SELECT paused_until_ms AS pausedUntil FROM part_requests_pairing_limits WHERE installation_id=?").bind(installationId).first<{ pausedUntil: number }>();
  if (limits && limits.pausedUntil > now) return paused(limits.pausedUntil, now);
  const pin = normalizePin(submitted);
  // A typing mistake that cannot be a PIN tests nothing, so it does not count towards the pause.
  if (!pin) return { status: 400, error: "Enter the 8-character PIN from Discord.", code: "pin_malformed" };
  const pinHash = await sha256Hex(pin);
  const deviceId = crypto.randomUUID();
  const deviceKey = generateDeviceKey(random);
  const memberLive = "EXISTS(SELECT 1 FROM members m WHERE m.installation_id=part_requests_pairing_pins.installation_id AND m.id=part_requests_pairing_pins.member_id AND m.active=1)";
  const deviceCount = "(SELECT COUNT(*) FROM part_requests_devices d WHERE d.installation_id=part_requests_pairing_pins.installation_id AND d.member_id=part_requests_pairing_pins.member_id AND d.revoked_ms IS NULL)";
  const results = await db.batch([
    db.prepare(`UPDATE part_requests_pairing_pins SET used_ms=?,device_id=? WHERE installation_id=? AND pin_hash=? AND used_ms IS NULL AND cancelled_ms IS NULL AND expires_ms>? AND ${memberLive} AND ${deviceCount}<?`)
      .bind(now, deviceId, installationId, pinHash, now, maximumDevicesPerMember),
    db.prepare("INSERT INTO part_requests_devices(installation_id,id,key_hash,member_id,created_ms) SELECT installation_id,?,?,member_id,? FROM part_requests_pairing_pins WHERE installation_id=? AND pin_hash=? AND device_id=?")
      .bind(deviceId, await sha256Hex(deviceKey), now, installationId, pinHash, deviceId),
  ]);
  if (results[0]?.meta?.changes === 1) {
    const member = await db.prepare("SELECT m.first_name AS firstName,m.last_name AS lastName FROM part_requests_devices d JOIN members m ON m.installation_id=d.installation_id AND m.id=d.member_id WHERE d.installation_id=? AND d.id=?").bind(installationId, deviceId).first<{ firstName: string; lastName: string }>();
    return { status: 201, deviceKey, memberName: `${member?.firstName ?? ""} ${member?.lastName ?? ""}`.trim() };
  }
  // Only the holder of a live PIN can get this answer, so it tells a guesser nothing.
  const full = await db.prepare(`SELECT 1 AS full FROM part_requests_pairing_pins WHERE installation_id=? AND pin_hash=? AND used_ms IS NULL AND cancelled_ms IS NULL AND expires_ms>? AND ${memberLive} AND ${deviceCount}>=?`)
    .bind(installationId, pinHash, now, maximumDevicesPerMember).first();
  if (full) return { status: 409, error: deviceLimitMessage, code: "device_limit" };
  const pausedUntil = await recordWrongPin(db, now);
  return pausedUntil > now ? paused(pausedUntil, now) : { status: 401, error: pinRefusedMessage, code: "pin_refused" };
}

/** Count one wrong PIN atomically, so parallel guesses cannot all read the same count. Returns when pairing is paused until. */
export async function recordWrongPin(db: Database, now: number): Promise<number> {
  const row = await db.prepare(`INSERT INTO part_requests_pairing_limits(installation_id,window_start_ms,failures,paused_until_ms) VALUES (?1,?2,1,0)
    ON CONFLICT(installation_id) DO UPDATE SET
      paused_until_ms=CASE WHEN window_start_ms<=?3 THEN 0 WHEN failures+1>=?4 THEN ?5 ELSE paused_until_ms END,
      failures=CASE WHEN window_start_ms<=?3 THEN 1 ELSE failures+1 END,
      window_start_ms=CASE WHEN window_start_ms<=?3 THEN ?2 ELSE window_start_ms END
    RETURNING paused_until_ms AS pausedUntil`)
    .bind(installationId, now, now - wrongPinWindowMs, maximumWrongPins, now + pairingPauseMs).first<{ pausedUntil: number }>();
  return Number(row?.pausedUntil ?? 0);
}

export type AuthenticatedDevice = { readonly deviceId: string; readonly memberId: string; readonly memberName: string; readonly pairedDevices: number };

/**
 * The device and member behind a bearer key, or null. The same read checks the key, that the device is not revoked and
 * that the member is on the active roster right now, so leaving the roster ends every device of that member.
 */
export async function authenticateDevice(db: Database, authorization: string | null): Promise<AuthenticatedDevice | null> {
  const key = bearerDeviceKey(authorization);
  if (!key) return null;
  const row = await db.prepare(`SELECT d.id AS deviceId,d.member_id AS memberId,m.first_name AS firstName,m.last_name AS lastName,
      (SELECT COUNT(*) FROM part_requests_devices o WHERE o.installation_id=d.installation_id AND o.member_id=d.member_id AND o.revoked_ms IS NULL) AS pairedDevices
    FROM part_requests_devices d JOIN members m ON m.installation_id=d.installation_id AND m.id=d.member_id AND m.active=1
    WHERE d.installation_id=? AND d.key_hash=? AND d.revoked_ms IS NULL`).bind(installationId, await sha256Hex(key)).first<{ deviceId: string; memberId: string; firstName: string; lastName: string; pairedDevices: number }>();
  return row && { deviceId: row.deviceId, memberId: row.memberId, memberName: `${row.firstName} ${row.lastName}`.trim(), pairedDevices: Number(row.pairedDevices) };
}
