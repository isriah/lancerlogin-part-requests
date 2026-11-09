#!/usr/bin/env node
// Verify this plugin commit composed into a pinned LancerLogin Core checkout.
//
//   node scripts/verify-with-core.mjs core-pin                         print the pinned Core repository, commit and tag
//   node scripts/verify-with-core.mjs --core <dir> [--mode acceptance|fast]
//
// The Core commit is pinned in .github/plugin-release.json as a full commit SHA; the release tag beside it is recorded
// for people. Verification composes this exact commit into the Core checkout as an installation build would (Core's
// official plugins included), using Core's own composer, which validates the package, manifest, API contribution,
// migrations and peer dependencies. It then typechecks the composed Worker and dashboard and, in acceptance mode, builds
// them. Core's generated files are restored afterwards, whether or not verification passed.
//
// Core and its official plugins are public, so no token is needed. LANCERLOGIN_PLUGIN_TOKEN is passed through only when
// set, for a Core that composes private plugin repositories.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseVersion } from "./release-policy.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const typecheckWorkspaces = ["@lancerlogin/shared", "@lancerlogin/api", "@lancerlogin/dashboard"];
const buildWorkspaces = ["@lancerlogin/api", "@lancerlogin/dashboard"];

export function readConfig(root = pluginRoot) {
  const config = JSON.parse(readFileSync(join(root, ".github", "plugin-release.json"), "utf8"));
  if (!repositoryPattern.test(config.repository ?? "") || typeof config.title !== "string" || !config.title.trim()) throw new Error(".github/plugin-release.json needs repository and title");
  if (!repositoryPattern.test(config.core?.repository ?? "") || !commitPattern.test(config.core?.commit ?? "")) throw new Error(".github/plugin-release.json core must name a repository and a full 40-character commit SHA");
  if (config.core.tag !== undefined && (typeof config.core.tag !== "string" || !/^v[0-9A-Za-z.-]+$/.test(config.core.tag))) throw new Error(".github/plugin-release.json core.tag must be a v-prefixed release tag when present");
  return config;
}

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

function run(cwd, label, command, args, env = process.env) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed`);
}

// npm through Node itself, so no shell is involved on any platform.
function npm(cwd, label, args, env) {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const cli = candidates.find((candidate) => candidate && candidate.endsWith(".js") && existsSync(candidate));
  if (cli) return run(cwd, label, process.execPath, [cli, ...args], env);
  if (process.platform === "win32") throw new Error("Cannot locate npm's JavaScript entrypoint");
  return run(cwd, label, "npm", args, env);
}

function verify({ core, mode }) {
  const config = readConfig();
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  const moduleId = pkg.lancerlogin?.moduleId;
  if (typeof moduleId !== "string" || !/^[a-z][a-z0-9-]*$/.test(moduleId)) throw new Error("package.json lancerlogin.moduleId is missing");
  if (!parseVersion(pkg.version)) throw new Error(`package.json version ${pkg.version} must be X.Y.Z or X.Y.Z-beta.N`);
  const coreRoot = resolve(core);
  if (!existsSync(join(coreRoot, "scripts", "compose-modules.mjs")) || !existsSync(join(coreRoot, "packages", "module-sdk", "package.json"))) throw new Error(`${coreRoot} is not a LancerLogin Core checkout with module plugin support`);
  if (!existsSync(join(coreRoot, "node_modules"))) throw new Error(`Run npm ci in ${coreRoot} first`);
  const commit = git(pluginRoot, "rev-parse", "HEAD");
  if (git(pluginRoot, "status", "--porcelain", "--untracked-files=no")) throw new Error("Commit or discard changes first: verification composes the committed plugin, not the working tree");
  const coreCommit = existsSync(join(coreRoot, ".git")) ? git(coreRoot, "rev-parse", "HEAD") : undefined;
  const pinned = `${config.core.commit}${config.core.tag ? ` (${config.core.tag})` : ""}`;
  if (coreCommit !== config.core.commit) {
    const message = `Core checkout is at ${coreCommit ?? "an unknown commit"}, not the pinned ${pinned}`;
    if (process.env.CI) throw new Error(message);
    console.warn(`Warning: ${message}. Results apply to that Core commit only.`);
  }
  console.log(`Verifying ${moduleId} ${pkg.version} at ${commit} against Core ${config.core.repository} ${coreCommit === config.core.commit ? pinned : coreCommit ?? "(unknown)"} (${mode})`);

  const env = { ...process.env };
  if (!env.LANCERLOGIN_PLUGIN_TOKEN) delete env.LANCERLOGIN_PLUGIN_TOKEN;
  const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-plugin-verify-"));
  const selection = join(scratch, "lancerlogin.modules.json");
  // The same selection an installation would list, except that the source is this local checkout at its exact commit.
  writeFileSync(selection, `${JSON.stringify({ format: 1, modules: [{ id: moduleId, source: pathToFileURL(pluginRoot).href, commit }] }, null, 2)}\n`);
  const compose = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(coreRoot, "scripts", "compose-modules.mjs")];
  try {
    run(coreRoot, `Compose ${moduleId} with Core's official plugins`, process.execPath, [...compose, "--selection", selection, "--test-allow-file-sources"], env);
    npm(coreRoot, "Typecheck the composed Worker and dashboard", ["run", "typecheck", ...typecheckWorkspaces.flatMap((workspace) => ["--workspace", workspace])], env);
    if (mode === "acceptance") npm(coreRoot, "Build the composed Worker and dashboard", ["run", "build", ...buildWorkspaces.flatMap((workspace) => ["--workspace", workspace])], env);
  } finally {
    run(coreRoot, "Restore Core's plugin-free generated files", process.execPath, [...compose, "--restore"], env);
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${moduleId} ${commit} passed the ${mode} verification against Core.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "core-pin" && args.length === 1) {
      const { core } = readConfig();
      console.log(`repository=${core.repository}`); console.log(`commit=${core.commit}`); console.log(`tag=${core.tag ?? ""}`);
    } else {
      const options = { mode: "acceptance" };
      for (let index = 0; index < args.length; index++) {
        const value = () => { const next = args[++index]; if (!next) throw new Error(`${args[index - 1]} needs a value`); return next; };
        if (args[index] === "--core") options.core = value();
        else if (args[index] === "--mode") options.mode = value();
        else throw new Error(`Unknown argument ${args[index]}`);
      }
      if (!options.core || !["acceptance", "fast"].includes(options.mode)) throw new Error("Usage: node scripts/verify-with-core.mjs core-pin | --core <dir> [--mode acceptance|fast]");
      verify(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
