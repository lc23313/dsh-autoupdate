// Sandboxed process execution + install/verify/rollback primitives.
//
// Every external command (npm, node) runs with a hard timeout, captured
// output, and never throws — failures are returned as values. On Windows,
// .cmd shims must go through a shell (Node >= 18 refuses bare .cmd
// spawning), so args are shell-quoted; other platforms pass through.
//
// Install targeting: the plugin resolves the RUNNING dsh's own install
// prefix via process.argv[1] (ground truth, zero processes spawned) and
// passes it to npm via --prefix — so the update lands in the exact npm
// root the user's dsh lives in, regardless of which npm happens to be
// first on PATH.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const IS_WIN = process.platform === "win32";
const OUTPUT_CAP = 65536;
const VERSION_RE = /\d+\.\d+\.\d+[-0-9A-Za-z.+]*/;

/** Quote one argument for cmd.exe when it contains shell metacharacters. */
function quoteWinArg(arg) {
  const s = String(arg);
  if (!/[\s"&()^|<>%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function killTree(child) {
  try {
    if (IS_WIN && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}

/**
 * Run a command to completion under a timeout. Never throws.
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean }}
 */
export function runCommand(cmd, args = [], { timeoutMs = 120000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      if (IS_WIN && !/\.exe$/i.test(cmd)) {
        const line = [cmd, ...args].map(quoteWinArg).join(" ");
        child = spawn(line, {
          shell: true,
          cwd,
          env: env ?? process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        child = spawn(cmd, args, {
          cwd,
          env: env ?? process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: `spawn failed: ${error?.message ?? error}`,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: (stderr || `timed out after ${timeoutMs}ms`).slice(0, 2000),
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    child.on("error", (e) =>
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n${e.message}`.trim(), timedOut: false }),
    );
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr, timedOut: false }));
  });
}

/** Read the version field of a package.json at `dir`, or null. */
export function readPackageVersion(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the RUNNING dsh install from this process's own entry script
 * (process.argv[1] = <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js).
 * This is ground truth: it names the exact installation the user launched,
 * whatever `npm root -g` may report. Returns null when we are not running
 * inside a dsh CLI process (e.g. unit tests).
 */
export function resolveRunningDsh(entry = process.argv[1]) {
  try {
    if (!entry) return null;
    const p = realpathSync(resolve(entry));
    // <prefix>[/lib]/node_modules/@deepseek-ai/dsh/<bin-or-lib>/…/<entry>
    let pkgDir = dirname(p);
    let manifest;
    for (;;) {
      try {
        manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
        if (manifest.name === "@deepseek-ai/dsh") break;
      } catch {}
      const parent = dirname(pkgDir);
      if (parent === pkgDir) return null;
      pkgDir = parent;
    }
    const root = dirname(dirname(pkgDir)); // …/node_modules
    const prefix = basename(root) === "node_modules" && basename(dirname(pkgDir)) === "@deepseek-ai"
      ? prefixFromGlobalRoot(root) : null;
    return {
      packageDir: pkgDir,
      version: typeof manifest.version === "string" ? manifest.version : null,
      nodeModulesRoot: root,
      prefix,
      binEntry: manifest.bin?.dsh ? join(pkgDir, manifest.bin.dsh) : null,
    };
  } catch {
    return null;
  }
}

/** npm's global layout differs between Windows and POSIX. */
export function prefixFromGlobalRoot(root, platform = process.platform) {
  const parent = dirname(root);
  return platform === "win32" ? parent : basename(parent) === "lib" ? dirname(parent) : null;
}

export function globalDshDir(prefix, platform = process.platform) {
  return join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "@deepseek-ai", "dsh");
}

/** Locate the global node_modules root via `npm root -g`, or null. */
export async function npmRootGlobal(npmCommand = "npm", timeoutMs = 30000) {
  const r = await runCommand(npmCommand, ["root", "-g"], { timeoutMs });
  const line = r.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
  return r.ok && line ? line : null;
}

/**
 * Determine the installed dsh version with layered fallbacks:
 *   1. the running dsh's own manifest (authoritative)
 *   2. `dsh --version` (works regardless of install layout)
 *   3. `<npm root -g>/@deepseek-ai/dsh` manifest (may be a different
 *      install than the running one — informational last resort)
 * @returns {{ version: string|null, via: string, prefix: string|null, npmRoot: string|null }}
 */
export async function currentDshVersion({
  npmCommand = "npm",
  dshCommand = "dsh",
  cachedRoot = null,
  timeoutMs = 30000,
} = {}) {
  const running = resolveRunningDsh();
  if (running?.version) {
    return { version: running.version, via: "running-manifest", prefix: running.prefix, npmRoot: running.nodeModulesRoot };
  }
  const root = cachedRoot ?? (await npmRootGlobal(npmCommand, timeoutMs));
  const r = await runCommand(dshCommand, ["--version"], { timeoutMs });
  const m = r.stdout.match(VERSION_RE);
  if (r.ok && m) return { version: m[0], via: "dsh --version", prefix: null, npmRoot: root };
  if (root) {
    const v = readPackageVersion(join(root, "@deepseek-ai", "dsh"));
    if (v) return { version: v, via: "npm-root-manifest", prefix: null, npmRoot: root };
  }
  return { version: null, via: "none", prefix: null, npmRoot: root };
}

/**
 * Install an exact dsh version into a specific npm prefix. Pinning the exact
 * resolved version (rather than a dist-tag) closes the TOCTOU window between
 * check and apply; pinning the prefix guarantees the update replaces the
 * installation the user actually runs.
 */
export async function installGlobalDsh(
  version,
  { npmCommand = "npm", timeoutMs = 300000, registry = "", prefix = "" } = {},
) {
  const args = ["install", "-g", `@deepseek-ai/dsh@${version}`, "--no-fund", "--no-audit"];
  if (prefix) args.push("--prefix", prefix);
  if (registry) args.push("--registry", registry);
  return runCommand(npmCommand, args, { timeoutMs });
}

/**
 * Verify an installation at `prefix`: the manifest must carry the expected
 * version, and — when a bin is declared — running `node <bin> --version`
 * must succeed and print it. Deterministic: no PATH lookup involved.
 */
export async function verifyDshInstall(prefix, expectedVersion, { timeoutMs = 30000 } = {}) {
  try {
    const pkgDir = globalDshDir(prefix);
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (manifest.version !== expectedVersion) {
      return { ok: false, reason: `manifest version is ${manifest.version}, expected ${expectedVersion}` };
    }
    const binRel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
    if (!binRel) return { ok: false, reason: "dsh bin entry missing" };
    const r = await runCommand(process.execPath, [join(pkgDir, binRel), "--version"], { timeoutMs });
    const m = r.stdout.match(VERSION_RE);
    if (!r.ok || !m || m[0] !== expectedVersion) {
      return { ok: false, reason: `bin check failed: exit=${r.code} stdout=${JSON.stringify(r.stdout.trim().slice(0, 80))}` };
    }
    return { ok: true, reason: "manifest + bin verified" };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** Query `dsh --version` (PATH resolution) and extract the version string, or null. */
export async function queryDshVersion(dshCommand = "dsh", timeoutMs = 30000) {
  const r = await runCommand(dshCommand, ["--version"], { timeoutMs });
  const m = r.stdout.match(VERSION_RE);
  return r.ok && m ? m[0] : null;
}
