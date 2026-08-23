# dsh-autoupdate

A built-in auto-update plugin for [dsh](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness). It runs inside every booted dsh profile, detects new `@deepseek-ai/dsh` releases on npm, and applies them as a **guarded update transaction** — after the dsh process exits, with health verification and automatic rollback. No more manual `npm install -g` rounds.

[中文文档 (Chinese README)](./README.zh.md)

## Highlights

- **Update channel**: any npm dist-tag (`latest`, `rc`, …)
- **Exit-time application**: a detached helper waits for the dsh process to exit before touching the global install — avoids Windows file locks and survives even a killed dsh
- **Targeted install**: resolves the *running* dsh's own npm prefix (from `process.argv[1]`) and installs into it with `--prefix` — immune to multi-Node PATH confusion
- **Transaction safety**: exact-version install → dual verification (manifest + actually running the new binary) → automatic rollback to the previous version on any failure
- **Circuit breaker**: consecutive failures degrade `auto → notify → off`; any success restores full automation
- **Optional profile refresh**: after a CLI update, user plugins in your profiles can be refreshed via `dsh plugin --profile <p> update` (with manifest backup/restore)
- **Breaking-update survivability**: zero runtime dependencies, no dsh internal API calls — see [docs/COMPATIBILITY.zh.md](./docs/COMPATIBILITY.zh.md) for the full six-layer defense design

## Install

Install into any dsh profile through the official plugin channel:

```bash
# from npm
dsh plugin --profile web add dsh-autoupdate

# from GitHub
dsh plugin --profile web add github:lc23313/dsh-autoupdate

# from a local tarball (offline sharing)
dsh plugin --profile web add /path/to/dsh-autoupdate-1.0.0.tgz
```

Verify it was registered as a profile layer, then restart dsh:

```bash
dsh --dump-config --profile web   # should list the auto-update row (name: dsh-autoupdate)
```

The plugin starts checking 30 s after boot, then every 6 hours. State and logs live in `$DSH_HOME/plugins-data/dsh-autoupdate/` (default `~/.dsh/`).

## Configuration

Defaults live in the package's own `cordis.patch.yml`; override them per profile in `~/.dsh/profiles/<name>/cordis.patch.yml` (a user-layer row replaces the row's whole config; omitted keys fall back to schema defaults):

```yaml
- id: auto-update
  config:
    channel: rc               # track the rc dist-tag
    checkIntervalMs: 3600000  # check hourly
```

| Option                      | Default       | Description                                                                      |
| --------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `enabled`                   | `true`        | Master switch; `false` = no-op                                                   |
| `channel`                   | `"latest"`    | npm dist-tag to track; falls back to `latest`                                    |
| `autoApply`                 | `true`        | `false` = detect + notify only (prints a manual command)                         |
| `checkIntervalMs`           | `21600000`    | Check interval (6 h; floor 5 min)                                                |
| `startupDelayMs`            | `30000`       | Delay before the first check after boot                                          |
| `maxConsecutiveFailures`    | `3`           | N failures → `notify`, 2N → `off`                                                |
| `cooldownMs`                | `86400000`    | Pause auto-apply after an apply failure                                          |
| `npmTimeoutMs`              | `30000`       | Timeout for npm queries                                                          |
| `installTimeoutMs`          | `300000`      | Timeout for npm install / pnpm update                                            |
| `npmCommand` / `dshCommand` | `npm` / `dsh` | Command overrides (absolute paths allowed)                                       |
| `registry`                  | `""`          | npm registry override (mirrors)                                                  |
| `updateProfilePlugins`      | `true`        | Refresh user plugins in profiles after a CLI update                              |
| `profiles`                  | `[]`          | Which profiles to refresh; empty = auto-detect profiles depending on this plugin |
| `logToConsole`              | `true`        | Mirror log lines to the dsh console                                              |

## How the update transaction works

```
detect new version X
  └─ arm: spawn detached helper (polls this dsh process by pid)
       └─ dsh exits (gracefully or killed)
            └─ helper re-confirms the arm in state.json (stale arms abort)
                 └─ npm install -g @deepseek-ai/dsh@X --prefix <running dsh's prefix>
                      └─ on failure: retry ×3 → verify old version intact → stop
                 └─ verify: manifest version == X AND `node <bin> --version` prints X
                      └─ mismatch → reinstall previous version → re-verify → record rollback
                 └─ (optional) per-profile: backup manifests → dsh plugin --profile <p> update
                 └─ write helper-result.json + update state.json
next dsh boot → consume the result → feed the circuit breaker → log the outcome
```

## Security & trust

Before installing any plugin that can run package installs, you should know exactly what this one does:

- It spawns **only** `npm` (version queries, `npm install -g @deepseek-ai/dsh@<exact version>` into the prefix dsh itself runs from) and, optionally, `dsh plugin --profile <p> update|install` for profiles that depend on this plugin.
- It **never** writes to dsh-owned files (`settings.yaml`, `cordis.patch.yml`, profile manifests). All state/logs are confined to `$DSH_HOME/plugins-data/dsh-autoupdate/`.
- It never reads or transmits credentials; npm runs under your own environment and registry configuration.
- Every decision is logged with full detail to `autoupdate.log` — audit it any time.
- All installs pin an **exact** version resolved at check time; rollbacks reinstall the previous exact version.

## Manual operations

| Task               | How                                                        |
| ------------------ | ---------------------------------------------------------- |
| Inspect state      | `cat $DSH_HOME/plugins-data/dsh-autoupdate/state.json`     |
| Read the log       | `cat $DSH_HOME/plugins-data/dsh-autoupdate/autoupdate.log` |
| Reset the breaker  | delete `state.json`                                        |
| Roll back manually | `npm install -g @deepseek-ai/dsh@<old-version>`            |
| Disable auto-apply | set `autoApply: false` (detection + notification remain)   |
| Diagnostics        | boot dsh with `DSH_AUTOUPDATE_DOCTOR=1`                    |
| Uninstall          | `dsh plugin --profile <name> remove dsh-autoupdate`        |

## Known limitations

1. **Concurrent dsh instances**: the helper waits only for the arming process; if another instance still holds locks, npm fails and retries ×3, then defers to the next cycle (circuit breaker counts it).
2. **Long offline periods**: 6 consecutive check failures silence the plugin (`off`); the first successful check after reconnect restores `auto`.
3. **One-shot headless runs** may exit before the first check; lower `startupDelayMs` for those workflows.

## Development

```bash
node --check lib/*.js scripts/*.mjs   # syntax check
node scripts/dev-smoke.mjs            # end-to-end smoke test (real detection, autoApply forced off, zero side effects)
```

Design notes on surviving dsh breaking updates: [docs/COMPATIBILITY.zh.md](./docs/COMPATIBILITY.zh.md) (Chinese).

## License

[MIT](./LICENSE)
