# 修复 APK 里的 libc++_shared.so（第二版：改用解包 + 重打包）。
#
# 背景：react-android 0.86.3 的 AAR 自带一份旧的 libc++_shared.so，缺少
# __cxa_init_primary_exception 符号；而 libfbjni.so（Clang 18+ 构建）在加载时
# 需要该符号，导致 App 启动即崩溃：
#     couldn't find DSO to load: libfbjni.so
#
# 为什么不在 Gradle 里解决：该 .so 内嵌在 react-android 的 AAR 里，不是独立的
# Maven 构件，exclude / force / pickFirsts 都无法改变 AGP 的 native 合并结果
# （已逐一实测）。所以在构建产物上直接改。
#
# 为什么第一版会 INSTALL_FAILED_INVALID_APK：
# 用 System.IO.Compression 重写 zip 时，.so 条目的通用标志位与 AGP 产物不一致
# （AGP 用 16KB 对齐的 STORED 条目并置位，重写后对齐信息丢失），安装期解压
# native 库失败（res=-2）。本版改为：解包 → 原地替换文件 → 让 zipalign 重建
# 整个 zip 的对齐。
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File fix-libcxx.ps1 <in.apk> <out.apk>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InApk,
    [Parameter(Mandatory = $true)][string]$OutApk
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Toolchain = "D:\MulticaAndroid\.toolchain"
$BuildToolDir = Join-Path $Toolchain "android-sdk\build-tools\36.0.0"
$ApkSigner = Join-Path $BuildToolDir "apksigner.bat"
$Zipalign = Join-Path $BuildToolDir "zipalign.exe"
$Keystore = "D:\MulticaAndroid\apps\mobile\android\app\debug.keystore"
$env:JAVA_HOME = Join-Path $Toolchain "jdk"

$Candidates = Get-ChildItem "D:\MH\caches\modules-2\files-2.1\com.facebook.fbjni" -Recurse -Filter "fbjni-0.8.1.aar" -ErrorAction SilentlyContinue
if (-not $Candidates) { throw "找不到 fbjni-0.8.1.aar" }
$FbjniAar = $Candidates[0].FullName
Write-Host "使用 fbjni AAR: $FbjniAar" -ForegroundColor Cyan

$Want = @("x86_64", "x86", "arm64-v8a", "armeabi-v7a")
$Replacement = @{}
$z = [System.IO.Compression.ZipFile]::OpenRead($FbjniAar)
try {
    foreach ($e in $z.Entries) {
        if ($e.FullName -match '^jni/([^/]+)/libc\+\+_shared\.so$' -and $Want -contains $matches[1]) {
            $ms = New-Object System.IO.MemoryStream
            $s = $e.Open(); $s.CopyTo($ms); $s.Dispose()
            $Replacement[$matches[1]] = $ms.ToArray()
            Write-Host ("  取到 {0}: {1} KB" -f $matches[1], [math]::Round($ms.Length / 1KB, 1))
        }
    }
} finally { $z.Dispose() }
if ($Replacement.Count -eq 0) { throw "fbjni AAR 里没找到任何 libc++_shared.so" }

# 解包到临时目录。
$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("libcxx-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
# ExtractToDirectory 遇到大小写重名（如 res/-k.xml）会抛异常；逐条目解包并跳过
# Windows 上无法并存的重名项（与 native 库无关）。
$zipIn = [System.IO.Compression.ZipFile]::OpenRead($InApk)
try {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zipIn.Entries) {
        if ([string]::IsNullOrEmpty($entry.Name)) { continue }
        if (-not $seen.Add($entry.FullName)) { continue }
        $destFile = Join-Path $Stage $entry.FullName
        New-Item -ItemType Directory -Force -Path (Split-Path $destFile -Parent) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destFile, $true)
    }
} finally { $zipIn.Dispose() }

# 删除旧签名（v1 META-INF 条目），它们会在重签名后与内容不符。
$MetaInf = Join-Path $Stage "META-INF"
if (Test-Path $MetaInf) {
    Get-ChildItem $MetaInf -File |
        Where-Object { $_.Name -match '\.(RSA|DSA|EC|SF)$|^MANIFEST\.MF$' } |
        Remove-Item -Force
}

# 就地替换 .so。
$replaced = 0
foreach ($abi in $Want) {
    $target = Join-Path $Stage "lib\$abi\libc++_shared.so"
    if (Test-Path $target) {
        [System.IO.File]::WriteAllBytes($target, $Replacement[$abi])
        $replaced++
        Write-Host ("  替换 lib/{0}/libc++_shared.so ({1} KB)" -f $abi, [math]::Round($Replacement[$abi].Length / 1KB, 1)) -ForegroundColor Green
    }
}
if ($replaced -eq 0) { throw "APK 里没有 lib/*/libc++_shared.so" }

# 用 java 自带 jar 工具重建 zip（避免 PowerShell 压缩库写坏对齐标记），
# 再由 zipalign 统一重建 16KB 对齐。
Write-Host "==> 重打包 (+zipalign)" -ForegroundColor Cyan
# 必须 -mx=0（STORED 不压缩）：manifest 里 extractNativeLibs=false，要求 .so
# 以 STORED 存放再由 zipalign 做 16KB 对齐。用 jar 重打包会 deflate，安装期报
# INSTALL_FAILED_INVALID_APK: Failed to extract native libraries, res=-2。
$SevenZip = Get-ChildItem "D:\MulticaAndroid\node_modules\7zip-bin\win" -Recurse -Filter "7za.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1 -ExpandProperty FullName
if (-not $SevenZip) {
    $SevenZip = Get-ChildItem "D:\MulticaAndroid\node_modules\7zip-bin\win" -Recurse -Filter "7za.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $SevenZip) { throw "找不到 7za.exe" }

$Raw = $OutApk + ".raw"
Push-Location $Stage
try {
    & $SevenZip a -tzip -mx=0 -r $Raw * | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7za 打包失败: $LASTEXITCODE" }
} finally { Pop-Location }

$Aligned = $OutApk + ".aligned"
& $Zipalign -f -P 16 4 $Raw $Aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败: $LASTEXITCODE" }

Write-Host "==> 签名" -ForegroundColor Cyan
$SignedTmp = $OutApk + ".signed"
& $ApkSigner sign --ks $Keystore --ks-pass pass:android --key-pass pass:android `
    --ks-key-alias androiddebugkey --min-sdk-version 24 --out $SignedTmp $Aligned
if ($LASTEXITCODE -ne 0) { throw "签名失败: $LASTEXITCODE" }
Move-Item $SignedTmp $OutApk -Force

Write-Host "==> 验证签名" -ForegroundColor Cyan
& $ApkSigner verify $OutApk
if ($LASTEXITCODE -ne 0) { throw "签名校验失败" }

Remove-Item $Raw, $Aligned -Force -ErrorAction SilentlyContinue
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==> 完成: $OutApk" -ForegroundColor Green
Write-Host "    SHA256: $((Get-FileHash $OutApk -Algorithm SHA256).Hash)"
