# UI 模块：嵌入方式与弹窗交互逻辑（v1.1.0 新增）

## 1. 架构总览

v1.1.0 在原有后端插件（cordis 插件，运行于 dsh 进程内）之上新增了**浏览器端 UI 模块**。一个包、一条 patch 行，两端各取所需：

```
dsh-autoupdate（单个 npm 包）
├── 后端半边  lib/index.js      cordis 插件（检测/武装/回滚，原有逻辑）
├── 前端半边  lib/client.js     设置页 UI（本模块）
└── 通道      lib/channel.js    后端 RPC 通道注册（POST /dsh-autoupdate/*）
```

装载链：`cordis.patch.yml` 里的单行 `name: dsh-autoupdate` → cordis loader 加载后端入口；宿主（dsh-client-modules）扫描到 `package.json` 的 `dsh.client` 声明后，把 `exports["./client"]` 作为浏览器模块伺服到 `/plugins/dsh-autoupdate/client.js`，由 `window.__ModuleLoader__` 懒加载执行。

## 2. UI 嵌入方式（插槽契约）

设置页是插槽式组合：壳插件（dsh-client-ui-settings-general）声明插槽树，各功能包向插槽注册内容。本插件注册的插槽：

| 插槽 | 类型 | 注册内容 |
|---|---|---|
| `settings.section` | list（设置页左侧导航 + 内容区） | `{ id: "dsh-autoupdate", order: 100, label, locale }` + Section 组件 |

注册代码（`lib/client.js` 的 `apply(ctx)`）：

```js
ctx.slots.inject("settings.section", () =>
  ctx.slots.register({
    name: "settings.section",
    id: "dsh-autoupdate",
    order: 100,
    label: labelFn,      // 走 locale 服务，失败回落 "自动更新"
    locale: "dsh-autoupdate",
  }, Section));
```

- `ctx.slots.inject(name, fn)`：等插槽声明出现在账本上再注册——与壳插件的加载顺序解耦。
- `locale: "dsh-autoupdate"`：壳会给组件注入绑定到该命名空间的 `t` 函数；组件同时内置字典兜底（`t` 缺失/抛错时用 `navigator.language` 选 zh/en）。
- Section 组件用**原生 React**（`require("react")`，ModuleLoader 静态表提供），不依赖 dsh 的组件库（primitives），样式用 dsw 设计变量 + 硬编码回退（`var(--dsw-alias-bg-layer-2, #fff)`）。

## 3. 前后端通道

不引入 dsh 的 RPC 框架（typert/zod 描述符），直接用宿主连接服务的**通用通道注册**：

后端（`lib/channel.js`，cordis 侧）：

```js
ctx.inject(["connection"], (cctx) => {
  cctx.connection.rpc.handle("/dsh-autoupdate", handler);
});
```

前端（`lib/client.js`，浏览器侧）——纯同源 fetch：

```js
fetch(location.origin + "/dsh-autoupdate/autoupdate/check", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId, method: "autoupdate/check", payload: {} }),
});
// 响应: { type: "server-response", rpcId, result: { ok, value | error } }
```

三个端点：

| 端点 | payload | 返回 value |
|---|---|---|
| `autoupdate/status` | `{}` | `{ installedVersion, pendingVersion, level, lastCheckAt, channel }` |
| `autoupdate/check` | `{}` | `{ state: "up-to-date" \| "update-available", current, latest, channel, checkedAt }` |
| `autoupdate/apply` | `{ targetVersion }` | `{ armed: true, targetVersion, fromVersion }` |

安全边界：
- `apply` 的 `targetVersion` 必须等于最近一次 `check` 解析出的 `pendingVersion`——UI 不能任意指定版本安装。
- 通道信任检查（loopback / 同源 Origin / trustedHosts）由宿主连接层统一执行。
- 无 `connection` 服务的 profile（headless/tui）里通道不注册，后端照常工作。

## 4. 弹窗交互逻辑

```
点击【检查更新】
   │
   ▼
┌─ checking ────────────────────────► 文案「正在检查更新…」
│        │（POST autoupdate/check）
│        ▼
│   ┌─── state === "update-available" ──► ┌──────────────────────────────┐
│   │                                     │ 发现新版本                    │
│   │                                     │ 当前版本 X / 最新版本 Y / 通道 │
│   │                                     │ [确认更新]      [取消]        │
│   │                                     └──────┬───────────┬───────────┘
│   │                              点击确认更新   │           │ 点击取消 → 关闭
│   │                                            ▼
│   │                                     arming →（POST autoupdate/apply）
│   │                                            ▼
│   │                                     armed：「更新已排定：dsh 退出后
│   │                                     将自动完成安装与验证，重启后生效」
│   │                                     + 目标版本行 + [关闭]
│   │
│   └─── state === "up-to-date" ──────► 「当前已是最新版本，暂无可用更新」+ [关闭]
│
└─── 失败（网络/registry/断路器等）──► 红色错误文案 + [关闭]
```

实现要点：

- **弹窗本体**：fixed 遮罩 + 居中面板，`role="dialog"`，点遮罩或按钮关闭。
- **并发防护**：组件内 `seq` 引用计数——每次请求自增，响应回来时序号不匹配直接丢弃（连续点击/关闭后再返回都不会写脏状态）。
- **后端并发防护**：`checkForUi` 复用 `_checking` 锁，重复点击返回"已有检测正在进行"。
- **armed 之后**：更新在 dsh 进程退出后由 detached helper 执行（v1.0.0 原有事务：安装→双验证→失败回滚→断路器记账），UI 不做安装，只做排定。
- **通道缺席降级**：挂载时 `autoupdate/status` 失败 → 按钮置灰，显示"更新服务不可用…可手动执行 npm install -g …"——UI 坏了也不误导用户。

## 5. 抗破坏性设计（UI 部分）

| 依赖点 | 失稳后果 | 防护 |
|---|---|---|
| `settings.section` 插槽被移除/改名 | UI 不显示 | `slots.inject` 永不触发，静默缺席；后端与手动 CLI 流程不受影响 |
| locale 服务 API 变化 | 文案异常 | `t` 调用全程 try/catch，内置 zh/en 字典兜底 |
| ModuleLoader 中 react 缺席 | 组件无法构建 | factory 内探测，缺失则跳过注册 |
| dsw 设计变量改名 | 样式走样 | 每个变量带硬编码回退值 |
| 通道信封格式（client-request/server-response）变化 | UI 请求 4xx | 前端报错文案明确提示"dsh 版本可能已变更"，并给出手动命令 |
| primitives 组件库变化 | — | 不使用（原生 button/div） |

## 6. 触发规则变更（v1.0.0 → v1.1.0）

新增配置 `autoCheck`（默认 `false`）：

- `false`（默认）：**无任何静默检测**——启动与周期定时器均不注册；检测只在用户点击【检查更新】时发生。
- `true`：恢复 v1.0.0 的启动 30s 首检 + 每 6 小时周期检测。

原有检测/武装/验证/回滚/断路器代码一行未改，仅定时器调度被 `autoCheck` 门控。想恢复自动检测，在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: auto-update
  config:
    autoCheck: true
```
