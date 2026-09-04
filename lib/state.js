// Isolated state store + rotating log under
// $DSH_HOME/plugins-data/dsh-autoupdate/.
//
// Hard isolation rule: this plugin never writes to dsh-owned files
// (settings.yaml, cordis.patch.yml, profile manifests). All persistence is
// confined to this private data directory, so the plugin can never corrupt
// dsh's own configuration, and a broken state file self-heals to defaults.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;
export const STATE_FILE = "state.json";
export const RESULT_FILE = "helper-result.json";
export const LOG_FILE = "autoupdate.log";
export const LOG_MAX_BYTES = 512 * 1024;

/** Resolve the plugin's private data dir ($DSH_HOME/plugins-data/dsh-autoupdate). */
export function resolveDataDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "plugins-data", "dsh-autoupdate");
}

/** Resolve $DSH_HOME itself (same fallback chain as resolveDataDir). */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : join(homedir(), ".dsh");
}

function nowIso() {
  return new Date().toISOString();
}

/** Append-only rotating file logger. Every method is exception-proof. */
export class Log {
  constructor(dir, { maxBytes = LOG_MAX_BYTES } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  path() {
    return join(this.dir, LOG_FILE);
  }

  write(level, msg) {
    try {
      const file = this.path();
      if (existsSync(file) && statSync(file).size > this.maxBytes) {
        const old = `${file}.old`;
        try {
          if (existsSync(old)) unlinkSync(old);
        } catch {}
        try {
          renameSync(file, old);
        } catch {}
      }
      appendFileSync(file, `${nowIso()} [${level}] ${msg}\n`, "utf8");
    } catch {
      // Logging must never break the host.
    }
  }

  info(msg) {
    this.write("info", msg);
  }

  warn(msg) {
    this.write("warn", msg);
  }

  error(msg) {
    this.write("error", msg);
  }
}

export const STATE_DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  /** Degrade ladder: auto (detect + apply) | notify (detect only) | off (silent). */
  level: "auto",
  installedVersion: null,
  pendingVersion: null,
  lastCheckAt: 0,
  lastCheckOk: null,
  lastCheckError: null,
  lastAppliedAt: 0,
  consecutiveFailures: 0,
  lastFailureAt: 0,
  lastFailureError: null,
  /** Armed exit-time helper: { armed, armedAt, targetVersion, fromVersion, parentPid, profiles }. */
  helper: null,
  /** Cached `npm root -g` result. */
  npmRoot: null,
  /** The running dsh's own npm prefix (from process.argv[1]); targets --prefix installs. */
  npmPrefix: null,
};

/** JSON file state store with tolerant loading (corrupt/missing → defaults). */
export class StateStore {
  constructor(dir) {
    this.dir = dir;
    this.data = { ...STATE_DEFAULTS };
  }

  load() {
    try {
      const raw = readFileSync(join(this.dir, STATE_FILE), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.data = { ...STATE_DEFAULTS, ...parsed };
    } catch {
      // Corrupt or missing state → defaults. Self-healing by design.
    }
    return this.data;
  }

  save() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, STATE_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, file);
      return true;
    } catch {
      // Never break the host over state persistence.
      return false;
    }
  }

  mutate(fn) {
    fn(this.data);
    return this.save();
  }
}
