# 全新电脑部署指南

目标：在一台**全新的 Windows 电脑**上部署完成后，你的手机可以直接给这台电脑上的 agent 派活，并收到结果。

全程约 20–30 分钟，其中大部分时间在装 DSH Desktop。

---

## 0. 先理解架构（决定排错方向）

```
手机 App ──┐
           ├──▶ Multica 云端 ──▶ 这台电脑的 daemon ──▶ DSH / Codex CLI
电脑浏览器 ─┘        ▲                    │
                     └── 任务状态 ◀────────┘
```

三个要点：

1. **手机不直连电脑**。手机连的是 Multica 云端，云端把任务路由到"在线的 runtime"。所以这台电脑必须**开着 daemon 且联网**。
2. **daemon 是执行者**。它负责拉起 `dsh-multica-bridge`，再由桥接器调用本机 DSH。
3. **手机与电脑必须在同一账号、同一工作区**，且该工作区里有一个分配了 DSH runtime 的 agent。

---

## 1. 前置条件

| 项 | 要求 | 检查方式 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 | `[Environment]::OSVersion.Version` |
| **DSH Desktop** | 已安装且可启动一次 | 安装后确认 `%LOCALAPPDATA%` 或安装目录下存在 `DSH Desktop.exe` |
| **Multica CLI** | `multica.exe` | `multica --version` 输出版本号 |
| **Multica 账号** | `mul_` 开头的 PAT，或可浏览器登录 | 向账号所有者索取 |
| **模型凭据** | DSH 的 headless profile 能解析到可用 provider | 见第 6 步 |
| 网络 | 可访问 `github.com` 与 Multica 云端 | `curl https://api.github.com` |
| Node.js | 不必须。桥接器会优先用 PATH 里的 `node`，否则用 DSH 自带的 | 见第 3 步 |

> **重要**：本机 `D:\应用软件\...` 这类中文安装路径可用，但**Android 构建不能放中文路径**（本文不涉及构建，仅部署）。

---

## 2. 取代码

```powershell
git clone -b integration/android-dsh https://github.com/DreamPerday/multica.git
cd multica
```

仓库是公开的，克隆不需要凭据。只有需要**推送**时才要登录 GitHub。

部署用的分支是 **`integration/android-dsh`**，它已经合并了桥接器与移动端两条线。

---

## 3. 安装桥接器

桥接器需要放到 Multica CLI 的同级目录，daemon 才能通过 PATH 解析到它。

```powershell
$dst = "$env:USERPROFILE\.multica\bin"
New-Item -ItemType Directory -Force -Path $dst | Out-Null

Copy-Item dsh-multica-bridge\bridge.mjs              $dst -Force
Copy-Item dsh-multica-bridge\dsh-multica-bridge.cmd  $dst -Force

# 记录哈希，便于以后核对
Get-FileHash "$dst\bridge.mjs" -Algorithm SHA256
```

**自检（不需要 DSH 参与，24 项协议断言）**：

```powershell
node dsh-multica-bridge\test\protocol.test.mjs
```

期望最后一行是 `all checks passed`。

> 如果提示找不到 `node`：DSH Desktop 自带一份，路径形如
> `%USERPROFILE%\.dsh\dsh-runtimes\<id>\dependencies\node\bin\node.exe`。
> 启动包装器 `dsh-multica-bridge.cmd` 会自动在 PATH 与上述目录中查找 node，**不需要手动装 Node.js**。

---

## 4. 登录 Multica

```powershell
multica login
```

浏览器会打开授权页；无浏览器的机器用：

```powershell
multica login --token mul_xxxxxxxx
```

登录成功后：

```powershell
multica workspace list     # 应列出至少一个工作区
```

---

## 5. 注册 DSH runtime

```powershell
multica runtime profile create `
  --command-name dsh-multica-bridge `
  --display-name "DeepSeek Harness (bridge)" `
  --protocol-family dsh `
  --output json
```

记下返回的 `id`，然后把它绑定到本机的可执行文件：

```powershell
multica runtime profile set-path <上一步的ID> `
  --path "$env:USERPROFILE\.multica\bin\dsh-multica-bridge.cmd"
