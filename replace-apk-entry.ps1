# 原地替换 APK 中指定 zip 条目的内容，不重打包整个 APK。
#
# 为什么不用解包/重打包：APK 里存在仅大小写不同的条目（res/hq.xml、res/HQ.xml、
# res/Hq.xml），Windows 文件系统把它们当成同一个文件，往返一次就丢内容，
# 导致启动时 Resources$NotFoundException。这里直接改写 zip 二进制。
#
# 因新内容字节数与原内容不同，必须重建 central directory：做法是把目标条目
# 用 STORED 方式追加到文件尾，再删掉旧条目——这不现实。采用更简单的路线：
# 保持条目顺序，把所有条目内容重新写入新 zip，但每条都按原始名字精确写入
# （不经文件系统，重名不会冲突），并保留 .so 的 STORED + 对齐要求。
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File replace-apk-entry.ps1 `
#         -InApk a.apk -OutApk b.apk -AbiLibcxx

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

$FbjniAar = (Get-ChildItem "D:\MH\caches\modules-2\files-2.1\com.facebook.fbjni" -Recurse -Filter "fbjni-0.8.1.aar" -ErrorAction SilentlyContinue)[0].FullName
if (-not $FbjniAar) { throw "找不到 fbjni-0.8.1.aar" }
Write-Host "fbjni AAR: $FbjniAar" -ForegroundColor Cyan

$Want = @("x86_64", "x86", "arm64-v8a", "armeabi-v7a")
$Replacement = @{}
$za = [System.IO.Compression.ZipFile]::OpenRead($FbjniAar)
try {
    foreach ($e in $za.Entries) {
        if ($e.FullName -match '^jni/([^/]+)/libc\+\+_shared\.so$' -and $Want -contains $matches[1]) {
            $ms = New-Object System.IO.MemoryStream
            $s = $e.Open(); $s.CopyTo($ms); $s.Dispose()
            $Replacement[$matches[1]] = $ms.ToArray()
        }
    }
} finally { $za.Dispose() }
Write-Host ("取到 {0} 个架构的 libc++" -f $Replacement.Count)

# 逐条目流式重建：用原始条目名写回，不经文件系统，重名不冲突。
$Temp = $OutApk + ".rebuild"
$src = [System.IO.Compression.ZipFile]::OpenRead($InApk)
$dst = New-Object System.IO.Compression.ZipArchive(
    [System.IO.File]::Open($Temp, [System.IO.FileMode]::Create),
    [System.IO.Compression.ZipArchiveMode]::Create
)
$replaced = 0
try {
    foreach ($e in $src.Entries) {
        $name = $e.FullName
        $isLib = $name -match '^lib/([^/]+)/libc\+\+_shared\.so$'
        $abi = if ($isLib) { $matches[1] } else { $null }

        if ($isLib -and $Replacement.ContainsKey($abi)) {
            $data = $Replacement[$abi]
        } else {
            $ms = New-Object System.IO.MemoryStream
            $s = $e.Open(); $s.CopyTo($ms); $s.Dispose()
            $data = $ms.ToArray()
        }

        # .so 必须 STORED（manifest 里 extractNativeLibs 可能为 false），
        # 其余条目保持不压缩也无妨——体积略大但绝对安全。
        $level = [System.IO.Compression.CompressionLevel]::NoCompression
        $ne = $dst.CreateEntry($name, $level)
        if ($e.LastWriteTime -ne $null) { $ne.LastWriteTime = $e.LastWriteTime }
        $os = $ne.Open()
        $os.Write($data, 0, $data.Length)
        $os.Dispose()

        if ($isLib -and $Replacement.ContainsKey($abi)) {
            $replaced++
            Write-Host ("  替换 {0} -> {1} KB" -f $name, [math]::Round($data.Length / 1KB, 1)) -ForegroundColor Green
        }
    }
} finally {
    $src.Dispose(); $dst.Dispose()
}
if ($replaced -eq 0) { throw "没有替换任何 libc++_shared.so" }

Move-Item $Temp $OutApk -Force

# 对齐 + 签名
$Aligned = $OutApk + ".aligned"
& $Zipalign -f -P 16 4 $OutApk $Aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败: $LASTEXITCODE" }

$SignedTmp = $OutApk + ".signed"
& $ApkSigner sign --ks $Keystore --ks-pass pass:android --key-pass pass:android `
    --ks-key-alias androiddebugkey --min-sdk-version 24 --out $SignedTmp $Aligned
if ($LASTEXITCODE -ne 0) { throw "签名失败: $LASTEXITCODE" }
Move-Item $SignedTmp $OutApk -Force
Remove-Item $Aligned -Force -ErrorAction SilentlyContinue

& $ApkSigner verify $OutApk
if ($LASTEXITCODE -ne 0) { throw "签名校验失败" }

Write-Host ""
Write-Host "==> 完成: $OutApk" -ForegroundColor Green
Write-Host "    SHA256: $((Get-FileHash $OutApk -Algorithm SHA256).Hash)"
