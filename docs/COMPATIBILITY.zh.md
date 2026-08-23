# 抗破坏性更新的实现思路（Compatibility & Survivability Design）

> 需求原文：*针对 dsh 未来破坏性更新（接口变更、结构改动、重大版本重构）做兼容防护，尽可能保证插件不会直接失效、可以稳定运行。*

## 1. 威胁模型：dsh 的哪些变化会杀死一个插件

| # | 变化类型 | 具体例子 | 传统插件的死法 |
|---|---|---|---|
| T1 | 运行时 API 变更 | `ctx.logger` 接口改签名；`agent/pre-step` 事件被移除；注入服务改名 | 调用不存在的方法 → 插件加载即崩 |
| T2 | 内部包结构重构 | `@deepseek-ai/dsh-session` 拆分/合并；peerDependency 版本跳跃 | import 解析失败 → 整个插件无法加载 |
| T3 | 插件契约变化 | patch 行格式调整、bundle 声明字段改名 | 插件不再被装载，静默消失 |
| T4 | 依赖版本冲突 | cordis 5 改了 Config schema 语义 | schema 校验失败或配置错乱 |
| T5 | 更新本身失败 | 新版本 dsh 装坏了 / 与环境不兼容 | dsh 起不来，插件陪葬 |
| T6 | 环境漂移 | npm 全局目录换了位置、PATH 里 npm 与 dsh 不属于同一棵安装树 | 更新装到了错误的位置，"成功"却是假象 |

设计原则：**插件对 dsh 的依赖面收缩到最小且最稳定的三个约定，其余全部走防御性探测与事务性自愈。**

## 2. 六层防护体系

### L1 — 零内部依赖（对抗 T1/T2）

- **不 inject、不调用任何 dsh 服务**。插件只用 Node 内置模块 + cordis 插件契约本身（`apply(ctx, config)` + `ctx.on("dispose")`），不订阅任何 dsh 事件（`agent/*`、session 等一概不碰）。
- **静态 import 只有 Node 内置**。`@deepseek-ai/schemastery`（仅用于配置 schema 渲染）改为**动态 import + 可选降级**：拿不到就 `Config = undefined`，插件照常运行于内置默认配置（`normalizeConfig()` 独立实现默认值与数值钳制，不依赖 schema 机制）。
- dsh 重命名、拆分、删除任何内部包，与本插件的加载路径零交集。

### L2 — 契约最小化（对抗 T3）

插件被 dsh 装载只依赖三个**加载期约定**（全部是 dsh 0.1.x 以来最外层、变更代价最高的公共约定）：

| 约定 | 内容 | 若被破坏的后果 |
|---|---|---|
| C1 | `package.json` 声明 `dsh.bundle.patch` | 插件不再作为 bundle 层加入 profile |
| C2 | patch 行 `{ id, name, config }` 插入一个插件 | 行不被识别 |
| C3 | 插件包导出 `name` + `apply(ctx, config)` | apply 不被调用 |

三者的共同特征：**属于 dsh 自身向后兼容的承诺面**（dsh 官方 bundles 全部依赖同一契约，dsh 若破坏它等于破坏自己所有官方插件），因此实际上与 dsh 主体同生共死——这是"依赖 dsh 最稳定不变量"的选型结果。运行时 API（T1 类）完全不在依赖面内。

### L3 — 特性探测与动态降级（对抗 T1/T4）

- 所有 ctx 能力使用前先探测：`pickLogger(ctx)` 检查 `logger.info/warn` 形状，不存在就换 no-op；`ctx.on` 不存在则退到 `process.once("exit")`。
- **不使用 `ctx.setInterval`**（dsh 的 timer 是插件提供的，属于可变面）——自建定时器集合，统一在 dispose 清理，全部 `unref()`，绝不阻止宿主退出。
- 配置经 `normalizeConfig()` 二次钳制：类型错乱、数值越界一律回落安全默认，schema 机制失效也不影响行为。

### L4 — 故障全隔离（对抗一切 T 的爆炸半径）

插件任何故障都到不了宿主进程：

| 防护点 | 机制 |
|---|---|
| 启动 | `apply()` 整体 try/catch；失败仅打一条 warn，本会话插件静默停用 |
| 定时回调 | 每个回调双层包裹（sync try/catch + promise catch） |
| 日志 | `Log` 类所有方法异常自吞（日志写失败绝不上抛） |
| 状态文件 | 损坏/缺失 → 回落默认值（自愈），原子写（tmp+rename） |
| 最坏情况 | 即使插件整体加载失败，cordis loader 层会把失败限制在该插件行内，dsh 主体与其余插件照常启动 |
| 写入隔离 | 插件**从不写 dsh 自己的文件**（settings.yaml / cordis.patch.yml / profile manifest），所有持久化限制在 `~/.dsh/plugins-data/dsh-autoupdate/` |

### L5 — 更新事务性（对抗 T5/T6）

更新不是"执行一条 npm 命令"，而是一个**前置检查 → 定点安装 → 双重验证 → 失败回滚**的事务：

