#!/usr/bin/env node
// Release tooling for this LancerLogin module plugin. It follows LancerLogin Core's release rules.
//
//   check-tag TAG            the checked-out commit is a complete release candidate for TAG (version, notes, changelog)
//   require-verify TAG       TAG's commit is on main and passed the Verify workflow for that exact commit
//   draft TAG                create or refresh TAG's draft release from docs/releases/TAG.md (never a published one)
//   publish TAG [--publish]  maintainer step: recheck everything, require immutable releases, then publish the draft
//   nightly-plan             decide whether main has new verified commits for today's nightly (GITHUB_OUTPUT lines)
//   nightly-publish TAG SHA  publish a testing-only nightly prerelease with generated notes
//
// GitHub access uses the GitHub CLI: GH_TOKEN in Actions, or the maintainer's existing login.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, nightlyBase, nightlyTag, releaseKind } from "./release-policy.mjs";
import { readConfig } from "./verify-with-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitPattern = /^[0-9a-f]{40}$/;
const requiredJobs = ["actionlint", "verify"];
const config = readConfig(root);
const repository = config.repository;

function gh(args) {
  try {
    return execFileSync("gh", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "", GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = String(error.stderr ?? "").trim().split("\n").at(-1) ?? "";
    const failure = new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${detail}`);
    if (/HTTP 404/.test(detail)) failure.status = 404;
    throw failure;
  }
}
const api = (path) => JSON.parse(gh(["api", "-H", "Accept: application/vnd.github+json", `repos/${repository}/${path}`]));
const cliRepo = ["--repo", `github.com/${repository}`];
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const output = (values) => { for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`); };

function stableOrBeta(tag) {
  const kind = releaseKind(tag);
  if (kind === "nightly") throw new Error(`${tag} is a nightly tag; nightly builds are published only by the nightly workflow`);
  if (kind !== "stable" && kind !== "beta") throw new Error(`${tag} is not a canonical vX.Y.Z or vX.Y.Z-beta.N tag`);
  return kind;
}

const notesPath = (tag) => join(root, "docs", "releases", `${tag}.md`);

/** The checked-out commit is a complete release candidate for TAG. */
export function checkTag(tag) {
  stableOrBeta(tag);
  const version = tag.slice(1);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error(`package.json version ${pkg.version} does not match ${tag}`);
  const notes = notesPath(tag);
  if (!existsSync(notes) || statSync(notes).size === 0 || statSync(notes).size > 32_000) throw new Error(`docs/releases/${tag}.md must exist and be at most 32,000 bytes`);
  const heading = readFileSync(notes, "utf8").split("\n")[0].trim();
  if (heading !== `# ${config.title} ${tag}`) throw new Error(`docs/releases/${tag}.md must start with "# ${config.title} ${tag}"`);
  if (!new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(readFileSync(join(root, "CHANGELOG.md"), "utf8"))) throw new Error(`CHANGELOG.md needs a "## [${version}] - YYYY-MM-DD" entry`);
  const subject = git("log", "-1", "--format=%s");
  if (!subject.startsWith(`Release ${tag}`)) throw new Error(`The release commit message must start with "Release ${tag}"`);
  return { tag, version, sha: git("rev-parse", "HEAD") };
}

const trustedRun = (run, sha) => run.head_sha === sha && run.status === "completed" && run.conclusion === "success"
  && (run.event === "push" || run.event === "workflow_dispatch") && run.head_branch === "main" && run.path === ".github/workflows/ci.yml";

/** A successful Verify run of the exact commit on main, with every required job passing, or undefined. */
export function verifiedRun(sha) {
  const runs = api(`actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`).workflow_runs ?? [];
  for (const run of runs.filter((item) => trustedRun(item, sha))) {
    const jobs = api(`actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
    if (requiredJobs.every((name) => jobs.some((job) => job.name === name && job.conclusion === "success"))) return run;
  }
}

/** TAG's commit is on main and passed Verify for that exact commit. */
export function requireVerify(tag) {
  const kind = releaseKind(tag);
  if (!kind) throw new Error(`${tag} is not a canonical release tag`);
  const sha = api(`commits/${encodeURIComponent(tag)}`).sha;
  if (!commitPattern.test(sha ?? "")) throw new Error(`${tag} does not resolve to a commit`);
  const comparison = api(`compare/main...${sha}`);
  if (!["identical", "behind"].includes(comparison.status)) throw new Error(`${tag} (${sha}) is not on main`);
  const run = verifiedRun(sha);
  if (!run) throw new Error(`${tag} (${sha}) has no successful Verify run on main for that exact commit; wait for it, or rerun Verify, before releasing`);
  return { tag, kind, sha, runId: run.id, runUrl: run.html_url };
}

function releaseFor(tag) {
  try { return api(`releases/tags/${encodeURIComponent(tag)}`); } catch (error) { if (error.status !== 404) throw error; }
  // Drafts are not returned by the tag endpoint; authenticated lists include them.
  for (let page = 1; page <= 10; page++) {
    const releases = api(`releases?per_page=100&page=${page}`);
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length > 1) throw new Error(`More than one release uses ${tag}`);
    if (matches.length === 1) return matches[0];
    if (releases.length < 100) return;
  }
  throw new Error("Too many releases to search");
}

function latestStable() {
  try { return api("releases/latest").tag_name; } catch (error) { if (error.status !== 404) throw error; }
}

/** Create or refresh the draft release for a verified tag. A published release is never replaced. */
export function draft(tag) {
  const kind = stableOrBeta(tag);
  const context = requireVerify(tag);
  if (context.sha !== git("rev-parse", "HEAD")) throw new Error(`The checked-out commit is not ${tag}`);
  checkTag(tag);
  const existing = releaseFor(tag);
  if (existing && existing.draft !== true) throw new Error(`${tag} is already published; published releases are never replaced`);
  const title = `${config.title} ${tag}`;
  if (existing) gh(["release", "edit", tag, ...cliRepo, "--draft=true", `--prerelease=${kind === "beta"}`, "--latest=false", "--title", title, "--notes-file", notesPath(tag)]);
  else gh(["release", "create", tag, ...cliRepo, "--draft", "--verify-tag", `--prerelease=${kind === "beta"}`, "--latest=false", "--title", title, "--notes-file", notesPath(tag)]);
  return { ...context, draft: true };
}

/** Maintainer publication: everything is rechecked immediately before the draft is published. */
export function publish(tag, { write = false } = {}) {
  const kind = stableOrBeta(tag);
  const context = requireVerify(tag);
  const immutable = api("immutable-releases");
  if (immutable.enabled !== true) throw new Error("Immutable releases are disabled. Enable them in the repository's Settings > General > Releases before publishing");
  const current = releaseFor(tag);
  if (!current) throw new Error(`No draft release exists for ${tag}; push the tag so the release workflow prepares it`);
  if (current.draft !== true) throw new Error(`${tag} is already published; published releases are never replaced`);
  const source = api(`contents/docs/releases/${encodeURIComponent(tag)}.md?ref=${context.sha}`);
  const notes = Buffer.from(source.content ?? "", "base64").toString("utf8");
  if (!notes || notes.trim() !== String(current.body ?? "").trim()) throw new Error(`The draft's notes differ from docs/releases/${tag}.md at ${context.sha}; rerun the release workflow`);
  if (current.prerelease !== (kind === "beta")) throw new Error(`The draft's prerelease flag does not match a ${kind} release`);
  const latest = latestStable();
  // Stable publication advances Latest only to a higher stable version; beta releases are prereleases and never Latest.
  if (kind === "stable" && latest && compareVersions(tag, latest) !== 1) throw new Error(`Latest is ${latest}; a stable release must be higher to be published`);
  const plan = { ...context, prerelease: kind === "beta", latest: kind === "stable", published: false };
  if (!write) return plan;
  if (api(`commits/${encodeURIComponent(tag)}`).sha !== context.sha) throw new Error(`${tag} moved during publication`);
  gh(["release", "edit", tag, ...cliRepo, "--draft=false", `--prerelease=${plan.prerelease}`, `--latest=${plan.latest}`]);
  const result = releaseFor(tag);
  if (result?.draft !== false || result.prerelease !== plan.prerelease) throw new Error(`${tag} did not publish as expected; check it before any retry`);
  if (result.immutable !== true) throw new Error(`${tag} was published but is not immutable; check the repository's immutable release setting`);
  if (plan.latest && latestStable() !== tag) throw new Error(`${tag} was published but is not Latest; check it before any retry`);
  return { ...plan, published: true, url: result.html_url };
}

/** Whether main has new verified commits for today's nightly. Never publishes. */
export function nightlyPlan(now = new Date()) {
  const sha = git("rev-parse", "HEAD");
  const main = api("commits/main").sha;
  if (main !== sha) return { publish: false, reason: `main moved to ${main} after checkout; the next run will consider it` };
  const run = verifiedRun(sha);
  if (!run) return { publish: false, reason: `main ${sha} has no successful Verify run yet` };
  const tags = git("tag", "--list", "v*").split("\n").filter((tag) => releaseKind(tag));
  const here = git("tag", "--points-at", sha).split("\n").filter((tag) => releaseKind(tag));
  if (here.length) return { publish: false, reason: `main ${sha} is already released as ${here.join(", ")}; no new commits` };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tag = nightlyTag(nightlyBase(pkg.version, tags), now);
  if (tags.includes(tag)) return { publish: false, reason: `${tag} already exists; one nightly is published per day` };
  const previous = tags.sort((a, b) => compareVersions(b, a))[0] ?? "";
  return { publish: true, tag, sha, previous, run: run.html_url };
}

/** Publish a testing-only nightly prerelease with generated notes. */
export function nightlyPublish(tag, sha, { previous = "", runUrl = "" } = {}) {
  if (releaseKind(tag) !== "nightly" || !commitPattern.test(sha)) throw new Error("A nightly tag and full commit SHA are required");
  if (!verifiedRun(sha)) throw new Error(`${sha} has no successful Verify run on main`);
  if (releaseFor(tag)) throw new Error(`${tag} already exists`);
  const range = previous && releaseKind(previous) ? `${previous}..${sha}` : sha;
  const commits = git("log", "--no-merges", "--max-count=200", "--format=- %s (%h)", range);
  const notes = [
    `> **Testing only.** This nightly build of the ${config.title} is for test installations. It is never offered to the Stable or Beta tracks. Select it only with \`npm run plugins:resolve -- --track nightly\` on an installation you can afford to repair.`,
    "",
    `Built automatically from \`main\` at \`${sha}\` after a successful Verify run${runUrl ? ` (${runUrl})` : ""}.`,
    "",
    previous ? `## Changes since ${previous}` : "## Changes",
    "",
    commits || "- No commits listed.",
    "",
  ].join("\n");
  const directory = mkdtempSync(join(tmpdir(), "plugin-nightly-"));
  try {
    const file = join(directory, "notes.md"); writeFileSync(file, notes);
    gh(["release", "create", tag, ...cliRepo, "--target", sha, "--prerelease", "--latest=false", "--title", `${config.title} ${tag} (nightly testing build)`, "--notes-file", file]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const result = releaseFor(tag);
  if (result?.draft !== false || result.prerelease !== true) throw new Error(`${tag} did not publish as a prerelease; check it`);
  if (api(`commits/${encodeURIComponent(tag)}`).sha !== sha) throw new Error(`${tag} does not point at ${sha}; check it`);
  if (result.immutable !== true) throw new Error(`${tag} was published but is not immutable, so LancerLogin's plugins:resolve will ignore it. Enable immutable releases in the repository's Settings > General > Releases`);
  return { tag, sha, url: result.html_url };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "check-tag" && args.length === 1) output(checkTag(args[0]));
    else if (command === "require-verify" && args.length === 1) output(requireVerify(args[0]));
    else if (command === "draft" && args.length === 1) output(draft(args[0]));
    else if (command === "publish" && (args.length === 1 || args.length === 2 && args[1] === "--publish")) console.log(JSON.stringify(publish(args[0], { write: args[1] === "--publish" }), null, 2));
    else if (command === "nightly-plan" && args.length === 0) output(nightlyPlan());
    else if (command === "nightly-publish" && args.length >= 2 && args.length <= 4) output(nightlyPublish(args[0], args[1], { previous: args[2] ?? "", runUrl: args[3] ?? "" }));
    else throw new Error("Use check-tag TAG, require-verify TAG, draft TAG, publish TAG [--publish], nightly-plan or nightly-publish TAG SHA [PREVIOUS] [RUN_URL]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
