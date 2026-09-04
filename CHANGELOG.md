# Changelog

## v1.1.3 (2026-09-04) — update pipeline fixes

- 修复运行中 dsh 包目录多向上取一层的问题，支持符号链接与不同入口深度；无法确定安装前缀时明确拒绝排定，避免更新另一套 Node 环境。
- 修复 macOS/Linux 全局安装的 `lib/node_modules` 验证路径；Windows 的 Node 可执行文件直接启动，支持含空格路径。
- 更新助手持续等待 dsh 退出，取消一小时上限；存活的助手不再因计划超过六小时被清除。
- 为更新计划添加唯一标识，已被替换的助手退出且不覆盖新任务结果；处理 spawn 异步错误与状态写入失败。
- 回滚未通过验证时报告失败；profile 刷新使用刚更新的 dsh 入口。
- 设置页首次读取状态失败后允许重试，校验检查与排定响应，遵守禁用/停止状态；修复英文文案。
- 断路器允许低频恢复检测；修复 UI 冒烟测试未等待异步断言的问题，并加入离线端到端更新、回滚与界面回归测试。


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
