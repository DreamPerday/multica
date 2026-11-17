# Android 提交与发布流程

面向在**另一台电脑**上继续 Android 工作的协作者。两台电脑使用同一个 GitHub 账号（`DreamPerday`），因此可以直接推送，不需要协作者权限。

## 分支模型

```
main                   上游基线，不改动
├─ feat/android        移动端适配（本分支，另一台电脑负责）
├─ feat/dsh-bridge     DSH 运行时桥接器（本机负责）
└─ integration/android-dsh   两者合并，供第三台部署和发布使用
```

两边改动路径不重叠：移动端只碰 `apps/mobile/**` 与构建脚本，桥接器只在 `dsh-multica-bridge/`。

顺序约定：

```
协作者 PR → 合入 feat/android → 本机合并到 integration/android-dsh → 打 release
```

## 1. 提交到 fork

```bash
git clone https://github.com/DreamPerday/multica.git
cd multica
git checkout feat/android
git checkout -b feat/android-<机器名或主题>

# 改动…
git add -A
git commit -m "feat(mobile): <一句话说明>"
git push -u origin feat/android-<机器名或主题>
```

提交信息使用 conventional commits（`feat(mobile):`、`fix(mobile):`、`docs(mobile):`），这是本仓库的约定。

**不要把 `dist/` 里的 APK 提交进仓库**。仓库已忽略 `dist/`，二进制走 Release 附件。

## 2. 合并到 fork

开 PR，**base 选 `feat/android`**：

```
https://github.com/DreamPerday/multica/compare/feat/android...feat/android-<分支名>?expand=1
```

PR 描述按仓库模板填写，缺项会被拒：

```markdown
## Problem
Android 客户端在 … 场景下 …

## Goal
… 可正常使用。

## Proposal
改了 A（文件路径），思路是 B。

## Alternatives
考虑过 C，因为 D 没采用。

## Screenshots
（UI / 交互改动必须附截图或录屏）
```

> 仓库 `AGENTS.md` 明确要求：UI 或交互改动缺少截图与录屏时默认拒绝。真机验证通过的界面截几张即可。

合并完成后通知本机，由本机同步 `integration/android-dsh`。

## 3. 发布 release

### ⚠️ 不要推送 `vX.Y.Z` 形式的 tag

`.github/workflows/release.yml` 的触发条件是：

```yaml
on:
  push:
    tags:
      - "v*.*.*"
      - "!v*-dirty*"
```

该工作流用于**服务端与桌面端**发布：跑 Go 测试与 `govulncheck`、构建容器镜像、发布 Homebrew formula。**它不构建 Android APK**。用 `vX.Y.Z` 打手机包只会浪费一轮 CI，并且可能因为与正式版本号冲突而失败。

### 正确做法：使用不匹配的 tag

tag 使用 `android-vX.Y.Z`（不匹配 `v*.*.*`，不会触发 Release workflow）。

**网页操作：**

1. 打开 https://github.com/DreamPerday/multica/releases/new
2. **Choose a tag** 输入 `android-v0.1.0`，选择 *Create new tag on publish*
3. **Target** 选 `integration/android-dsh`
4. Title 填 `Multica Android 0.1.0`
5. 上传 `arm64-v8a` 的 APK（手机用；`x86_64` 仅供模拟器，不必上传）
6. 描述中写明安装方式、已知问题、APK 的 SHA256

**API 操作：**

```bash
# 创建 release，记下返回的 id
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DreamPerday/multica/releases \
  -d '{
    "tag_name": "android-v0.1.0",
    "target_commitish": "integration/android-dsh",
    "name": "Multica Android 0.1.0",
    "body": "安装：adb install -r <apk>"
  }'

# 上传 APK
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary @multica-android-dev-arm64-v8a.apk \
  "https://uploads.github.com/repos/DreamPerday/multica/releases/<RELEASE_ID>/assets?name=multica-android-0.1.0-arm64-v8a.apk"
```

### 发布后自检

- Release 页面能看到 APK，点击可下载
- 下载后 `sha256sum` 与本地构建产物一致
- tag 是 `android-v0.1.0`，**不是** `v0.1.0`
- 确认没有触发 Release workflow（Actions 页面无新增 run）

## 4. 版本号约定

- Release tag：`android-vX.Y.Z`
- APK 文件名：`multica-android-<version>-<abi>.apk`
- 版本号递增规则：修复缺陷 → patch；新增能力 → minor；不兼容变更 → major

## 已知问题（发布说明中应如实写出）

- 实时消息：WebSocket 升级成功、auth 帧已发送，但服务端不回 `auth_ack`，需冷启动重拉 REST 才能看到新内容（如果已修复请更新本节）
- 无推送能力：依赖树中无 `expo-notifications`/FCM，App 退到后台会 pause socket
- 仅在 Android 验证；未覆盖 iOS

## 构建约束（发布前必须确认）

1. 构建在**纯 ASCII 路径**下进行，中文路径会让 AGP 与 NDK 脚本失败
2. `expo prebuild` 会重建 `android/`，原生修改必须做成 config plugin
3. PowerShell 脚本必须保存为 **UTF-8 with BOM**
4. 长路径受 260 字符限制，需要独立 `GRADLE_USER_HOME`

详见 `ANDROID_BUILD.md` 与 `CRASH_TRIAGE.md`。
