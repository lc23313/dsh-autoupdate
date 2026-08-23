// dsh-autoupdate — built-in auto-update plugin for dsh (DeepSeek Harness).
//
// Exports the cordis plugin contract: name / Config / apply. Stability rules
// (see docs/COMPATIBILITY.zh.md for the full rationale):
//   - zero static imports from dsh internals; only Node built-ins statically
//   - schemastery is imported dynamically and is optional: without it the
//     plugin still runs on its internal defaults
//   - apply() is fully wrapped; a plugin startup failure never propagates
//     into the host process
export const name = "dsh-autoupdate";

import { AutoUpdater } from "./updater.js";

let Config = undefined;
try {
  const { default: z } = await import("@deepseek-ai/schemastery");
  Config = z.object({
    enabled: z.boolean().default(true),
    channel: z.string().default("latest"),
    autoApply: z.boolean().default(true),
    checkIntervalMs: z.number().default(21600000),
    startupDelayMs: z.number().default(30000),
    maxConsecutiveFailures: z.number().default(3),
    cooldownMs: z.number().default(86400000),
    npmTimeoutMs: z.number().default(30000),
    installTimeoutMs: z.number().default(300000),
    npmCommand: z.string().default("npm"),
    dshCommand: z.string().default("dsh"),
    registry: z.string().default(""),
    updateProfilePlugins: z.boolean().default(true),
    profiles: z.array(z.string()).default([]),
    logToConsole: z.boolean().default(true),
  });
} catch {
  // schemastery unavailable (or its schema API changed): the plugin proceeds
  // with its built-in default config via normalizeConfig().
  Config = undefined;
}

export async function apply(ctx, config) {
  try {
    const updater = new AutoUpdater(ctx, config);
    updater.start();
  } catch (e) {
    // Last-resort containment: a broken plugin must never break dsh.
    try {
      ctx?.logger?.warn?.(`[dsh-autoupdate] failed to start (plugin inactive this session): ${e?.message ?? e}`);
    } catch {}
  }
}
