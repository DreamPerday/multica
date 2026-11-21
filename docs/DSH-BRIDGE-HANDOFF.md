# DSH 桥接器交接说明

本分支从上游 `013be77` 派生，**只包含** `dsh-multica-bridge/`：让 Multica 桌面端把任务派给本机 DSH。

## 归属与边界

| 范围 | 分支 | 负责 |
| --- | --- | --- |
| DSH 运行时桥接器 | `feat/dsh-bridge`（本分支） | 本机 |
| Android 移动端适配 | `feat/android` | 另一台电脑 |
| 两者合并 | `integration/android-dsh` | 集成分支，第三台部署用 |

两边改动路径不重叠（本分支只在 `dsh-multica-bridge/`），正常合并不会冲突。

## 合并方式

```bash
git checkout integration/android-dsh
git merge feat/android          # 移动端
git merge feat/dsh-bridge       # 桥接器
git push origin integration/android-dsh
```

第三台电脑只 checkout `integration/android-dsh`，跑一次部署（见下）。

## 它解决什么问题

上游没有 `@multica-ai/dsh-runtime` 这个包，Multica 无法把 DSH 当 agent 用。桥接器的做法是**把自己注册成一个自定义 runtime profile**（协议族 `dsh`），由它把 Multica 的 JSONL 协议翻译成 `dsh --profile headless --json` 的事件流。

```
Multica 服务端 → 本机 daemon → 拉起 dsh-multica-bridge.cmd
                                      ↓
                    翻译 JSONL ←→ dsh --profile headless --json
```

## 部署（在目标机器上）

### 前置条件

| 依赖 | 说明 |
| --- | --- |
| **DSH Desktop** | 提供 `dsh` 运行时与内置 node；桥接器会解析它的启动 shim |
| **Multica CLI** | 提供 daemon 与 runtime 注册，默认在 `%USERPROFILE%\.multica\bin\multica.exe` |
| **已登录的 Multica 账号** | `multica login`，且该工作区已有 agent |
| **模型凭据** | 在 `~/.dsh/profiles/headless/cordis.patch.yml` 可解析到 provider |

### 步骤

```powershell
# 1) 取代码
git clone -b integration/android-dsh https://github.com/DreamPerday/multica.git
cd multica

# 2) 安装桥接器到 Multica 的 bin 目录
$dst = "$env:USERPROFILE\.multica\bin"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item dsh-multica-bridge\bridge.mjs           $dst -Force
Copy-Item dsh-multica-bridge\dsh-multica-bridge.cmd $dst -Force

# 3) 自检（24 项协议断言）
node dsh-multica-bridge\test\protocol.test.mjs

# 4) 注册 runtime profile
multica runtime profile create `
  --command-name dsh-multica-bridge `
  --display-name "DeepSeek Harness (bridge)" `
  --protocol-family dsh --output json

# 5) 把上一步返回的 id 绑定到本机可执行文件
multica runtime profile set-path <PROFILE_ID> --path "$dst\dsh-multica-bridge.cmd"

# 6) 重启 daemon 让 runtime 上线
multica daemon restart
multica runtime list      # 应看到 dsh provider online
```

`dsh-multica-bridge.cmd` 会自动找 node：先看 `PATH`，再找 `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe`。它必须保持纯 ASCII —— cmd.exe 用 OEM 代码页读它，出现非 ASCII 字节会让后续行解析错乱。

## 协议契约（改代码前必读）

| 关注点 | 结论 | 原因 |
| --- | --- | --- |
| 回合结束信号 | **`turn_end`**（`reason.kind !== "error"`） | DSH 实际只发 `turn_end`，**从不发 `final`**；只等 `final` 会让运行永远"输入中" |
| result 状态值 | 必须是 **`completed`** | daemon 的成功分支只有 `case "completed"`，其余值会落进 `default` 并被渲染成失败 |
| 进程退出 | 发完 `result` 后**自然退出**（排空 stdout、销毁 stdin） | daemon 以 **provider 进程退出**作为运行终结信号；常驻不退会让运行永远 running |
| 模型选择 | 以 **`provider/model`** 复合 ID 上报，每轮用临时 `--patch` 覆盖 `agent-default-model` | `dsh headless` 没有 `--model` 参数；`--patch` 必须写在 `--profile` 之前 |
| 平台 CLI 鉴权 | 把 `MULTICA_CLI_PATH` 指向一次性包装器 | DSH 会把 `MULTICA_TOKEN` 从工具环境剔除（实测长度为 0），但保留 `CLI_PATH` |

### 告警与超时

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_BRIDGE_STALL_MS` | `300000`（5 分钟） | **无工具调用**且无输出时的上限，用于抓模型挂死 |
| `DSH_BRIDGE_TOOL_CEILING_MS` | `660000`（11 分钟） | **有工具调用未返回**时的上限。DSH 自身 `maxTimeoutMs` 默认 10 分钟，必须留出余量让它先超时 |
| `DSH_BRIDGE_QUIET_MS` | `0`（关闭） | 「最后一条是助手消息 + 安静 N 秒即视为结束」。**默认关闭**：DSH 常在一句话之后继续调工具，开启会误杀真实工作 |
| `DSH_BRIDGE_PERMISSION_MODE` | `danger-full-access` | 传给 DSH 的沙箱模式。`workspace-write`/`read-only` 会丢弃命令输出 |
| `DSH_BRIDGE_WATCHDOG_LOG` | 未设置 | 打开后每 15 秒打印一次 idle 时间 |
| `DSH_BRIDGE_TRACE` | 未设置 | 打印每个 DSH 事件的类型与阶段 |

## 自检与排错

