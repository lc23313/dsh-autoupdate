// AutoUpdater — the orchestrator. Runs inside every booted dsh profile as a
// cordis plugin:
//
//   boot ──▶ consume helper result ──▶ schedule check (delay + interval)
//   check ─▶ installed version ─▶ dist-tags ─▶ newer?
//             └─ no: reset breaker
//             └─ yes + auto: arm exit-time helper (detached, survives SIGKILL)
//             └─ yes + manual: notify with the one-line install command
//
// Anti-breaking rules obeyed here (see docs/COMPATIBILITY.zh.md):
//   - no dsh service is injected or called; only the cordis plugin contract
//   - every callback is exception-proof; the host can never be crashed
//   - own timers (tracked + unref'd), no dependency on dsh's timer plugin
//   - state/logs confined to the plugin's private data directory
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as semver from "./semver.js";
import { fetchDistTags } from "./registry.js";
import { currentDshVersion, npmRootGlobal, readPackageVersion } from "./install.js";
import { createGuard } from "./guard.js";
import { Log, RESULT_FILE, StateStore, resolveDataDir, resolveDshHome } from "./state.js";

export const PKG = "@deepseek-ai/dsh";
export const PLUGIN_NAME = "dsh-autoupdate";
const HELPER_PATH = fileURLToPath(new URL("../scripts/update-agent.mjs", import.meta.url));
const STALE_HELPER_MS = 6 * 60 * 60 * 1000;

export const CONFIG_DEFAULTS = {
  enabled: true,
  /** npm dist-tag to track: "latest", "rc", or any published tag. */
  channel: "latest",
  /** false = detect + notify only (the manual-update mode). */
  autoApply: true,
  checkIntervalMs: 6 * 60 * 60 * 1000,
  startupDelayMs: 30 * 1000,
  maxConsecutiveFailures: 3,
  cooldownMs: 24 * 60 * 60 * 1000,
  npmTimeoutMs: 30 * 1000,
  installTimeoutMs: 5 * 60 * 1000,
  npmCommand: "npm",
  dshCommand: "dsh",
  registry: "",
  /** After a successful CLI update, refresh user plugins in these profiles via `dsh plugin --profile <p> update`. */
  updateProfilePlugins: true,
  /** Explicit profile list; empty = auto-detect profiles that depend on this plugin. */
  profiles: [],
  logToConsole: true,
};

