# dsh-autoupdate — dsh 内置自动更新插件

一个嵌入 dsh 内部运行的 Cordis 插件：自动检测 `@deepseek-ai/dsh` 新版本，并在 dsh 退出后自动执行带健康检查与自动回滚的更新事务，把"手动 npm install + 手动刷 profile"压缩为零操作。

[English README](./README.md)

- 更新通道：npm dist-tag（`latest` / `rc` / 任意已发布 tag）
- 更新目标：**精确固定版本 + 精确安装前缀**（从运行中的 dsh 进程反推，不依赖 PATH 上的 npm 指向哪里）
- 应用时机：**dsh 进程退出后**（detached helper 轮询父进程退出，规避 Windows 文件锁；即使 dsh 被强杀，已武装的更新仍会执行）
- 失败处理：安装失败重试 ×3 → 验证失败自动回滚到原版本并复验 → 断路器降级（auto → notify → off）
- 范围：CLI 本体更新（含随 CLI 分发的 in-box bundles）+ 可选的 profile 用户插件刷新（`dsh plugin --profile <p> update`，带 manifest 备份/恢复）

## 目录结构

```
dsh-autoupdate/
├── package.json           # 声明 dsh.bundle.patch → dsh 会把它登记为 profile 的 bundle 层
├── cordis.patch.yml       # 插件行（id: auto-update, name: dsh-autoupdate）+ 默认配置
├── lib/
│   ├── index.js           # cordis 插件入口（name / Config / apply）
│   ├── updater.js         # 编排器：检测 → 决策 → 武装 helper / 通知
│   ├── install.js         # 安装定位/安装/验证原语（--prefix 定向，超时沙箱）
│   ├── registry.js        # npm dist-tag 查询（容错 JSON 提取 + 重试）
│   ├── guard.js           # 断路器 + 冷却（降级梯子）
│   ├── semver.js          # 零依赖 SemVer 解析/比较
│   └── state.js           # 独立状态存储 + 滚动日志（$DSH_HOME/plugins-data/）
├── scripts/
│   ├── update-agent.mjs   # 退出时更新 helper（自包含，仅用 Node 内置模块）
│   └── dev-smoke.mjs      # 离线冒烟测试（只读检测，永不安装）
└── docs/
    └── COMPATIBILITY.zh.md  # 抗破坏性更新实现思路（核心设计文档）
```

## 一、安装嵌入步骤

通过 dsh 官方插件通道装进任意 profile，三种来源任选其一：

```bash
# ① 从 npm 安装（发布后）
dsh plugin --profile web add dsh-autoupdate

# ② 从 GitHub 安装
dsh plugin --profile web add github:lc23313/dsh-autoupdate

# ③ 从源码目录 / 离线 tarball 安装（pnpm 以本地路径链接，源目录须长期存在）
dsh plugin --profile web add /path/to/dsh-autoupdate
dsh plugin --profile web add /path/to/dsh-autoupdate-1.0.0.tgz
```

dsh 会：初始化 profile 工作区 → pnpm 安装该包 → 因其 `package.json` 声明了 `dsh.bundle.patch`，自动把它加入 `dsh.profile.bundles` 层列表。

> macOS / Linux 用户：三种安装命令完全一致（把路径换成 POSIX 风格即可）；插件内部已按平台适配（prefix 布局、非 shell spawn、信号处理均不同）。

### 验证嵌入成功

```bash
# 组合后的插件树里应出现 auto-update 行（name: dsh-autoupdate）
dsh --dump-config --profile web | grep -A3 "auto-update"
```

### 重启 dsh 生效

```bash
dsh web
# 启动 30 秒后进行首次检测；此后每 6 小时一次
cat ~/.dsh/plugins-data/dsh-autoupdate/autoupdate.log   # 查看运行日志（Windows: type）
```

诊断模式（打印环境体检报告，只读）：

```bash
DSH_AUTOUPDATE_DOCTOR=1 dsh web
```

## 二、配置

默认配置在插件包自身的 `cordis.patch.yml`（`config:` 块）里，直接编辑后重启 dsh 即可。也可以在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖（用户层会整行替换 config，省略的键回落到 schema 默认值）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: auto-update
  config:
    channel: rc              # 跟踪 rc 通道
    checkIntervalMs: 3600000 # 每小时检查
