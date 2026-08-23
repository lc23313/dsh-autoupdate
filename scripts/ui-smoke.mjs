#!/usr/bin/env node
// Offline smoke test for the v1.1.0 UI halves.
//
// Verifies, without any dsh host:
//   A. lib/client.js registers into the ModuleLoader, and its apply() injects
//      a settings.section slot entry carrying our component
//   B. the section component renders an element tree with mock React props
//      (t missing, t throwing — fallback dictionaries kick in)
//   C. lib/channel.js handler: status/check/apply endpoints + error paths
//
// Usage: node scripts/ui-smoke.mjs
import assert from "node:assert/strict";

// Simulate a zh-CN browser so the component picks the Chinese dictionary
// (the real dsh web UI runs in a browser). Assertions below still accept the
// English fallback, so the test stays green in bare Node runners (CI) too.
Object.defineProperty(globalThis, "navigator", {
  value: { language: "zh-CN" },
  configurable: true,
});
const TITLE_RE = /检查更新|Check for Updates/;

let failures = 0;
const step = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}: ${e?.message ?? e}`);
  }
};

// ---------- A. client module registration ----------
const registered = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registered.set(id, factory);
    },
  },
};

await import("../lib/client.js");

let factory;
step("A1 client module registers with id dsh-autoupdate", () => {
  factory = registered.get("dsh-autoupdate");
  assert.ok(factory, "no factory registered");
});

// mock react
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {}, // effects skipped in smoke (they would fetch)
  useRef: (v) => ({ current: v }),
};
const fakeRequire = (name) => {
  if (name === "react") return fakeReact;
  throw new Error(`unexpected require: ${name}`);
};

let exports_;
step("A2 factory materializes and exports apply/inject", () => {
  exports_ = factory(fakeRequire);
  assert.equal(typeof exports_.apply, "function");
  assert.deepEqual(exports_.inject, ["slots", "locale"]);
});

// mock ctx
const slotRegistrations = [];
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: () => () => {},
    bind: () => (key) => ({ nav: "自动更新" })[key] ?? key,
  },
  slots: {
    inject: (name, fn) => {
      assert.equal(name, "settings.section", "slot name must be settings.section");
      fn();
    },
    register: (options, component) => {
      slotRegistrations.push({ options, component });
    },
  },
};

step("A3 apply() registers a settings.section entry (id dsh-autoupdate)", () => {
  exports_.apply(ctx);
  assert.equal(slotRegistrations.length, 1);
  const { options } = slotRegistrations[0];
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "dsh-autoupdate");
  assert.equal(typeof options.label, "function");
  assert.equal(options.label(), "自动更新");
});

// ---------- B. component renders with fallbacks ----------
step("B1 section renders without t prop (fallback dictionary)", () => {
  const Section = slotRegistrations[0].component;
  const tree = Section({});
  assert.ok(tree && tree.type === "div", "root element missing");
  const json = JSON.stringify(tree);
  assert.match(json, TITLE_RE, "title missing (zh or en)");
  assert.ok(!json.includes("undefined"), "no undefined leaks");
});

step("B2 section renders when t throws", () => {
  const Section = slotRegistrations[0].component;
  const tree = Section({ t: () => { throw new Error("locale broken"); } });
  const json = JSON.stringify(tree);
  assert.match(json, TITLE_RE, "fallback text missing (zh or en)");
});

// ---------- C. backend channel handler ----------
const { createUpdateHandler } = await import("../lib/channel.js");

const mkUpdater = (over = {}) => ({
  getUiStatus: () => ({ installedVersion: "0.1.1-rc.2", pendingVersion: null, level: "auto" }),
  checkForUi: async () => ({ state: "up-to-date", current: "0.1.1-rc.2", latest: "0.1.1-rc.2" }),
  armFromUi: async (v) => ({ armed: true, targetVersion: v }),
  ...over,
});

step("C1 status endpoint returns ok envelope value", async () => {
  const handler = createUpdateHandler(mkUpdater());
  const r = await handler("autoupdate/status", {});
  assert.equal(r.ok, true);
  assert.equal(r.value.installedVersion, "0.1.1-rc.2");
});

step("C2 check endpoint up-to-date", async () => {
  const handler = createUpdateHandler(mkUpdater());
  const r = await handler("autoupdate/check", {});
  assert.equal(r.ok, true);
  assert.equal(r.value.state, "up-to-date");
});

step("C3 check endpoint update-available", async () => {
  const handler = createUpdateHandler(
    mkUpdater({ checkForUi: async () => ({ state: "update-available", current: "0.1.1-rc.2", latest: "0.1.2", channel: "latest" }) }),
  );
  const r = await handler("autoupdate/check", {});
  assert.equal(r.value.state, "update-available");
  assert.equal(r.value.latest, "0.1.2");
});

step("C4 check failure becomes structured error (never throws)", async () => {
  const handler = createUpdateHandler(mkUpdater({ checkForUi: async () => { throw new Error("network down"); } }));
  const r = await handler("autoupdate/check", {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "check-failed");
  assert.match(r.error.message, /network down/);
});

step("C5 apply endpoint validates and arms", async () => {
  const handler = createUpdateHandler(mkUpdater());
  const r = await handler("autoupdate/apply", { targetVersion: "0.1.2" });
  assert.equal(r.ok, true);
  assert.equal(r.value.armed, true);
});

step("C6 apply failure becomes structured error", async () => {
  const handler = createUpdateHandler(mkUpdater({ armFromUi: async () => { throw new Error("目标版本与检测结果不一致"); } }));
  const r = await handler("autoupdate/apply", { targetVersion: "0.1.2" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "apply-failed");
});

step("C7 unknown endpoint rejected cleanly", async () => {
  const handler = createUpdateHandler(mkUpdater());
  const r = await handler("bogus/endpoint", {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unknown-endpoint");
});

console.log(failures === 0 ? "\nUI SMOKE ALL PASS" : `\nUI SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
