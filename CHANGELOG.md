# Changelog

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
