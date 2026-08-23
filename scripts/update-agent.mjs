#!/usr/bin/env node
// Exit-time update agent for dsh-autoupdate.
//
// Spawned detached by the plugin at arm time; polls until the arming dsh
// process exits (so Windows file locks on the global npm install release),
// then runs the guarded update transaction:
//
//   re-confirm arm ─▶ npm install -g @deepseek-ai/dsh@<exact> (retry ×3)
//                   ─▶ verify via `dsh --version`
//                   ─▶ on mismatch/failure: reinstall previous version (rollback)
//                   ─▶ optionally refresh profile plugins (`dsh plugin --profile <p> update`
//                      with manifest backup/restore)
//                   ─▶ write helper-result.json + update state.json
//
// Self-contained by design: imports only Node built-ins, no dependency on the
// plugin's lib/ code — an already-armed update completes correctly even if
// the plugin source is broken or has been replaced by an incompatible dsh.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const IS_WIN = process.platform === "win32";
const PKG = "@deepseek-ai/dsh";
const VERSION_RE = /\d+\.\d+\.\d+[-0-9A-Za-z.+]*/;

// ---- args ----
const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const stateDir = argValue("--state-dir");
const dshHome = argValue("--dsh-home") || join(homedir(), ".dsh");
const parentPid = Number(argValue("--parent-pid") ?? 0);
const target = argValue("--target");
const from = argValue("--from");
const npmCmd = argValue("--npm") || "npm";
const dshCmd = argValue("--dsh") || "dsh";
const installTimeout = Number(argValue("--install-timeout") ?? 300000);
const registry = argValue("--registry") || "";
const prefix = argValue("--prefix") || "";
const updateProfiles = (argValue("--update-profiles") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RESULT_FILE = join(stateDir ?? ".", "helper-result.json");
const STATE_FILE = join(stateDir ?? ".", "state.json");

function fail(message, code = 2) {
  try {
    console.error(`[dsh-autoupdate-agent] ${message}`);
  } catch {}
  process.exit(code);
}

if (!stateDir || !target || !from || !parentPid) {
  fail("missing required args (--state-dir/--target/--from/--parent-pid)");
}

// ---- tolerant JSON io ----
function writeJsonAtomic(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {}
    renameSync(tmp, file);
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function result(patch) {
  writeJsonAtomic(RESULT_FILE, {
    at: Date.now(),
    parentPid,
    from,
    to: target,
    ...patch,
  });
}

function mutateState(fn) {
  const data = readJson(STATE_FILE) ?? {};
  fn(data);
  writeJsonAtomic(STATE_FILE, data);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- process execution (same sandboxing rules as lib/install.js) ----
function quoteWinArg(arg) {
  const s = String(arg);
  if (!/[\s"&()^|<>%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function killTree(child) {
  try {
    if (IS_WIN && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let child;
    try {
      if (IS_WIN) {
        const line = [cmd, ...args].map(quoteWinArg).join(" ");
        child = spawn(line, {
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: `spawn failed: ${error?.message ?? error}` });
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
      finish({ ok: false, code: null, stdout, stderr: (stderr || "timed out").slice(0, 2000) });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (stdout.length < 65536) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < 65536) stderr += d.toString();
    });
    child.on("error", (e) => finish({ ok: false, code: null, stdout, stderr: `${stderr}\n${e.message}`.trim() }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

const tail = (s) =>
  String(s ?? "")
    .trim()
    .replace(/\r?\n/g, " | ")
    .slice(-300);

async function npmInstallGlobal(version) {
  const args = ["install", "-g", `${PKG}@${version}`, "--no-fund", "--no-audit"];
  if (prefix) args.push("--prefix", prefix);
  if (registry) args.push("--registry", registry);
  return run(npmCmd, args, installTimeout);
}

/**
 * Verify the install at the prefix: manifest version must match, and the
 * declared bin must actually run (`node <bin> --version`) and print it.
 * Deterministic — no PATH lookup, so it checks exactly what we installed.
 */
async function verifyInstall(expectedVersion) {
  const targetPrefix = prefix || null;
  try {
    const pkgDir = targetPrefix
      ? join(targetPrefix, "node_modules", "@deepseek-ai", "dsh")
      : null;
    if (!pkgDir || !existsSync(join(pkgDir, "package.json"))) {
      // No prefix pin: fall back to PATH `dsh --version`.
      const v = await dshVersion();
      return v === expectedVersion ? { ok: true, detail: "dsh --version" } : { ok: false, detail: `dsh --version says ${v}` };
    }
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (manifest.version !== expectedVersion) {
      return { ok: false, detail: `manifest version is ${manifest.version}` };
    }
    const binRel = manifest.bin && manifest.bin.dsh;
    if (!binRel) return { ok: true, detail: "manifest verified" };
    const r = await run(process.execPath, [join(pkgDir, binRel), "--version"], 30000);
    const m = r.stdout.match(VERSION_RE);
    if (!r.ok || !m || m[0] !== expectedVersion) {
      return { ok: false, detail: `bin check: exit=${r.code} stdout=${JSON.stringify(r.stdout.trim().slice(0, 80))}` };
    }
    return { ok: true, detail: "manifest + bin verified" };
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
}

async function dshVersion() {
  for (let i = 0; i < 3; i++) {
    const r = await run(dshCmd, ["--version"], 30000);
    const m = r.stdout.match(VERSION_RE);
    if (m) return m[0];
    await sleep(3000);
  }
  return null;
}

async function waitParentExit(pid, maxMs = 60 * 60 * 1000) {
  const start = Date.now();
  for (;;) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) return true;
    if (Date.now() - start > maxMs) return false;
    await sleep(500);
  }
}

async function refreshProfiles() {
  const res = { ok: true, profiles: [], error: null };
  const backupRoot = join(stateDir, "backups");
  for (const profile of updateProfiles) {
    const dir = join(dshHome, "profiles", profile);
    if (!existsSync(dir)) {
      res.ok = false;
      res.error = `profile dir missing: ${profile}`;
      continue;
    }
    // Backup manifests so a failed pnpm update can be rolled back.
    const backupDir = join(backupRoot, `${profile}-${Date.now()}`);
    const saved = [];
    try {
      mkdirSync(backupDir, { recursive: true });
    } catch {}
    for (const f of ["package.json", "pnpm-lock.yaml"]) {
      const src = join(dir, f);
      if (existsSync(src)) {
        try {
          copyFileSync(src, join(backupDir, f));
          saved.push(f);
        } catch {}
      }
    }
    const r = await run(dshCmd, ["plugin", "--profile", profile, "update"], installTimeout);
    if (!r.ok) {
      for (const f of saved) {
        try {
          copyFileSync(join(backupDir, f), join(dir, f));
        } catch {}
      }
      // Resync node_modules against the restored manifests.
      await run(dshCmd, ["plugin", "--profile", profile, "install"], installTimeout);
      res.ok = false;
      res.error = `pnpm update failed for profile "${profile}" (${tail(r.stderr || r.stdout)}); manifests restored from backup`;
      continue;
    }
    res.profiles.push(profile);
  }
  return res;
}

// ---- main transaction ----
result({ phase: "waiting" });
const exited = await waitParentExit(parentPid);
if (!exited) {
  result({ phase: "failed", error: "parent dsh process still alive after wait budget; aborting to avoid file-lock corruption" });
  fail("parent still alive", 2);
}

// Re-confirm the arm: the plugin may have re-armed to a newer target, or
// cancelled, while we were waiting.
const state = readJson(STATE_FILE);
if (!state?.helper?.armed || state.helper.targetVersion !== target) {
  result({ phase: "aborted", reason: "state no longer armed for this target (superseded or cancelled)" });
  process.exit(0);
}

// Small grace period for the OS to finish releasing file handles.
await sleep(2000);

result({ phase: "installing" });
let install = await npmInstallGlobal(target);
for (let attempt = 1; attempt <= 2 && !install.ok; attempt++) {
  // Retry: another dsh instance may have been holding locks and exited since.
  await sleep(10000 * attempt);
  install = await npmInstallGlobal(target);
}
if (!install.ok) {
  // npm usually leaves the previous install intact; verify and restore if not.
  const intact = await verifyInstall(from);
  if (!intact.ok) {
    await npmInstallGlobal(from);
    const back = await verifyInstall(from);
    result({ phase: "rolled-back", error: `install failed (${tail(install.stderr)}); previous version restored (${back.ok ? "verified" : "unverified"})` });
  } else {
    result({ phase: "failed", error: `install failed: ${tail(install.stderr)}` });
  }
  process.exit(0);
}

result({ phase: "verifying" });
const verify = await verifyInstall(target);
if (!verify.ok) {
  await npmInstallGlobal(from);
  const back = await verifyInstall(from);
  result({
    phase: "rolled-back",
    error: `verification failed (${verify.detail}); previous version ${back.ok ? "restored and verified" : "restore unverified"}`,
  });
  process.exit(0);
}

let profileUpdate = null;
if (updateProfiles.length > 0) {
  result({ phase: "profiles" });
  profileUpdate = await refreshProfiles();
}

mutateState((s) => {
  s.installedVersion = target;
  s.pendingVersion = null;
  s.lastAppliedAt = Date.now();
  s.helper = null;
  s.consecutiveFailures = 0;
  s.lastFailureAt = 0;
  s.lastFailureError = null;
  if (s.level !== "auto") s.level = "auto";
});
result({ phase: "done", profileUpdate });
process.exit(0);
