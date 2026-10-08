# Build the Android APK with the workspace-local toolchain (no system setup needed).
#
# IMPORTANT: THIS FILE MUST STAY PURE ASCII.
# Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as ANSI/GBK. A Chinese string
# literal can end in a byte that GBK swallows together with the closing quote, which
# turns the rest of the file into a syntax error ("Missing closing '}'"). This has
# already broken this exact script once. tools/ps1-ascii.test.mjs guards it.
# Chinese is allowed on comment lines only (the parser reads them to end-of-line,
# so mojibake there is cosmetic and cannot break parsing).
#
# Usage:
#   pwsh -File tools/android-build.ps1                # debug build (daily work)
#   pwsh -File tools/android-build.ps1 -Install       # build, then adb install
#   pwsh -File tools/android-build.ps1 -Clean         # clean, then build
#   pwsh -File tools/android-build.ps1 -Release       # release-signed (for users)
#   pwsh -File tools/android-build.ps1 -WorkspaceGradleHome
#       use build\gradle-home as GRADLE_USER_HOME (needed when the process may only
#       write inside this repo -- otherwise Gradle dies before compiling)
#
# Release vs debug signing: the two are DIFFERENT keys, so the APKs cannot
# overwrite each other. If a phone already has the debug build installed, it must
# be uninstalled before installing the release build (that wipes app data).
# The release key comes from tools/make-release-keystore.ps1 -- lose it and you
# can never push an update to anyone who installed your build.
#
# Why this script exists instead of a bare gradle command: building needs
# JAVA_HOME / ANDROID_HOME pointing at the workspace toolchain; forget them and
# you get cryptic "sdk.dir not found" / "JAVA_HOME is not set" errors.

param(
  [switch]$Install,
  [switch]$Clean,
  [switch]$Release,
  [switch]$WorkspaceGradleHome
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
    Write-Host "Toolchain missing: $p" -ForegroundColor Red
    Write-Host "Run first: node tools/android-bootstrap.mjs" -ForegroundColor Yellow
    exit 1
  }
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# Sandboxed runs (CI, or an agent restricted to the workspace) cannot write outside
# the repo. Gradle MUST create its native-library lock under GRADLE_USER_HOME before
# it compiles anything, so a home inside the user profile kills the build with
#   "Could not initialize native services" / "native-platform.dll.lock (Access is denied)".
# -WorkspaceGradleHome moves the Gradle home inside the repo and seeds it once from
# the real one (~700 MB of dependency cache), which keeps every later write in-repo.
if ($WorkspaceGradleHome) {
  $wsHome = Join-Path $repoRoot 'build\gradle-home'
  if (-not (Test-Path (Join-Path $wsHome 'caches'))) {
    $srcHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $env:USERPROFILE '.gradle' }
    Write-Host "Seeding $wsHome from $srcHome (one-time, ~700 MB)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $wsHome | Out-Null
    Copy-Item -Path (Join-Path $srcHome '*') -Destination $wsHome -Recurse -Force
    Write-Host "Seeded." -ForegroundColor Green
  }
  $env:GRADLE_USER_HOME = $wsHome
  Write-Host "Gradle home: $wsHome (in-workspace)" -ForegroundColor DarkGray
}

Write-Host "JDK    : $jdk" -ForegroundColor DarkGray
Write-Host "SDK    : $sdk" -ForegroundColor DarkGray
Write-Host "Gradle : $gradle" -ForegroundColor DarkGray

Push-Location $androidDir
try {
  $tasks = @()
  if ($Clean) { $tasks += 'clean' }

  if ($Release) {
    $propsFile = Join-Path $repoRoot '.secrets\keystore.properties'
    if (-not (Test-Path $propsFile)) {
      Write-Host "Release signing key missing: $propsFile" -ForegroundColor Red
      Write-Host "Create it first: pwsh -File tools/make-release-keystore.ps1" -ForegroundColor Yellow
      Write-Host "(Without it the build still succeeds, but the APK is unsigned." -ForegroundColor Yellow
      Write-Host " Phones refuse to install an unsigned APK.)" -ForegroundColor Yellow
      exit 1
    }
    $tasks += ':app:assembleRelease'
  } else {
    $tasks += ':app:assembleDebug'
  }

  $gradleArgs = @()
  $gradleArgs += $tasks
  $gradleArgs += '--no-daemon'
  $gradleArgs += '--console=plain'
  if ($WorkspaceGradleHome) {
    # The Kotlin compile daemon writes its marker files under
    # %LOCALAPPDATA%\kotlin\daemon, which a workspace-only sandbox denies:
    #   "java.nio.file.AccessDeniedException: ...kotlin-daemon-client-tsmarker*.tmp"
    # and the release Kotlin task then fails with paths mangled into \uXXXX escapes.
    # Compiling in-process needs no daemon and no writes outside the repo.
    $gradleArgs += '-Pkotlin.compiler.execution.strategy=in-process'
  }

  Write-Host "`n==> gradle $($gradleArgs -join ' ')" -ForegroundColor Cyan
  & $gradle @gradleArgs
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "Build FAILED (exit $code)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Common causes seen in this repo:" -ForegroundColor Yellow
    Write-Host "  * 'Could not initialize native services' / 'native-platform.dll.lock (Access is denied)'" -ForegroundColor Yellow
    Write-Host "      => Gradle could not WRITE its native cache under $env:USERPROFILE\.gradle." -ForegroundColor Yellow
    Write-Host "      => Happens when the process may only write inside the workspace. Re-run with:" -ForegroundColor Yellow
    Write-Host "           pwsh -File tools/android-build.ps1 -WorkspaceGradleHome" -ForegroundColor Yellow
    Write-Host "  * 'SDK location not found' => run node tools/android-bootstrap.mjs first." -ForegroundColor Yellow
    exit $code
  }

  if ($Release) {
    $apk = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
  } else {
    $apk = Join-Path $androidDir 'app\build\outputs\apk\debug\app-debug.apk'
  }
  if (-not (Test-Path $apk)) {
    Write-Host "No APK produced: $apk" -ForegroundColor Red
    exit 1
  }
  $size = [math]::Round((Get-Item $apk).Length / 1MB, 2)
  Write-Host "`nAPK: $apk ($size MB)" -ForegroundColor Green
  if ($Release) {
    Write-Host "Release-signed: this is the file to hand to users." -ForegroundColor Green
    Write-Host "Verify with: & '$sdk\build-tools\35.0.0\apksigner.bat' verify --print-certs '$apk'" -ForegroundColor DarkGray
  }

  if ($Install) {
    if (-not (Test-Path $adb)) { Write-Host "adb not found, cannot install" -ForegroundColor Red; exit 1 }
    $devices = & $adb devices | Select-String 'device$'
    if (-not $devices) {
      Write-Host "No device attached (adb devices is empty). Plug in the phone and allow USB debugging." -ForegroundColor Yellow
      Write-Host "The APK exists anyway; you can also install manually: adb install -r `"$apk`"" -ForegroundColor Yellow
      exit 0
    }
    Write-Host "`n==> adb install -r" -ForegroundColor Cyan
    & $adb install -r $apk
    if ($LASTEXITCODE -ne 0) { Write-Host "Install failed" -ForegroundColor Red; exit 1 }
    Write-Host "Installed. Launch: adb shell am start -n com.timetable.app/.MainActivity" -ForegroundColor Green
  }
}
finally {
  Pop-Location
}
