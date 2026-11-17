# 在 Windows 上构建 Multica Android APK

上游 [multica-ai/multica](https://github.com/multica-ai/multica) **只有 iOS 客户端**（`apps/mobile` 是 Expo + React Native，但只配了 iOS 平台）。本目录是把同一个移动端代码库接到 Android 的工作区，**不改上游应用逻辑**，只增加平台配置和一个依赖补丁。

产物：`dist/multica-android-dev-arm64-v8a.apk`（44.47 MB，包名 `ai.multica.mobile.dev`，minSdk 24 / targetSdk 36，APK Signature Scheme v2 已签名）。构建脚本已完整跑通：`BUILD SUCCESSFUL in 3m 31s`（增量，`D:\MH` 缓存热身之后）。

## 为什么必须用 ASCII 路径构建

Android 的 NDK 与 AGP 在 **Windows + 非 ASCII 路径**下会失败，而且失败得很晚：

| 现象 | 根因 |
|---|---|
| `prefab_command.bat` 报 `'ca' 不是内部或外部命令` | NDK 生成的 `.bat` 里路径被按 GBK 截断，`D:\养猪\` 变成 `D:\鍏荤尓\` |
| AGP 直接拒绝 `Your project path contains non-ASCII characters` | AGP 自带的防护检查 |

所以**源码留在 `D:\养猪\Multica Android`（你指定的位置），构建在 `D:\MulticaAndroid` 进行**。两棵树用 `build-android.ps1` 同步，源码树是唯一真源。

## 前置：便携工具链

全部装在目录内，**不改系统环境变量、不写注册表**：

| 组件 | 路径 | 来源 |
|---|---|---|
| JDK 17 | `.toolchain/jdk-17.0.21.0.2+1` | Microsoft OpenJDK 17 ZIP（SHA256 `303FF40A…C6D3D4` 对过官方清单） |
| Android SDK | `.toolchain/android-sdk` | cmdline-tools `13114758` + `platforms;android-36` + `build-tools;36.0.0` + `platform-tools` |
| Gradle 9.3.1 | `.toolchain/gradle/gradle-9.3.1` | 直接解压使用，**绕开 gradlew 包装器**（wrapper 在代理下反复下载失败） |
| Node 24 | DSH 自带 | `C:\Users\Administrator\.dsh\dsh-runtimes\...\node\bin` |

## 构建

```powershell
pwsh -File build-android.ps1
```

脚本做的事，按顺序：

1. 同步源码到 `D:\MulticaAndroid`（跳过 `node_modules`、`.git`、构建产物）
2. 在 ASCII 路径 `pnpm install`（`.npmrc` 里的 `node-linker=hoisted` 让原生模块可写）
3. `expo prebuild --platform android` 生成 `android/`
4. 写入 `android.overridePathCheck` 与 JVM 临时目录
5. `gradle assembleRelease`（只编 `arm64-v8a`，绝大多数手机都是这个）
6. 把 APK 复制回 `dist/`

## 踩过的坑（都已解决，改环境时别倒退）

### 1. `masked-view` 构建期回写自己的 manifest

`expo-router` 间接依赖 `@react-native-masked-view/masked-view@0.3.2`，它在 `android/build.gradle` 里把 `AndroidManifest.xml` 读出来、剥掉 `package` 属性、**再写回同一文件**。在只读存储或受限环境下必然 `AccessDeniedException`。

AGP 7+ 已经用 `namespace` 提供包名，这个回写完全多余。补丁在 `patches/@react-native-masked-view__masked-view@0.3.2.patch`，只让它在 AGP < 7 时执行。**这是仓库里唯一的源码级改动。**

### 2. pnpm 的隔离布局让 expo 插件解析不到

默认 `.pnpm` 软链布局下，`expo-image` 的 `plugin/build/withExpoImage` 从 `apps/mobile` 解析不到，`createExpoConfig` 任务挂掉。`.npmrc` 里设 `node-linker=hoisted` 后，顶层是实体目录，问题消失。

### 3. 构建产物残留会锁死后续构建

`.pnpm` 或 `node_modules/*/android/build` 下的旧产物会让 Gradle 卡在 `Unable to delete file ... schema.json`。脚本会先清这些目录。

### 4. JVM 参数里的中文路径

`org.gradle.jvmargs` 里带空格路径会被 Gradle 拆错（`Cannot locate tasks ... .gradle.jvmargs`）。让它指向 ASCII 路径 `D:/MulticaAndroid/.tmp`，且只写在 `gradle.properties` 里、**不要**用 `GRADLE_OPTS`（同样会被拆分）。

### 5. 代理

本机走代理，但 **Java 不读 `HTTP_PROXY` 环境变量**。Gradle 依赖下载靠 `$GRADLE_USER_HOME/gradle.properties` 里的 `systemProp.https.proxyHost/Port`；`sdkmanager` 靠 `--proxy` 参数（或同样的 systemProp）。另外 `sdkmanager` 在中文用户名下会因 `.android` 缓存路径失败，必须设 `ANDROID_USER_HOME` 到可写目录。

### 6. Gradle 缓存路径必须短 + 长路径支持

Gradle 的 `transforms` 缓存会把 prefab 的 C++ 头文件路径拼到 227 字符以上，`ninja` 在 Windows 未开启长路径时直接报 `Filename longer than 260 characters`。两个必要条件，缺一不可：

- `GRADLE_USER_HOME` 指向短路径 `D:\MH`（不要放 `...\.toolchain\gradle-home`）
- 注册表 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`（本机原为 0，已改）

### 7. CMake 缓存与 transforms 缓存会"记仇"

改过路径后，旧的 `.cxx` 与 `transforms` 缓存会让 Gradle 报 *"immutable workspace ... have been modified"* 或继续引用旧路径。`build-android.ps1` 每次构建都会先清 `node_modules/*/android/build`、`node_modules/*/.cxx` 和 `transforms`。

## 装到手机

APK 在 `dist/multica-android-dev-arm64-v8a.apk`。手机是 ARM64（近几年的安卓机都是），若装不上再补 `x86_64` 架构重编。

**方式一：数据线 + adb**（工具链自带 adb）

```powershell
$d = "D:\养猪\Multica Android"
$env:ANDROID_USER_HOME = "$d\.toolchain\.android-home"
$env:TEMP = "$d\.toolchain\tmp"; $env:TMP = $env:TEMP   # 否则 adb 报 adb.log 权限失败
& "$d\.toolchain\android-sdk\platform-tools\adb.exe" devices
& "$d\.toolchain\android-sdk\platform-tools\adb.exe" install -r "$d\dist\multica-android-dev-arm64-v8a.apk"
```

手机需先开 **开发者选项 → USB 调试**，并在弹窗里允许这台电脑。

**方式二：直接传文件**

把 APK 拷到手机（微信/网盘/数据线都行），在手机上点开安装，允许"安装未知来源应用"。这种方式不需要 adb。

> 注意：这是用 **Android Debug 证书**签名的 APK。能正常安装，但**不能覆盖安装**官方签名的版本，也不能上应用商店。每次重装用 `adb install -r` 保留数据。

## 尚未做的（重要）

**这个 APK 只验证了「能构建、能签名、结构完整」，没有在真机上跑过。**

上游移动端按 iOS 假设写了不少交互，Android 上会出问题：

| 位置 | 问题 |
|---|---|
| `ActionSheetIOS`（7 处：inbox、issue、project、profile、chat 消息、评论卡片） | Android 上是空实现，菜单点了没反应 |
| `DateTimePicker display="inline"`（截止日期选择器） | Android 不支持 inline 模式 |
| `presentation: "formSheet"` + `sheetAllowedDetents` | 是 iOS 语义，Android 会退化成普通全屏或出错 |
| `statusBarStyle` / safe area | 需要按 Android 的 inset 校验 |

这些要等真机上确认实际表现再改，**不能凭代码猜测**。首次装机建议先跑登录、看板、issue 详情、评论这条主链路。
