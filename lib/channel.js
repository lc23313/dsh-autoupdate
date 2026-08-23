// UI channel — NEW in v1.1.0.
//
// Registers the plugin's backend RPC channel on the dsh web server so the
// Settings-page UI can talk to this cordis plugin:
//
//   POST <origin>/dsh-autoupdate/<endpoint>
//   body: { type: "client-request", rpcId, method: <endpoint>, payload }
//   resp: { type: "server-response", rpcId, result: { ok, value | error } }
//
// Design rules (docs/COMPATIBILITY.zh.md):
//   - the ONLY host API used is `connection.rpc.handle` — a generic channel
//     registry, far more stable than the typed RPC machinery (no typert/zod
//     descriptors on our side)
//   - everything is feature-probed: no `connection` service (headless/tui
//     profiles), no `rpc.handle` (future API change) → the channel simply
//     never registers; the backend plugin keeps working CLI-only
//   - handler failures return structured errors, never throw into the host
export const CHANNEL = "/dsh-autoupdate";

const ok = (value) => ({ ok: true, value });
const err = (code, message) => ({ ok: false, error: { code, message: String(message).slice(0, 500), details: {} } });

/**
 * Build the channel handler. Pure function over the updater — testable
 * without any cordis context.
 * @param {import("./updater.js").AutoUpdater} updater
 */
export function createUpdateHandler(updater) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case "autoupdate/status":
          return ok(updater.getUiStatus());
        case "autoupdate/check":
          return ok(await updater.checkForUi());
        case "autoupdate/apply":
          return ok(await updater.armFromUi(payload?.targetVersion));
        default:
          return err("unknown-endpoint", `unknown endpoint: ${endpoint}`);
      }
    } catch (e) {
      const code =
        endpoint === "autoupdate/check" ? "check-failed" : endpoint === "autoupdate/apply" ? "apply-failed" : "handler-failed";
      return err(code, e?.message ?? e);
    }
  };
}

/**
 * Register the channel against the host's connection service, when present.
 * @returns true when the registration request was issued (the actual fiber
 *   may still be pending until the connection service appears).
 */
export function registerUpdateChannel(ctx, updater, log) {
  try {
    if (typeof ctx?.inject !== "function") return false;
    ctx.inject(["connection"], (connectionCtx) => {
      try {
        const rpc = connectionCtx?.connection?.rpc;
        if (typeof rpc?.handle !== "function") {
          log?.warn?.("UI channel unavailable: connection.rpc.handle not found (dsh API changed?) — backend keeps running without UI");
          return;
        }
        rpc.handle(CHANNEL, createUpdateHandler(updater), { authority: "loopback" });
        log?.info?.(`UI channel registered: POST ${CHANNEL}/autoupdate/{status,check,apply} (authority: loopback)`);
      } catch (e) {
        log?.warn?.(`UI channel registration failed: ${e?.message ?? e}`);
      }
    });
    return true;
  } catch {
    return false;
  }
}
