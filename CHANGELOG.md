# Changelog

## v1.1.2 (2026-08-23) — CI hardening

不影响插件运行时，仅收紧 CI 稳定性：

- `.github/workflows/ci.yml`：job 与各 step 加 `timeout-minutes`；`npm install -g` 加 `--no-audit --no-fund` 加速。
- `scripts/dev-smoke.mjs`：当环境里找不到 dsh（argv[1] / `dsh --version` / `npm root -g` 三层全失败）时，**软跳过** `installedVersion` 断言（仅 `WARN`，不视为失败），避免 CI runner 没装 dsh 把插件本身没问题也判定红。
- `scripts/ui-smoke.mjs`：修复 B1/B2 在 CI 环境失败——Node ≥21 自带只读 `navigator`（`language: "en"`），组件走英文回退，断言写死的 `"检查更新"` 匹配不到。改用 `Object.defineProperty` 模拟 `zh-CN` 浏览器 + 断言正则兼容中英文（`/检查更新|Check for Updates/`），测试与 locale 解耦。

## v1.1.1 (2026-08-23) — hotfix

修复 v1.1.0 在真实 dsh web 环境中的通道注册失败：

- **问题**：`connection.rpc.handle(...)` 第三个参数 `options` 必填（含 `authority` 字段），v1.1.0 漏传，宿主读 `options.authority` 时抛 `Cannot read properties of undefined`，UI 走"更新服务不可用"降级。
- **修复**：`lib/channel.js` 改为 `rpc.handle(CHANNEL, handler, { authority: "loopback" })`——loopback 信任保证只有本地 dsh web 的同源 fetch 能命中通道。

仅 1 行代码改动；其它代码、文档、配置无变更。

## v1.1.0 (2026-08-23)

新增手动触发更新 UI（设置页集成），触发规则从"静默自动检测"改为"手动点击检测"。**原有更新逻辑（检测/定点安装/双验证/回滚/断路器）一行未改。**

### 新增（NEW）

| 文件 | 内容 |
|---|---|
| `lib/client.js` | 浏览器端 UI 模块：注册 `settings.section` 插槽（id: dsh-autoupdate），渲染【检查更新】按钮行 + 结果弹窗；内置 zh/en 字典与 dsw 变量回退样式 |
| `lib/channel.js` | 后端 RPC 通道：注册 `POST /dsh-autoupdate/autoupdate/{status,check,apply}`；纯函数 handler 可独立单测；connection 服务缺席时静默不注册 |
| `docs/UI.zh.md` | UI 嵌入方式与弹窗交互逻辑文档 |
| `scripts/ui-smoke.mjs` | UI 双端离线冒烟（11 项断言：模块注册/插槽注入/组件回退渲染/通道端点全分支） |

### 改动（CHANGED）

| 文件 | 改动点 |
|---|---|
| `lib/updater.js` | 新增配置 `autoCheck`（默认 `false`）；`start()` 定时器调度被 `autoCheck` 门控；新增 `getUiStatus()` / `checkForUi()` / `armFromUi()` 三个 UI 方法（追加，原方法未动） |
| `lib/index.js` | `apply()` 末尾追加 `registerUpdateChannel()`（带隔离 try/catch）；schema 增加 `autoCheck` |
| `cordis.patch.yml` | 行配置增加 `autoCheck: false` |
| `package.json` | 版本 1.0.0 → 1.1.0；新增 `exports["./client"]` 与 `dsh.client` 声明（platform: web） |
| `scripts/dev-smoke.mjs` | 显式传 `autoCheck: true`（继续覆盖周期检测路径） |

### 行为变化（BREAKING-ish，有意为之）

- 默认不再静默周期检测。恢复 v1.0.0 行为：配置 `autoCheck: true`。

## v1.0.0 (2026-08-23)

首个发布：内置自动更新——退出时应用（detached helper）、prefix 定点安装、manifest+bin 双重验证、失败自动回滚、断路器降级（auto→notify→off）、profile 插件可选刷新（备份/恢复）。
