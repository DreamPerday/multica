# Android 交接说明

本分支是从上游 `013be77` 派生的 **Android 适配分支**，只包含移动端改造与构建脚本。

## 归属与边界

| 范围 | 分支 | 负责 |
| --- | --- | --- |
| 移动端 Android 适配 | `feat/android`（本分支） | 另一台电脑 |
| DSH 运行时桥接器 | `feat/dsh-bridge` | 本机 |
| 两者合并 | `integration/android-dsh` | 集成分支，第三台部署用 |

- **本分支不含 `dsh-multica-bridge/`**，请不要在此新增桥接器代码。
- 桥接器分支**不改动** `apps/mobile/**`，两边路径不重叠，正常情况不会冲突。

## 工作方式

两台电脑使用同一个 GitHub 账号，因此可以直接推送，无需协作者权限。

推荐流程（避免互相覆盖）：

```bash
git clone -b feat/android https://github.com/DreamPerday/multica.git
cd multica
git checkout -b feat/android-<你的机器名或主题>
# 改动…
git push -u origin feat/android-<你的机器名或主题>
```

然后开 PR，**base 选 `feat/android`**（或 `integration/android-dsh`）。直接推 `feat/android` 也可以，但那样本机合并前必须先 `git fetch`，否则会分叉。

## 本分支包含的改动

新增：

- `apps/mobile/components/ui/action-sheet.tsx`：跨平台操作表，替代 iOS 专有的 `ActionSheetIOS`
- `apps/mobile/components/ui/platform-icon.tsx`：iOS 用 SF Symbols，Android 用 Ionicons
- `apps/mobile/plugins/with-fbjni-libcxx.js`：config plugin，对齐 fbjni 与 `libc++_shared.so`
- `apps/mobile/assets/adaptive-icon.png`：自适应启动图标（标记归一化到画布 42%）
- `build-android.ps1`、`capture-crash.ps1`、`fix-libcxx.ps1`、`replace-apk-entry.ps1`
- `ANDROID_BUILD.md`、`CRASH_TRIAGE.md`
- `patches/@react-native-masked-view__masked-view@0.3.2.patch`

修改：底部导航与多处操作菜单改用跨平台组件；`ws-client.ts` 如实上报 `client_os`；`app.config.ts` 注册插件与自适应图标。

## 构建约束（改动前必读）

1. **必须在纯 ASCII 路径下构建**。AGP 与 NDK 的 `.bat` 脚本在中文路径下会失败；源真身可以在中文路径，另建镜像目录构建。
2. **`expo prebuild` 会重建 `android/`**，任何原生侧修改都要做成 config plugin，不要手工改生成物。
3. `build-android.ps1` 需要 **UTF-8 with BOM**；PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，导致解析错误。
4. 长路径会触发 260 字符上限，需要 `LongPathsEnabled` 与独立的 `GRADLE_USER_HOME`。

细节见 `ANDROID_BUILD.md` 与 `CRASH_TRIAGE.md`。

## 已验证可启动的配置

- RN 0.86.3 / Expo SDK 57 / Hermes / New Architecture
- AGP 8 + Gradle 9.3.1 + JDK 17 + build-tools 36.0.0 + NDK 27.1
- `expo.useLegacyPackaging=true`（否则启动崩溃：`Resources$NotFoundException: drawable/abc_vector_test`）
- fbjni 0.8.1 + `libc++_shared.so` 覆盖（否则 `dlopen failed: cannot locate symbol "__cxa_init_primary_exception"`）

## 已知未解

- **实时消息**：WebSocket 升级成功、auth 帧已发，服务端不回 `auth_ack` 也不报错；只有冷启动重拉 REST 才能看到新内容。客户端已加 `client_os`、auth 超时重连、首帧补发，根因未定位。
- **无推送能力**：依赖树中没有 `expo-notifications`/FCM，App 退到后台会 pause socket，后台收不到消息属现状。

## 验收命令

```powershell
# 类型检查
pnpm --filter mobile exec tsc --noEmit

# 单测
pnpm --filter mobile exec vitest run
```

真机/模拟器安装：

```powershell
adb install -r dist\multica-android-dev-arm64-v8a.apk
```
