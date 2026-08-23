// Circuit breaker + cooldown guard: converts repeated failures into a
// progressively lower capability level, so a broken environment degrades to
// silence instead of spamming or crashing the host.
//
//   auto   — detect new versions and arm the auto-update helper
//   notify — detect and log only (no auto-apply)
//   off    — no checks at all
//
// Ladder rules:
//   - consecutiveFailures >= maxConsecutiveFailures   → notify
//   - consecutiveFailures >= maxConsecutiveFailures*2 → off
//   - any successful cycle restores auto (self-healing)
//   - cooldown (lastFailureAt, apply failures only) pauses auto-apply briefly
//     without touching the ladder
export function createGuard(stateStore, config, log) {
  const s = () => stateStore.data;
  const maxFails = Math.max(1, Math.trunc(Number(config.maxConsecutiveFailures) || 3));
  return {
    get level() {
      return s().level;
    },

    inCooldown(now = Date.now()) {
      const at = s().lastFailureAt ?? 0;
      return at > 0 && now - at < config.cooldownMs;
    },

    canCheck() {
      return s().level !== "off";
    },

    canAutoApply() {
      return s().level === "auto" && !this.inCooldown();
    },

    recordSuccess() {
      stateStore.mutate((d) => {
        d.consecutiveFailures = 0;
        d.lastFailureError = null;
        if (d.level !== "auto") d.level = "auto"; // healthy cycle self-heals the ladder
      });
    },

    /**
     * Record a failure.
     * @param {unknown} error - the failure cause.
     * @param {"check"|"apply"} kind - apply failures additionally arm the cooldown.
     */
    recordFailure(error, kind = "check") {
      stateStore.mutate((d) => {
        d.consecutiveFailures = (d.consecutiveFailures ?? 0) + 1;
        if (kind === "apply") {
          d.lastFailureAt = Date.now();
        }
        d.lastFailureError = String(error?.message ?? error).slice(0, 500);
        if (d.consecutiveFailures >= maxFails * 2 && d.level !== "off") {
          d.level = "off";
          log.warn(
            `circuit breaker: level set to "off" after ${d.consecutiveFailures} consecutive failures (last: ${d.lastFailureError}); delete the plugin's state.json to reset`,
          );
        } else if (d.consecutiveFailures >= maxFails && d.level === "auto") {
          d.level = "notify";
          log.warn(
            `circuit breaker: level downgraded to "notify" after ${d.consecutiveFailures} consecutive failures (last: ${d.lastFailureError})`,
          );
        }
      });
    },

    reset() {
      stateStore.mutate((d) => {
        d.consecutiveFailures = 0;
        d.level = "auto";
        d.lastFailureAt = 0;
        d.lastFailureError = null;
      });
    },
  };
}
