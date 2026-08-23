#!/usr/bin/env node
// Offline smoke test for dsh-autoupdate.
//
// Loads the plugin with a mock cordis Context into a TEMP $DSH_HOME, runs one
// real detection cycle against the npm registry (read-only), and prints the
// resulting state + log. Safe by construction: autoApply is forced off, so no
// helper is ever spawned and nothing is installed.
//
// Usage: node scripts/dev-smoke.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-autoupdate-smoke-"));
process.env.DSH_HOME = home;

const { name, apply } = await import("../lib/index.js");

const logs = [];
const ctx = {
  logger: {
    info: (...a) => logs.push(["info", a.join(" ")]),
    warn: (...a) => logs.push(["warn", a.join(" ")]),
    error: (...a) => logs.push(["error", a.join(" ")]),
  },
  on(event, cb) {
    if (event === "dispose") this._dispose = cb;
  },
};

await apply(ctx, {
  enabled: true,
  autoApply: false, // smoke test never arms the update helper
  autoCheck: true, // v1.1.0: explicitly exercise the periodic-check path
  startupDelayMs: 200,
  checkIntervalMs: 3600000,
  logToConsole: true,
});

// Give the startup check (spawn npm view etc.) time to complete.
await new Promise((r) => setTimeout(r, 20000));

try {
  ctx._dispose?.();
} catch {}

let pass = true;
const state = JSON.parse(readFileSync(join(home, "plugins-data", "dsh-autoupdate", "state.json"), "utf8"));
const log = readFileSync(join(home, "plugins-data", "dsh-autoupdate", "autoupdate.log"), "utf8");

console.log("=== plugin name ===");
console.log(name);
console.log("\n=== state.json ===");
console.log(JSON.stringify(state, null, 2));
console.log("\n=== autoupdate.log ===");
console.log(log);

if (name !== "dsh-autoupdate") pass = false;
if (!state.lastCheckAt) {
  console.error("SMOKE FAIL: no check completed (lastCheckAt is unset)");
  pass = false;
}
if (!state.installedVersion) {
  console.error("SMOKE FAIL: installedVersion not determined");
  pass = false;
}
console.log(pass ? "\nSMOKE PASS" : "\nSMOKE FAIL");

try {
  rmSync(home, { recursive: true, force: true });
} catch {}
process.exit(pass ? 0 : 1);