```

| 配置项                         | 默认值           | 说明                                  |
| --------------------------- | ------------- | ----------------------------------- |
| `enabled`                   | `true`        | 总开关；`false` 时插件空转                   |
| `channel`                   | `"latest"`    | npm dist-tag 通道；找不到时回落 `latest`     |
| `autoApply`                 | `true`        | `false` = 只检测+通知（手动模式），给出一条手动升级命令   |
| `checkIntervalMs`           | `21600000`    | 检查间隔（6 小时；下限 5 分钟）                  |
| `startupDelayMs`            | `30000`       | 启动后延迟首检，避免拖慢 dsh 启动                 |
| `maxConsecutiveFailures`    | `3`           | 连续失败 N 次降级为 notify，2N 次降级为 off      |
| `cooldownMs`                | `86400000`    | 应用失败后的冷却期（默认 24 小时内不再自动应用）          |
| `npmTimeoutMs`              | `30000`       | npm 查询类命令超时                         |
| `installTimeoutMs`          | `300000`      | npm install / pnpm update 超时        |
| `npmCommand` / `dshCommand` | `npm` / `dsh` | 命令覆盖（如需指定绝对路径）                      |
| `registry`                  | `""`          | npm registry 覆盖（镜像源场景）              |
| `updateProfilePlugins`      | `true`        | CLI 更新成功后刷新 profile 内用户插件（带备份/恢复）   |
| `profiles`                  | `[]`          | 刷新哪些 profile；空 = 自动探测依赖本插件的 profile |
| `logToConsole`              | `true`        | 是否同时把日志打到 dsh 控制台                   |

## 三、运行时行为（更新事务）

```
检测到新版本 X
  └─ 武装：spawn detached helper（轮询本 dsh 进程 pid）
       └─ dsh 进程退出（正常或被杀）
            └─ helper 二次确认 state.json 中的武装记录仍匹配（防过期/被覆盖）
                 └─ npm install -g @deepseek-ai/dsh@X --prefix <运行中 dsh 的安装前缀>
                      └─ 失败 → 重试 ×3（间隔递增）→ 仍失败 → 校验旧版本完好后结束
                 └─ 验证：manifest 版本 == X 且 node <bin.js> --version 输出 X
                      └─ 不符 → npm install -g @deepseek-ai/dsh@旧版本 → 复验 → 记录 rolled-back
                 └─ （可选）逐 profile 备份 package.json/pnpm-lock.yaml → dsh plugin --profile p update
                      └─ 失败 → 恢复备份 → dsh plugin --profile p install 重新对齐
                 └─ 写 helper-result.json + 更新 state.json → 退出
下次 dsh 启动 → 消费 result → 记录成功/失败进断路器 → 日志播报结果
```

## 四、手动操作

| 场景       | 操作                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 查看状态     | `cat ~/.dsh/plugins-data/dsh-autoupdate/state.json`（Windows: `type "%USERPROFILE%\.dsh\plugins-data\dsh-autoupdate\state.json"`） |
| 查看日志     | `cat ~/.dsh/plugins-data/dsh-autoupdate/autoupdate.log`                                                                          |
| 重置断路器    | 删除 `state.json`（或把配置 `maxConsecutiveFailures` 调大后重启）                                                                             |
| 手动回滚     | `npm install -g @deepseek-ai/dsh@<旧版本>`                                                                                          |
| 立即检查     | 重启 dsh（启动后 30 秒首检），或临时调小 `startupDelayMs`                                                                                        |
| 临时禁用自动应用 | 配置 `autoApply: false`（保留检测与通知）                                                                                                   |
| 彻底卸载     | `dsh plugin --profile web remove dsh-autoupdate`，再删除 `~/.dsh/plugins-data/dsh-autoupdate`（及本地源码目录）                               |

## 五、安全与信任说明

安装任何能执行包安装操作的插件前，应清楚它到底做了什么：

- 只 spawn `npm`（版本查询、`npm install -g @deepseek-ai/dsh@<精确版本>`，安装目标为运行中 dsh 自身的前缀）以及可选的 `dsh plugin --profile <p> update|install`（仅限依赖本插件的 profile）。
- **从不写 dsh 自己的文件**（settings.yaml / cordis.patch.yml / profile manifest）；所有状态与日志限制在 `$DSH_HOME/plugins-data/dsh-autoupdate/`。
- 不读取、不传输任何凭据；npm 在你自己的环境与 registry 配置下运行。
- 每一步决策都完整记录在 `autoupdate.log`，可随时审计。
- 所有安装都固定为检测时解析出的**精确版本**；回滚同样精确重装旧版本。

## 六、测试与构建

```bash
node scripts/dev-smoke.mjs          # 端到端冒烟：真实检测流程（强制 autoApply=false，零副作用）
node --check lib/*.js scripts/*.mjs # 语法检查
npm pack                            # 生成离线安装包 dsh-autoupdate-<版本>.tgz
```

冒烟已覆盖：插件加载（mock Context）、版本定位三层回退、dist-tag 查询、状态/日志落盘、优雅 dispose。helper 的中止路径与安装验证原语也已单独测试通过。

## 七、已知限制

1. **多实例并发**：helper 只等待武装它的那个 dsh 进程退出；若另一个 dsh 实例仍在运行且锁住全局目录，npm 安装会失败重试（×3，间隔递增），最终失败则记入断路器，下个周期重试。
2. **长期离线**：网络不可达只计"检查失败"；连续 6 次后降级为 off 静默（恢复联网后一次成功检查即自动复位为 auto）。
3. **headless 一次性任务**：进程存活时间可能短于 `startupDelayMs`（30s），首检来不及执行；此类场景请把 `startupDelayMs` 调到 5000 以下。

抗破坏性更新（接口变更/结构改动/大版本重构下的存活策略）完整设计见 **docs/COMPATIBILITY.zh.md**。