1. **定点**：从运行中的 dsh 进程（`process.argv[1]`）反推其真实安装前缀，`npm install -g --prefix <该前缀>` 精确命中用户实际运行的那份安装——与 PATH 上哪个 npm 在前无关（本机勘察时就发现 `npm root -g` 会指向 WorkBuddy 托管 Node，而 dsh 实际在 `AppData\Roaming\npm`，正是该层防护的现实案例）。
2. **定版**：安装目标锁定为检测时解析出的**精确版本号**（而非 dist-tag），封死"检查后 tag 又动了"的 TOCTOU 窗口。
3. **验证**：manifest 版本比对 + 直接 `node <bin.js> --version` 实跑比对（不经 PATH，确定性）。
4. **回滚**：验证不过 → 重装旧精确版本 → 复验 → 写入 `rolled-back` 结果。安装中途失败也会先校验旧版本完好性再决定是否修复性回滚。
5. **退出时应用**：detached helper 轮询父 pid，dsh 进程（正常或被强杀）退出并留出句柄释放宽限期后才触碰全局目录——规避 Windows 文件锁导致的半成品安装。
6. **helper 自包含**：只 import Node 内置模块，**不 import 插件自身任何代码**——插件源码损坏、配置丢失，已武装的更新照样正确完成；每次阶段推进都即时落盘 `helper-result.json`（崩溃可取证）。
7. **二次确认**：helper 动手前重读 `state.json`，武装记录不匹配（被更新目标覆盖 / 已取消）立即中止——多个武骨并存时旧 helper 自动让位，永不冲突。

### L6 — 断路器与降级梯子（对抗持续故障）

```
auto ──连续失败≥3──▶ notify ──连续失败≥6──▶ off
  ▲                                            │
  └────────── 任一次成功周期自动复位 ─────────────┘（删 state.json 可手动复位）
```

- **check 失败**（网络抖动等）：计入连续失败，但不触发冷却——网络恢复后立即回归正常节奏。
- **apply 失败**：额外触发 24h 冷却，避免反复撞墙。
- 降级路径本身就是"优雅失效"：notify 模式退化为纯通知（给出一条手动命令），off 模式完全静默——**插件坏掉的最坏表现是"不更新"，而不是"拖垮 dsh"**。

## 3. 兼容性矩阵总览

| dsh 变化场景 | 命中防护层 | 结果 |
|---|---|---|
| 内部服务/事件 API 大改 | L1 | 零依赖，无影响 |
| 内部包结构重构/删除 | L1 | 无 import 路径交集，无影响 |
| cordis/schemastery 大版本变化 | L3 | schema 动态导入降级为内置默认配置 |
| ctx 生命周期 API 形状变化 | L3 | 探测失败退化为 no-op / process 兜底 |
| patch 行格式微调 | L2 | 仅影响装载；dsh 官方插件同生共死，风险趋近于零 |
| 插件自身 bug 崩溃 | L4 | 单会话静默停用，dsh 与其他插件不受影响 |
| 新版 dsh 装坏/起不来 | L5 | 验证不过 → 自动回滚旧版并复验 |
| npm 环境漂移（多 Node 共存） | L5 | prefix 定点安装，装错位置不可能 |
| 网络长期不可用 | L6 | 降级为 notify/off，恢复后自愈 |
| 更新服务反复失败 | L6 | 断路器 + 冷却，最坏退化为手动模式 |

## 4. 残余风险与接受理由

| 残余风险 | 概率评估 | 接受理由 |
|---|---|---|
| dsh 更换插件装载契约（C1–C3） | 极低（自我破坏） | 届时插件"不再被加载"而非"加载后崩溃"；dsh 不可能有此迁移而不给兼容期，届时按新契约改一行 patch 声明即可恢复 |
| 多 dsh 实例并发锁冲突 | 低 | 重试 ×3 + 断路器；最终退化为下周期重试，无数据损坏风险 |
| pnpm profile 刷新的部分失败 | 低 | manifest 备份 + 恢复 + 重对齐；即使全失败也不影响 CLI 更新结果（分阶段记录） |
| 强杀后 state 与 result 不同步 | 极低 | 结果文件即时落盘 + 陈旧武装清扫（6h）+ 下周期幂等重检 |

## 5. 维护者的升级剧本（当 dsh 真的破坏了什么）

1. `type ~\.dsh\plugins-data\dsh-autoupdate\autoupdate.log` —— 先看日志，插件的所有决策都有痕。
2. `dsh --dump-config --profile web | grep auto-update` —— 若行消失：契约 C1/C2 变了，对照新版 dsh-base 的 cordis.patch.yml 行格式修改本包的 `cordis.patch.yml` 与 `package.json` 的 `dsh` 字段。
3. 若插件加载报错：看报错是否来自 `apply` 之外的 import 链（理论上不可能出现，出现即说明 cordis 契约 C3 变了）。
4. 所有修复只可能落在：`cordis.patch.yml`（装载）、`lib/index.js` 的 `Config` 构造（schema）、`updater.js` 的 ctx 探测点——其余 90% 代码（semver/state/registry/install/guard/helper）与 dsh 完全解耦，永不需要跟版。