```

**这一步是"每台机器各自做一次"**：profile 存在于工作区（团队共享），path 是本机绑定。所以第二台电脑部署时，可以直接复用已有的 profile，只需执行 `set-path`。

验证：

```powershell
multica daemon restart
multica runtime list
```

期望看到一行 `PROVIDER=dsh STATUS=online`。

---

## 6. 建 agent 并选模型

在 Multica 界面（网页或桌面端）：

1. 进入工作区 → Agents → 新建
2. Runtime 选 **DeepSeek Harness (bridge)**
3. **模型必须选一个 `provider/model` 形式的条目**（例如 `cc-switch-open-code-go/deepseek-v4.1-flash`）
4. 保存

> 如果模型下拉框是空的或保存后派活报 `MISSING_CREDENTIAL`，说明 headless profile 里没有可用 provider。
> 检查 `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml` 是否存在且含 provider 与 key。

---

## 7. 电脑端冒烟测试

```powershell
# 建一个测试 issue
multica issue create --title "部署验证" --description "只回答两个字：完成" --output json

# 分配给刚才建的 agent（名字按实际填）
multica issue assign <ISSUE_ID> --to "<你的 agent 名>"

# 轮询状态，期望 60 秒内变成 completed
multica issue runs <ISSUE_IDENTIFIER>
```

**通过标准**：状态为 `completed`，且 issue 里能看到 agent 的回答。

若卡在 `running` 超过 6 分钟，跳到第 10 节排错。

---

## 8. 手机端连接

### 8.1 安装 APK

Release 页面下载（手机上直接点开该链接）：

<https://github.com/DreamPerday/multica/releases/tag/android-v0.1.0>

| 文件 | 用途 |
| --- | --- |
| `multica-android-0.1.0-arm64-v8a.apk` | **手机安装这个**（45.19 MB） |

SHA256（下载后核对）：

```
6c2c9bd99c9c837ecabe52eec2c9285aced77c086660aca22ed7d953dd647085
```

手机上校验（Termux 或任意 hash 工具）：

```bash
sha256sum multica-android-0.1.0-arm64-v8a.apk
```

**安装步骤**：

1. 手机浏览器打开上面的 Release 链接 → 下载 APK
2. 系统提示"未知来源"时允许该浏览器安装
3. 安装完成打开 App

> 也可以用 USB：`adb install -r multica-android-0.1.0-arm64-v8a.apk`
>
> **不要**装 x86_64 的包，那是模拟器专用，真机装了会闪退。

### 8.2 登录并连到这台电脑

1. App 里登录**同一个 Multica 账号**
2. 选择**同一个工作区**
3. 打开 Agents / 聊天，选第 6 步建的 agent
4. 发一句话，例如"列出当前目录"

**成功标志**：

- 手机上能看到 agent 的回复
- 同时在这台电脑上能查到对应任务：`multica issue runs <IDENTIFIER>` 或 `multica daemon logs`

### 8.3 手机连不上的判断顺序

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| agent 列表里没有你的 agent | 不在同一工作区 | 手机端切到同一工作区 |
| agent 显示离线/不可用 | 电脑 daemon 没跑，或 runtime 非 online | 电脑执行 `multica daemon status` 与 `multica runtime list` |
| 消息发出但一直"输入中" | 见第 10 节 | 查 daemon 日志 |
| 完全收不到新消息推送 | 后台收不到推送是**已知限制**（APK 未接入 FCM） | 冷启动 App 或保持前台 |

---

## 9. 开机自启（可选但建议）

否则重启电脑后手机派活会失败。

```powershell
multica daemon autostart enable
multica daemon autostart status
```

---

## 10. 排错对照表

日志位置：`%USERPROFILE%\.multica\daemon.log`（多 profile 时还有 `%USERPROFILE%\.multica\profiles\<profile>\daemon.log`）。

| 报错 / 现象 | 含义 | 处理 |
| --- | --- | --- |
| `MISSING_CREDENTIAL: ... no API key for provider route "xxx"` | 选中的模型指向了没有凭据的 provider | 换一个已配置的模型，或修 headless profile |
| `agent execution context requires MULTICA_TOKEN to be a task-scoped mat_ token` | 桥接器的 CLI 包装器没生效 | 确认 `bridge.mjs` 是最新版；确认 `MULTICA_CLI_PATH` 指向临时包装器 |
| `dsh: session "..." was recorded in "...", not "..."` | 工作目录被迁移/联接过，会话记录里是旧绝对路径 | 换新会话，或修正会话记录 |
| `DSH_STALLED` | 无工具调用且 5 分钟无输出 → 模型侧挂死 | 看 daemon 日志中最后一条事件 |
| `DSH_TOOL_STALLED` | 有工具调用未返回且超过 11 分钟 → 命令挂死 | 常见于交互式 `ssh`、等待 stdin 的程序 |
| `dsh execution succeeded`（被标记失败） | 桥接器上报的 result 状态不是 `completed` | 确认 `bridge.mjs` 为最新版 |
| 回复完仍显示"输入中" | 回合结束信号没被处理 | 确认 `bridge.mjs` 处理 `turn_end` 且发完 result 后退出 |
| `dsh not found` | DSH Desktop 未安装或路径异常 | 重装 DSH Desktop；或设 `DSH_BRIDGE_DSH_PATH` |

### 可调参数（环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_BRIDGE_STALL_MS` | `300000` | 无工具调用时的静默上限 |
| `DSH_BRIDGE_TOOL_CEILING_MS` | `660000` | 有未返回工具调用时的上限 |
| `DSH_BRIDGE_PERMISSION_MODE` | `danger-full-access` | 传给 DSH 的沙箱模式 |
| `DSH_BRIDGE_WATCHDOG_LOG` | 未设置 | 打开后每 15 秒打印 idle 时间 |
| `DSH_BRIDGE_TRACE` | 未设置 | 打印每个 DSH 事件类型 |

