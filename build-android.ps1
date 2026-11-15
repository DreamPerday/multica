# 在 Windows 上构建 Multica Android APK。
#
# 源码真源是本目录（路径含中文），但 Android 的 NDK/AGP 在非 ASCII 路径下
# 会失败（.bat 脚本被按 GBK 截断、AGP 直接拒绝），所以构建在 $BuildRoot
# 这个纯 ASCII 路径下进行。详见 ANDROID_BUILD.md。
#
#     pwsh -File build-android.ps1
#
# 只用目录内的 .toolchain，不改系统环境变量。

[CmdletBinding()]
param(
    # 只编 arm64-v8a：绝大多数手机是这个架构，能大幅缩短构建时间。
    [string]$Arch = "arm64-v8a",
    [string]$BuildRoot = "D:\MulticaAndroid"
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 在 -File 调用下也能拿到脚本目录；$PSScriptRoot 在
# 某些宿主里为空，退回 $MyInvocation。
$SourceRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }

$Toolchain  = Join-Path $BuildRoot ".toolchain"
$Jdk        = Join-Path $Toolchain "jdk"
$Sdk        = Join-Path $Toolchain "android-sdk"
$Gradle     = Join-Path $Toolchain "gradle\bin\gradle.bat"
# Gradle 的 transforms 缓存会把 prefab 的 C++ 头文件路径拼到 260 字符以上，
# Windows 报 "Filename longer than 260 characters"。缓存目录必须尽量短。
$GradleHome = "D:\MH"
$Tmp        = Join-Path $BuildRoot ".tmp"
$MobileOut  = Join-Path $BuildRoot "apps\mobile"

Write-Host "==> 检查工具链" -ForegroundColor Cyan
foreach ($p in @($Jdk, $Sdk, $Gradle)) {
    if (-not (Test-Path $p)) { throw "缺少工具链组件: $p（见 ANDROID_BUILD.md「前置」）" }
}

# 构建期用到的所有临时目录都放 ASCII 路径下：Java 写入中文路径会被沙箱拦。
New-Item -ItemType Directory -Force -Path $Tmp, $GradleHome, (Join-Path $BuildRoot ".android-home") | Out-Null

$env:JAVA_HOME        = $Jdk
$env:ANDROID_HOME     = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
# sdkmanager/AGP 会在中文用户名下写 .android 缓存失败，必须显式指定。
$env:ANDROID_USER_HOME = Join-Path $BuildRoot ".android-home"
$env:GRADLE_USER_HOME  = $GradleHome
$env:TEMP              = $Tmp
$env:TMP               = $Tmp
$env:NODE_ENV          = "production"

# DSH 自带的 Node（本机没有全局 node）。
$NodeBin = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin"
if (-not (Test-Path $NodeBin)) { throw "找不到 Node: $NodeBin" }
$env:PATH = "$NodeBin;$Jdk\bin;$env:PATH"

$Pnpm = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
if (-not (Test-Path $Pnpm)) { throw "找不到 pnpm: $Pnpm" }

Write-Host "==> 同步源码到 $BuildRoot" -ForegroundColor Cyan
$robo = @(
    $SourceRoot, $BuildRoot, "/E", "/NFL", "/NDL", "/NJH", "/NJS",
    "/XD", "node_modules", ".git", ".toolchain", "dist", ".tmp",
    "apps\mobile\android\build", "apps\mobile\android\.gradle",
    "/XF", "*.zip"
)
robocopy @robo | Out-Null
# robocopy: 0-7 是成功，8+ 才是失败。
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败: $LASTEXITCODE" }