/** Merge user config over defaults with numeric clamping. Never throws. */
export function normalizeConfig(raw = {}) {
  const c = { ...CONFIG_DEFAULTS };
  try {
    for (const k of Object.keys(CONFIG_DEFAULTS)) {
      if (raw?.[k] !== undefined && raw?.[k] !== null) c[k] = raw[k];
    }
  } catch {}
  c.checkIntervalMs = Math.max(5 * 60 * 1000, Number(c.checkIntervalMs) || 0);
  c.startupDelayMs = Math.max(0, Number(c.startupDelayMs) || 0);
  c.maxConsecutiveFailures = Math.max(1, Math.trunc(Number(c.maxConsecutiveFailures) || 3));
  c.cooldownMs = Math.max(0, Number(c.cooldownMs) || 0);
  c.npmTimeoutMs = Math.max(5000, Number(c.npmTimeoutMs) || 30000);
  c.installTimeoutMs = Math.max(30000, Number(c.installTimeoutMs) || 300000);
  if (!Array.isArray(c.profiles)) c.profiles = [];
  return c;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Pick a usable logger from the context without assuming any cordis API shape. */
function pickLogger(ctx) {
  const l = safe(() => ctx?.logger);
  if (l && typeof l.info === "function" && typeof l.warn === "function") return l;
  return { info() {}, warn() {}, error() {} };
}

function onCtxDispose(ctx, fn) {
  const ok = safe(() => typeof ctx?.on === "function");
  if (ok) {
    safe(() => ctx.on("dispose", () => safe(fn)));
    return;
  }
  process.once("exit", () => safe(fn));
}

export class AutoUpdater {
  constructor(ctx, rawConfig) {
    this.ctx = ctx;
    this.config = normalizeConfig(rawConfig);
    this.dataDir = resolveDataDir();
    this.state = new StateStore(this.dataDir);
    this.logFile = new Log(this.dataDir);
    this.logger = pickLogger(ctx);
    this.timers = new Set();
    this.stopped = false;
    this._checking = false;
    this.guard = null;
  }

  // ---- logging: file always, cordis console when available ----
  info(msg) {
    this.logFile.info(msg);
    if (this.config.logToConsole) safe(() => this.logger.info(`[${PLUGIN_NAME}] ${msg}`));
  }

  warn(msg) {
    this.logFile.warn(msg);
    if (this.config.logToConsole) safe(() => this.logger.warn(`[${PLUGIN_NAME}] ${msg}`));
  }

  error(msg) {
    this.logFile.error(msg);
    if (this.config.logToConsole) safe(() => this.logger.error(`[${PLUGIN_NAME}] ${msg}`));
  }

  // ---- lifecycle ----
  start() {
    if (!this.config.enabled) {
      this.info("disabled by config; plugin is a no-op");
      return;
    }
    safe(() => mkdirSync(this.dataDir, { recursive: true }));
    this.state.load();
    this.guard = createGuard(this.state, this.config, { warn: (m) => this.warn(m) });
    this.info(
      `started (level=${this.state.data.level}, dsh=${this.state.data.installedVersion ?? "?"}, channel="${this.config.channel}", node ${process.version})`,
    );
    safe(() => this.consumeHelperResult());
    safe(() => this.staleHelperSweep());
    if (safe(() => process.env.DSH_AUTOUPDATE_DOCTOR) === "1") safe(() => this.doctor());
    this.schedule(this.config.startupDelayMs, () => this.checkNow("startup"));
    this.schedule(this.config.checkIntervalMs, () => this.checkNow("interval"), { repeat: true });
    onCtxDispose(this.ctx, () => this.dispose());
  }

  schedule(delayMs, fn, { repeat = false } = {}) {
    const wrapped = () => {
      safe(() => {
        Promise.resolve(fn()).catch(() => {});
      });
    };
    const t =
      repeat === true
        ? setInterval(wrapped, Math.max(1000, delayMs))
        : setTimeout(wrapped, Math.max(0, delayMs));
    if (typeof t.unref === "function") t.unref();
    this.timers.add(t);
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) {
      safe(() => clearInterval(t));
      safe(() => clearTimeout(t));
    }
    this.timers.clear();
    // The exit-time helper (if armed) was spawned detached at arm time and
    // waits for this process to exit by polling — nothing to do here but
    // stop our own timers.
    this.info("disposed");
  }

  // ---- check pipeline ----
  async checkNow(reason) {
    if (this.stopped || this._checking) return;
    if (!this.guard.canCheck()) return;
    this._checking = true;
    try {
      await this._check(reason);
    } catch (e) {
      this.error(`check failed: ${e?.stack ?? e}`);
      this.guard.recordFailure(e, "check");
    } finally {
      this._checking = false;
    }
  }

  async _check(reason) {
    const cur = await currentDshVersion({
      npmCommand: this.config.npmCommand,
      dshCommand: this.config.dshCommand,
      cachedRoot: this.state.data.npmRoot,
      timeoutMs: this.config.npmTimeoutMs,
    });
    if (!cur.version) {
      throw new Error("cannot determine installed dsh version (running-manifest / dsh --version / npm root -g all failed)");
    }
    this.state.mutate((d) => {
      d.npmRoot = cur.npmRoot ?? d.npmRoot;
      d.npmPrefix = cur.prefix ?? d.npmPrefix ?? null;
      d.installedVersion = cur.version;
    });

    let tags;
    try {
      tags = await fetchDistTags(PKG, {
        npmCommand: this.config.npmCommand,
        timeoutMs: this.config.npmTimeoutMs,
        registry: this.config.registry,
      });
    } catch (e) {
      this.state.mutate((d) => {
        d.lastCheckOk = false;
        d.lastCheckError = String(e?.message ?? e).slice(0, 300);
      });
      throw e; // network/registry problem: counted as a check failure by caller
    }
    this.state.mutate((d) => {
      d.lastCheckAt = Date.now();
      d.lastCheckOk = true;
      d.lastCheckError = null;
    });

    const target = tags[this.config.channel] ?? tags.latest ?? null;
    if (!target || !semver.valid(target)) {
      throw new Error(`registry returned unusable version for channel "${this.config.channel}": ${JSON.stringify(target)}`);
    }

    if (!semver.gt(target, cur.version)) {
      this.state.mutate((d) => {
        d.pendingVersion = null;
      });
      this.guard.recordSuccess();
      this.info(`up to date (${cur.version}, channel "${this.config.channel}", reason=${reason})`);
      return;
    }

    this.state.mutate((d) => {
      d.pendingVersion = target;
    });
    if (this.config.autoApply && this.guard.canAutoApply()) {
      await this.armHelper(cur.version, target);
    } else {
      this.notifyAvailable(cur.version, target);
    }
  }

  notifyAvailable(from, to) {
    const blocked = this.config.autoApply
      ? ` (auto-apply blocked: level=${this.state.data.level}${this.guard.inCooldown() ? ", cooldown active" : ""})`
      : "";
    this.info(
      `new version available: ${to} (current ${from})${blocked} — manual command: npm install -g ${PKG}@${to}`,
    );
  }

  // ---- exit-time update arming ----
  async armHelper(fromVersion, targetVersion) {
    const existing = this.state.data.helper;
    if (existing?.armed) {
      if (existing.targetVersion === targetVersion) {
        this.info(`helper already armed for ${targetVersion}; keeping the existing arm`);
        return;
      }
      // A newer target appeared: overwrite the arm. The old helper aborts
      // itself when it sees the state no longer matches its own target.
      this.info(`re-arming helper: ${existing.targetVersion} → ${targetVersion}`);
    }
    const profiles = await this.detectProfiles();
    this.state.mutate((d) => {
      d.helper = {
        armed: true,
        armedAt: Date.now(),
        targetVersion,
        fromVersion,
        parentPid: process.pid,
        profiles,
      };
    });
    const args = [
      "--state-dir",
      this.dataDir,
      "--dsh-home",
      resolveDshHome(),
      "--parent-pid",
      String(process.pid),
      "--target",
      targetVersion,
      "--from",
      fromVersion,
      "--npm",
      this.config.npmCommand,
      "--dsh",
      this.config.dshCommand,
      "--install-timeout",
      String(this.config.installTimeoutMs),
    ];
    const prefix = this.state.data.npmPrefix;
    if (prefix) args.push("--prefix", prefix);
    if (this.config.registry) args.push("--registry", this.config.registry);
    if (profiles.length > 0 && this.config.updateProfilePlugins) args.push("--update-profiles", profiles.join(","));
    try {
      const child = spawn(process.execPath, [HELPER_PATH, ...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      this.info(
        `update armed: ${fromVersion} → ${targetVersion}; helper pid=${child.pid} applies it after this dsh process exits` +
          (profiles.length ? ` (profiles to refresh: ${profiles.join(", ")})` : ""),
      );
    } catch (e) {
      this.error(`failed to spawn update helper: ${e?.message ?? e}`);
      this.state.mutate((d) => {
        d.helper = null;
      });
      this.guard.recordFailure(e, "apply");
    }
  }

  /** Profiles depending on this plugin (or the explicit config list). */
  async detectProfiles() {
    if (Array.isArray(this.config.profiles) && this.config.profiles.length > 0) {
      return this.config.profiles.filter(Boolean).map(String);
    }
    const out = [];
    safe(() => {
      const dir = join(resolveDshHome(), "profiles");
      for (const name of readdirSync(dir)) {
        const manifest = safe(() => JSON.parse(readFileSync(join(dir, name, "package.json"), "utf8")));
        const deps = safe(() => ({ ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }));
        if (deps && PLUGIN_NAME in deps) out.push(name);
      }
    });
    return out;
  }

  // ---- helper result bookkeeping ----
  consumeHelperResult() {
    const file = join(this.dataDir, RESULT_FILE);
    if (!existsSync(file)) return;
    let res = null;
    try {
      res = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.warn("unreadable helper result file; discarding it");
    }
    safe(() => unlinkSync(file));
    if (!res || typeof res !== "object") return;

    this.info(`helper result: ${JSON.stringify(res)}`);
    if (res.phase === "done") {
      this.state.mutate((d) => {
        d.installedVersion = typeof res.to === "string" ? res.to : d.installedVersion;
        d.pendingVersion = null;
        d.lastAppliedAt = typeof res.at === "number" ? res.at : Date.now();
        d.helper = null;
      });
      this.guard.recordSuccess();
      const p = res.profileUpdate;
      const profileNote =
        p?.ok === true
          ? `; profile plugins refreshed (${(p.profiles ?? []).join(", ")})`
          : p
            ? `; profile refresh failed: ${p.error ?? "unknown"} (CLI update itself succeeded)`
            : "";
      this.info(`dsh updated ${res.from} → ${res.to} and verified${profileNote}`);
    } else if (res.phase === "rolled-back") {
      this.state.mutate((d) => {
        d.helper = null;
        d.pendingVersion = null;
      });
      this.guard.recordFailure(new Error(`update rolled back: ${res.error ?? "verification failed"}`), "apply");
      this.warn(`update to ${res.to} failed (${res.error ?? "verification failed"}); rolled back to ${res.from}`);
    } else if (res.phase === "failed") {
      this.state.mutate((d) => {
        d.helper = null;
      });
      this.guard.recordFailure(new Error(res.error ?? "helper failed"), "apply");
      this.error(`update failed: ${res.error ?? "unknown error"}`);
    }
    // "waiting"/"installing"/"verifying"/"aborted": nothing durable to bookkeep.
  }

  staleHelperSweep() {
    const h = this.state.data.helper;
    if (!h?.armed) return;
    if (Date.now() - (h.armedAt ?? 0) > STALE_HELPER_MS) {
      this.warn("clearing stale armed helper (armed long ago, no result seen)");
      this.state.mutate((d) => {
        d.helper = null;
      });
    }
  }

  // ---- diagnostics ----
  async doctor() {
    const lines = [`node ${process.version}`, `platform ${process.platform}`];
    const root = await npmRootGlobal(this.config.npmCommand, this.config.npmTimeoutMs);
    lines.push(`npm root -g: ${root ?? "unavailable"}`);
    lines.push(`installed dsh: ${root ? (readPackageVersion(join(root, "@deepseek-ai", "dsh")) ?? "?") : "?"}`);
    try {
      const tags = await fetchDistTags(PKG, {
        npmCommand: this.config.npmCommand,
        timeoutMs: this.config.npmTimeoutMs,
        registry: this.config.registry,
      });
      lines.push(`dist-tags: ${JSON.stringify(tags)}`);
    } catch (e) {
      lines.push(`dist-tags: unavailable (${e?.message ?? e})`);
    }
    lines.push(`data dir: ${this.dataDir}`);
    lines.push(`helper script present: ${existsSync(HELPER_PATH)}`);
    this.info(`doctor: ${lines.join(" | ")}`);
  }
}