设置后需 `multica daemon restart` 生效。

---

## 11. 安全说明（务必阅读）

桥接器默认用 **`danger-full-access`**，这是**必需**的：`workspace-write` 与 `read-only` 会丢弃命令输出，agent 无法工作。

这意味着：

> **被派活的 agent 可以读写这台电脑上该用户能访问的任何文件。**

因此：

- 不要把私钥、token、密码放在环境变量或易读路径
- 不要把这个 runtime 共享给不受信任的人
- 如果要多用户使用，建议单独的 Windows 账户运行 daemon
- 桥接器的临时令牌包装器在每次运行结束后删除，不会长期留在磁盘

---

## 12. 验收清单

部署完成后逐项打勾：

- [ ] `multica daemon status` 显示 running
- [ ] `multica runtime list` 中 dsh 一行 `STATUS=online`
- [ ] `node dsh-multica-bridge\test\protocol.test.mjs` 输出 `all checks passed`
- [ ] 电脑端冒烟 issue 状态为 `completed`，且有回答
- [ ] 手机装的是 `arm64-v8a` 包
- [ ] 手机登录同一账号、同一工作区
- [ ] 手机发消息能收到回复
- [ ] `multica daemon autostart status` 显示已启用

---

## 13. 已验证与未验证

**已验证（本机实测）**

- 协议测试 24 项通过
- 任务 40–60 秒内 `completed`
- 手机端已能正常调用本机 agent（由部署者确认）

**未验证 / 已知限制**

- 只在 **Windows** 验证；Linux/macOS 未测试
- 新的长工具上限（11 分钟）**没有做真实长跑验证**
- 手机端**后台收不到推送**（无 FCM 接入）；实时消息在部分场景需冷启动刷新
- 不同 DSH 版本可能改变事件名或 profile 结构，升级 DSH 后需重新跑第 7 步冒烟测试

---

## 相关文档

- `docs/DSH-BRIDGE-HANDOFF.md` —— 桥接器协议契约与实现细节
- `docs/ANDROID-HANDOFF.md` —— 移动端归属、构建约束
- `docs/RELEASE-ANDROID.md` —— 提交、合并、发布流程