Write-Host "==> 安装依赖（hoisted 布局，见 .npmrc）" -ForegroundColor Cyan
Push-Location $BuildRoot
try {
    # --ignore-scripts 跳过 desktop 的 electron 后处理，Android 用不到；
    # 但 pnpm 的补丁仍会应用（补丁不依赖生命周期脚本）。
    #
    # pnpm/gradle 把进度和弃用提示写到 stderr；在 Stop 偏好下 PowerShell 会把
    # 这些当成终止错误并中断构建（例如 "[WARN] The pnpm field ... is no longer
    # read"）。这里临时降为 Continue，失败仍由下面的 $LASTEXITCODE 判定。
    $ErrorActionPreference = "Continue"
    & node $Pnpm install --no-frozen-lockfile --ignore-scripts
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" }
} finally { Pop-Location }

Write-Host "==> expo prebuild（生成 android/）" -ForegroundColor Cyan
Push-Location $MobileOut
try {
    $ErrorActionPreference = "Continue"
    & node $Pnpm exec expo prebuild --platform android --no-install
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -ne 0) { throw "prebuild 失败" }
} finally { Pop-Location }

$AndroidDir = Join-Path $MobileOut "android"
$GradleProps = Join-Path $AndroidDir "gradle.properties"

Write-Host "==> 写入 Android 构建参数" -ForegroundColor Cyan
$extra = @"

# 由 build-android.ps1 追加；prebuild 会重写本文件，所以每次构建都重新写。
# NDK 生成的 .bat 在非 ASCII 路径下会被截断，构建已固定在 ASCII 路径，
# 这里保留 override 以免手滑在中文路径直接构建时被 AGP 拦下。
android.overridePathCheck=true
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Djava.io.tmpdir=$($Tmp -replace '\\','/')
"@
# 幂等：先去掉上次追加的段落，避免重复。
$content = Get-Content $GradleProps -Raw
$content = $content -replace "(?s)# 由 build-android\.ps1 追加.*$", ""
Set-Content -Path $GradleProps -Value ($content.TrimEnd() + $extra) -Encoding UTF8

Write-Host "==> 清理上次的原生构建产物" -ForegroundColor Cyan
# 残留产物会让 Gradle 卡在 "Unable to delete file ... schema.json"。
foreach ($dir in @(
    (Join-Path $AndroidDir "build"),
    (Join-Path $AndroidDir ".gradle"),
    (Join-Path $AndroidDir "app\build")
)) {
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem (Join-Path $BuildRoot "node_modules") -Directory -Recurse -Depth 4 -Filter "android" -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "build") } |
    ForEach-Object { Remove-Item (Join-Path $_.FullName "build") -Recurse -Force -ErrorAction SilentlyContinue }
# NDK 的 .cxx（CMake/ninja 输出）会记住上次的路径与 Gradle 缓存位置，路径一变
# 就报 "immutable workspace ... have been modified" / 长路径错误。
Get-ChildItem (Join-Path $BuildRoot "node_modules") -Directory -Recurse -Depth 4 -Filter ".cxx" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $GradleHome "caches\9.3.1\transforms") -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "==> gradle assembleRelease（首次约 13 分钟）" -ForegroundColor Cyan
Push-Location $AndroidDir
try {
    # 直接用解压的 gradle，不用 gradlew：wrapper 在代理下反复下载分发包失败。
    $ErrorActionPreference = "Continue"
    & $Gradle assembleRelease --no-daemon "-PreactNativeArchitectures=$Arch"
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -ne 0) { throw "gradle 构建失败" }
} finally { Pop-Location }

$Apk = Join-Path $AndroidDir "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $Apk)) { throw "构建报告成功但找不到 APK: $Apk" }

$Dist = Join-Path $SourceRoot "dist"
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$Out = Join-Path $Dist "multica-android-dev-$Arch.apk"
Copy-Item $Apk $Out -Force

$hash = (Get-FileHash $Out -Algorithm SHA256).Hash
$size = [math]::Round((Get-Item $Out).Length / 1MB, 2)

Write-Host ""
Write-Host "==> 完成" -ForegroundColor Green
Write-Host "    APK : $Out"
Write-Host "    大小: $size MB"
Write-Host "    SHA256: $hash"
