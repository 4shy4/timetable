# 构建安卓 APK（用工作区自带的工具链，不依赖系统环境）
#
# 用法：
#   pwsh -File tools/android-build.ps1                # 只构建
#   pwsh -File tools/android-build.ps1 -Install       # 构建并 adb install
#   pwsh -File tools/android-build.ps1 -Clean         # 先 clean 再构建
#
# 为什么要有这个脚本（而不是手敲 gradle 命令）：
#   构建安卓需要 JAVA_HOME / ANDROID_HOME 三个环境变量指向工作区里的工具链，
#   忘了设就会报"找不到 sdk.dir"或"JAVA_HOME is not set"这类看不懂的错。
#   这里一次性设好，任何人（包括未来的我）不用再回忆。
#
# 本文件必须保持纯 ASCII：PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解析，
# 中文会变乱码甚至语法错误（这个项目已经踩过一次）。

param(
  [switch]$Install,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $repoRoot 'android'
$toolchain = Join-Path $androidDir 'toolchain'

$jdk = Join-Path $toolchain 'jdk'
$sdk = Join-Path $toolchain 'sdk'
$gradle = Join-Path $toolchain 'gradle\bin\gradle.bat'
$adb = Join-Path $sdk 'platform-tools\adb.exe'

foreach ($p in @($jdk, $sdk, $gradle)) {
  if (-not (Test-Path $p)) {
    Write-Host "工具链缺失: $p" -ForegroundColor Red
    Write-Host "先跑: node tools/android-bootstrap.mjs" -ForegroundColor Yellow
    exit 1
  }
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

Write-Host "JDK    : $jdk" -ForegroundColor DarkGray
Write-Host "SDK    : $sdk" -ForegroundColor DarkGray
Write-Host "Gradle : $gradle" -ForegroundColor DarkGray

Push-Location $androidDir
try {
  $tasks = @()
  if ($Clean) { $tasks += 'clean' }
  $tasks += ':app:assembleDebug'

  Write-Host "`n==> gradle $($tasks -join ' ')" -ForegroundColor Cyan
  & $gradle @tasks --no-daemon --console=plain
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "构建失败（退出码 $code）" -ForegroundColor Red
    exit $code
  }

  $apk = Join-Path $androidDir 'app\build\outputs\apk\debug\app-debug.apk'
  if (-not (Test-Path $apk)) {
    Write-Host "没有生成 APK: $apk" -ForegroundColor Red
    exit 1
  }
  $size = [math]::Round((Get-Item $apk).Length / 1MB, 2)
  Write-Host "`nAPK: $apk ($size MB)" -ForegroundColor Green

  if ($Install) {
    if (-not (Test-Path $adb)) { Write-Host "找不到 adb，无法安装" -ForegroundColor Red; exit 1 }
    $devices = & $adb devices | Select-String 'device$'
    if (-not $devices) {
      Write-Host "没有连接的设备（adb devices 为空）。插上手机并允许 USB 调试后重试。" -ForegroundColor Yellow
      Write-Host "APK 已生成，也可以手动装：adb install -r `"$apk`"" -ForegroundColor Yellow
      exit 0
    }
    Write-Host "`n==> adb install -r" -ForegroundColor Cyan
    & $adb install -r $apk
    if ($LASTEXITCODE -ne 0) { Write-Host "安装失败" -ForegroundColor Red; exit 1 }
    Write-Host "已安装。启动：adb shell am start -n com.timetable.app/.MainActivity" -ForegroundColor Green
  }
}
finally {
  Pop-Location
}
