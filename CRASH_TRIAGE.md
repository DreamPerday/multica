# 闪退排查记录

APK：`dist/multica-android-dev-arm64-v8a.apk`（首次交付）与 `dist/multica-android-dev-nominify-arm64-v8a.apk`（对照用，未做 R8 裁剪）。
现象：**开屏即闪退，进不去**（用户 2026-11-14 报告）。

## 已排除的原因（有据可查）

| 检查项 | 结论 | 依据 |
|---|---|---|
| APK 结构完整性 | 正常 | assets/index.android.bundle 存在；3 个 dex；29 个 .so |
| 签名 | 正常 | apksigner: APK Signature Scheme v2 verified |
| 16KB 页对齐 | 全部合规 | 29 个 .so 的 `p_align` 均 ≥ 16384 |
| APK zip 对齐 | 合规 | `zipalign -c -P 16 -v 4` 全 OK |
| Hermes bundle | 正常 | 前 8 字节 `C6 1F BC 03...` = Hermes 字节码，非明文 JS |
| `MainActivity` / `MainApplication` | 存在 | 在 classes.dex 中搜到 `Lai/multica/mobile/dev/MainActivity;` |
| Expo 模块类（securestore 等） | 未被裁剪 | `seeds.txt` 确认保留；`usage.txt` 是"被分析"不是"被删除"，易误判 |
| `AppTheme` / `splashscreen_logo` | 资源齐全 | aapt2 dump resources 找到两个资源 |
| R8 裁剪（首次 APK） | 已排除 | dex 中 MainActivity 与 expo 模块仍在 |

> 注：`dexdump`/`apkanalyzer` 在中文路径下不可用，需在 `D:\MulticaAndroid` 用 `[System.IO.Compression]` + 字节搜索验证。

## 现象补充（用户 2026-11-14 反馈）

- **看到了启动页/白屏，然后才退出** —— 这一条最关键：说明 `MainActivity` 已创建、`Application` 启动成功，崩溃发生在**首屏渲染阶段**（React 根组件挂载或 JS 模块初始化），而不是原生入口。
- **国产手机**（小米/OPPO/vivo/华为/荣耀等）。

据此收窄：原生入口、签名、APK 结构、主题资源、dex 完整性都已排除，重点转向 **JS 启动路径**。

## 待验证的假设（按可能性排序）

1. **`prewarmHighlighter()` 在模块加载时同步执行**（`app/_layout.tsx:27`）。
   它立即调用 `react-native-shiki-engine` 的 `createNativeEngine()`（JSI + Oniguruma C++ 原生引擎）。若该原生模块在 Android 上初始化失败，会在 React 挂载前崩溃。
   → **已产出对照 APK：`dist/multica-android-dev-noshiki-arm64-v8a.apk`**（仅注释掉这一行，与原版唯一差异，bundle 哈希已确认变化）。
2. **R8 裁剪**。已在上述对照版中一并关闭（`--project-prop android.enableMinifyInReleaseBuilds=false` 用于 nominify 版）。
3. `react-native-keyboard-controller` 的 `KeyboardProvider` 包裹整个应用。
4. `expo-router` 的 `unstable_settings.anchor: "(tabs)"` 在 Android 上锚点解析失败。

## 需要用户提供的信息

最快定位方式（任选其一）：

### A. logcat（最优）

手机开 USB 调试并连电脑，然后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\养猪\Multica Android\capture-crash.ps1"
```

生成的 `crash-logs/crash-*.txt` 里会有 `FATAL EXCEPTION` 堆栈，把它发我即可。

### B. 手动查看崩溃

手机 **设置 → 应用 → Multica (Dev) → 存储** 附近通常有崩溃信息；或用第三方 App（如 MatLog）。把含 `FATAL EXCEPTION` / `Caused by` 的几行发我。

### C. 最省事的对照实验

现在有三个 APK 可选，**按顺序试，哪个能进就说明问题在哪**：

```powershell
$adb = "D:\养猪\Multica Android\.toolchain\android-sdk\platform-tools\adb.exe"
$env:ANDROID_USER_HOME = "D:\养猪\Multica Android\.toolchain\.android-home"
$env:TEMP = "D:\养猪\Multica Android\.toolchain\tmp"; $env:TMP = $env:TEMP

# ① 关掉 Shiki 预热（最可疑）
& $adb install -r "D:\养猪\Multica Android\dist\multica-android-dev-noshiki-arm64-v8a.apk"

# ② 关掉 R8 裁剪
& $adb install -r "D:\养猪\Multica Android\dist\multica-android-dev-nominify-arm64-v8a.apk"
```

| 结果 | 结论 |
|---|---|
| ① 能进 | 崩溃源是 `react-native-shiki-engine` 的 JSI 初始化，我把 Markdown 代码高亮改成懒加载 + Android 降级为纯文本 |
| 仅 ② 能进 | 是 R8 裁剪问题，我补 keep 规则 |
| 都不行 | 原生/启动配置问题，必须看 logcat（用 A 方案） |

## 无论哪条路，都需要的环境信息

- 手机型号与 Android 版本（如 "小米 14 / Android 15"）
- 是"直接点开图标就闪"还是"闪一下启动页再退出"
- 有没有弹"Multica 已停止运行"的系统对话框，还是纯静默消失

## 复现构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\养猪\Multica Android\build-android.ps1"
```
