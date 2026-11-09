// Version rules for this plugin's releases. They mirror LancerLogin Core's packages/shared/src/release-policy.mjs:
// stable vX.Y.Z, beta vX.Y.Z-beta.N and testing-only nightly vX.Y.Z-nightly.YYYYMMDD. The highest version wins, never
// the most recent publication. Within one X.Y.Z, nightly < beta < stable. Nightly builds are never offered to the Stable
// or Beta tracks.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*)|-nightly\.(\d{8}))?$/;

function validDate(value) {
  const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8))];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Parse a version or v-prefixed tag. Nightly versions parse only with { nightly: true }. */
export function parseVersion(value, { nightly = false } = {}) {
  if (typeof value !== "string" || value.length > 80) return;
  const text = value.replace(/^v/, "");
  const match = versionPattern.exec(text);
  if (!match || match[0] !== text) return;
  if (match[5] !== undefined && (!nightly || !validDate(match[5]))) return;
  if (!match.slice(1, 5).filter((part) => part !== undefined).every((part) => Number.isSafeInteger(Number(part)))) return;
  return { parts: match.slice(1, 4).map(BigInt), beta: match[4] === undefined ? undefined : BigInt(match[4]), nightly: match[5] === undefined ? undefined : BigInt(match[5]) };
}

const rank = (version) => version.nightly !== undefined ? [0n, version.nightly] : version.beta !== undefined ? [1n, version.beta] : [2n, 0n];

export function compareVersions(left, right) {
  const a = parseVersion(left, { nightly: true }); const b = parseVersion(right, { nightly: true });
  if (!a || !b) return;
  for (let index = 0; index < 3; index++) if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  const [x, y] = [rank(a), rank(b)];
  for (let index = 0; index < 2; index++) if (x[index] !== y[index]) return x[index] > y[index] ? 1 : -1;
  return 0;
}

/** "stable", "beta" or "nightly" for a canonical v-prefixed tag, otherwise undefined. */
export function releaseKind(tag) {
  const version = typeof tag === "string" && tag.startsWith("v") ? parseVersion(tag, { nightly: true }) : undefined;
  if (!version) return;
  return version.nightly !== undefined ? "nightly" : version.beta !== undefined ? "beta" : "stable";
}

/** The base X.Y.Z of the next nightly: above every stable or beta release, so the Nightly track always offers it. */
export function nightlyBase(packageVersion, releaseTags) {
  const own = parseVersion(packageVersion);
  if (!own) throw new Error(`package.json version ${packageVersion} is not a stable or beta version`);
  const released = releaseTags.filter((tag) => ["stable", "beta"].includes(releaseKind(tag))).sort((a, b) => compareVersions(b, a))[0];
  const base = own.parts;
  if (!released) return base.join(".");
  const highest = parseVersion(released).parts;
  for (let index = 0; index < 3; index++) if (base[index] !== highest[index]) return base[index] > highest[index] ? base.join(".") : [highest[0], highest[1], highest[2] + 1n].join(".");
  return [highest[0], highest[1], highest[2] + 1n].join(".");
}

/** The nightly tag for a UTC date. */
export function nightlyTag(base, date = new Date()) {
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  const tag = `v${base}-nightly.${stamp}`;
  if (releaseKind(tag) !== "nightly") throw new Error(`Invalid nightly tag ${tag}`);
  return tag;
}
