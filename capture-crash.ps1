# 抓取 Multica Android 的启动崩溃日志。
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File capture-crash.ps1
#
# 前置：手机开启「开发者选项 → USB 调试」，数据线连电脑，手机上点"允许"。
# 脚本会清空日志缓冲 → 启动 App → 抓 logcat → 另存崩溃摘要。

[CmdletBinding()]
param(
    [string]$Package = "ai.multica.mobile.dev",
    [int]$WaitSeconds = 12
)

$ErrorActionPreference = "Stop"
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$Adb = Join-Path $Root ".toolchain\android-sdk\platform-tools\adb.exe"

# adb 写日志到 %TEMP%，系统 Temp 在沙箱下可能不可写。
$env:ANDROID_USER_HOME = Join-Path $Root ".toolchain\.android-home"
$env:TEMP = Join-Path $Root ".toolchain\tmp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

if (-not (Test-Path $Adb)) { throw "找不到 adb: $Adb" }

Write-Host "==> 检查设备" -ForegroundColor Cyan
$devices = & $Adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice$" }
if (-not $devices) {
    Write-Host "没有已授权的设备。请检查：" -ForegroundColor Yellow
    Write-Host "  1. 手机「开发者选项 → USB 调试」已开"
    Write-Host "  2. 数据线是数据线（不是只能充电的线）"
    Write-Host "  3. 手机弹窗点「允许」"
    Write-Host ""
    Write-Host "如果你用的是无线调试：adb pair <ip>:<port>  然后  adb connect <ip>:<port>"
    exit 1
}
$devices | ForEach-Object { Write-Host "  设备: $_" }

Write-Host "==> 清空日志缓冲" -ForegroundColor Cyan
& $Adb logcat -c

Write-Host "==> 启动 App（$Package）" -ForegroundColor Cyan
& $Adb shell am force-stop $Package
& $Adb shell monkey -p $Package -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 2

Write-Host "==> 等待 $WaitSeconds 秒并抓取日志" -ForegroundColor Cyan
Start-Sleep -Seconds $WaitSeconds

$OutDir = Join-Path $Root "crash-logs"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Full = Join-Path $OutDir "logcat-$Stamp.txt"
& $Adb logcat -d -v threadtime | Out-File -FilePath $Full -Encoding UTF8

# 只挑崩溃相关的行，方便直接看。
$Key = Join-Path $OutDir "crash-$Stamp.txt"
Select-String -Path $Full -Pattern "FATAL EXCEPTION|AndroidRuntime|Caused by|reactnative|ReactNative|expo|Expo|hermes|Hermes|SoLoader|UnsatisfiedLink|SIGSEGV|SIGABRT|main.*Exception" |
    Select-Object -First 400 |
    ForEach-Object { $_.Line } |
    Out-File -FilePath $Key -Encoding UTF8

Write-Host ""
Write-Host "==> 完成" -ForegroundColor Green
Write-Host "    完整日志: $Full"
Write-Host "    崩溃摘要: $Key"
Write-Host ""

Write-Host "==> 崩溃摘要（前 40 行）" -ForegroundColor Cyan
Get-Content $Key -TotalCount 40 -ErrorAction SilentlyContinue

$crash = Get-Content $Key -Raw -ErrorAction SilentlyContinue
if ($crash -match "FATAL EXCEPTION") {
    Write-Host ""
    Write-Host "检测到 FATAL EXCEPTION —— 把上面这份 crash 摘要发我即可定位。" -ForegroundColor Yellow
}