```powershell
# 协议测试（不需要真实 dsh）
node dsh-multica-bridge\test\protocol.test.mjs

# 真实端到端（会拉起 dsh）
node dsh-multica-bridge\test\live-probe.mjs "只回答两个字：好了" "D:\某个目录"

# 查看 daemon 侧日志
multica daemon logs
```

常见现象对照：

| 现象 | 含义 |
| --- | --- |
| `MISSING_CREDENTIAL: ... no API key for provider route` | headless profile 的模型指向了没有凭据的 provider，改 `model-route.yml` 或选中已配置的模型 |
| `agent execution context requires MULTICA_TOKEN to be a task-scoped mat_ token` | 包装器没生效：`MULTICA_CLI_PATH` 未指向包装器，或 token 本身没被 daemon 注入 |
| `dsh: session "..." was recorded in "...", not "..."` | 工作目录被迁移/联接过，而 DSH 会话记录里存的是旧绝对路径；改记录或换新会话 |
| `DSH_STALLED` | 无工具调用且长时间无输出 → 模型侧挂死 |
| `DSH_TOOL_STALLED` | 有工具调用未返回且超过工具上限 → 命令挂死（常见于交互式 ssh、等待 stdin 的程序） |

## 已验证

- 协议测试 24 项全过
- 真实运行：`status: completed`，输出正确回传
- 任务在 40–60 秒内完成并结束（daemon 记录 `dsh finished ... status=succeeded`）
- 工作目录经目录联接（C: → D:）与真实路径两种形式均正常（5.8s / 4.9s）

## 未验证 / 已知限制

- **长时间工具调用的新上限未做真实长跑验证**：只看门狗逻辑改过，尚未跑一次超过 5 分钟的命令确认不再误杀。
- **模型目录依赖 CC-Switch 写出的 profile 文件**：`~/.dsh/profiles/headless/cordis.patch.yml` 结构变化会导致解析不到模型。
- **`danger-full-access` 是必需项**：`workspace-write` 与 `read-only` 会丢弃 stdout，agent 无法工作。这意味着**被派活的 agent 能读写该用户可访问的任何文件**。
- 桥接器只在本机验证过（Windows）；未在 Linux/macOS 上验证。

## 与移动端的关系

Android 客户端与本桥接器互不依赖：手机上派活走服务端，服务端再把任务交给某个 runtime。移动端的实时消息问题与其无关（见 `docs/ANDROID-HANDOFF.md`）。

## DSH Desktop 版本与安装布局

DSH 换版本会改变启动方式，桥接器按以下顺序寻找可执行的 `dsh`，命中即用：

1. `DSH_BRIDGE_DSH_BINARY` 环境变量（显式覆盖，最可靠）
2. `PATH` 中的 `dsh.cmd` / `dsh.exe` / `dsh.bat`
3. `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
   （以及旧产品名 `DSH Desktop`）
4. `%APPDATA%\DSH Desktop\host-commands\desktop\generations\*\bin\dsh.cmd`（由新到旧）
5. **Windows 卸载注册表**中 `DeepSeek Harness` 的 `InstallLocation`，
   再拼 `resources\runtime\cli\bin\dsh.cmd`（覆盖"装到任意目录"的情况）

### 0.2.2 与更早版本的区别

| 项 | 旧版 | 0.2.2 及以后 |
| --- | --- | --- |
| 主程序 | `DSH Desktop.exe` | `DeepSeek Harness.exe` |
| 应用代码 | `resources\app\lib\desktop-cli.js`（明文） | `resources\app.asar`（打包） |
| CLI 入口 | 由 host-command shim 间接提供 | `resources\runtime\cli\bin\dsh.cmd`（正规入口） |
| 默认安装位置 | 用户自选（本机曾在 `D:\应用软件\...\DSH Desktop`） | 安装器默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，也可改到别处 |

`headless` 的参数没有变化，仍是 `--json`、`--session-id`、`-`（读 stdin），因此桥接器的调用方式无需修改。

### 三个真实踩过的坑

- **旧 shim 会指向已卸载的安装**：升级或迁移后，`%APPDATA%\...\generations` 里的旧 shim 仍然存在，但它引用的 exe 已经不在。桥接器现在会解析 shim 并**校验目标 exe 是否存在**，不存在则跳过并尝试下一个候选；解析失败的 shim 也不再回退成直接 spawn 一个 `.cmd`（Windows 下必然 `spawn EINVAL`）。
- **安装位置会变**：如果 DSH 被装到非默认目录，`PATH` 与默认位置都找不到它。桥接器会读注册表兜底；也可以在 daemon 环境里显式设置
  `DSH_BRIDGE_DSH_BINARY=<安装目录>\resources\runtime\cli\bin\dsh.cmd`，或把该目录前置到用户 `PATH`。改完必须重启 daemon。
- **`reg query` 的输出不是 UTF-8**：中文系统上 `reg.exe` 按控制台代码页（GBK）输出，只按 UTF-8 解码会把安装路径变成乱码，于是每个候选都"不存在"。桥接器现在对同一段输出同时尝试 UTF-8 与 GBK，由文件是否存在来判定哪次解码正确。

### 找不到 DSH 时会发生什么

桥接器会立刻发出 `DSH_NOT_FOUND` 结果（实测 0.4s），**不会**傻等。但在 **resume 已有会话**的运行里，Multica daemon 会等到自己的空闲看门狗（默认 2 小时）才收尾，日志表现为：

```
idle watchdog firing: no agent activity, force-stopping run ... tool_in_flight=false
dsh finished ... frames=2
```

看到 `frames=2` + 长时间静默，就应当先检查 DSH 路径是否失效，而不是怀疑模型。


