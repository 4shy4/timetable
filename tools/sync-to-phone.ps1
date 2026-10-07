# Sync desktop data (events + courses) to the phone. One-way: desktop -> phone.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/sync-to-phone.ps1
#   add -DryRun to preview without changing the phone.
# Or just run: npm run sync
#
# Why one-way: the desktop is the source of truth (courses are imported there),
# the phone just needs the result. Two-way merge is hard to get right because
# a deletion cannot be expressed by merging - the deleted item comes back.
#
# WARNING: keep this file PURE ASCII.
#   Windows PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, so any non-ASCII
#   character (Chinese, emoji) gets mangled and can break the parser with a
#   confusing "Unexpected token" error far from the real location. Learned the
#   hard way; see docs/ANDROID-BUILD.md.
#
# WARNING: param() must be the FIRST statement - not after a comment block,
#   or PowerShell reports "Unexpected token ')'".

param(
  [switch]$DryRun,
  # Pick a specific device by serial. Needed when the phone shows up twice
  # (USB serial + WiFi IP) - useful for wireless adb.
  [string]$Serial = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $repo 'android\toolchain\sdk\platform-tools\adb.exe'
$phonePort = 17800
$desktopPort = 7080

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Bad($m) { Write-Host "  [X] $m" -ForegroundColor Red }

# adb writes "* daemon not running; starting now" to stderr, and with
# $ErrorActionPreference='Stop' that aborts the whole script. So always call adb
# through this wrapper: relax the preference, merge stderr, keep the exit code.
function Invoke-Adb([string[]]$AdbArgs) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $adb @AdbArgs 2>&1
    return @{ out = @($out); code = $LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $old
  }
}

Write-Host ''
Write-Host '=== Sync desktop -> phone ===' -ForegroundColor Cyan
Write-Host ''

# ---- 1) adb and device ----
if (-not (Test-Path $adb)) {
  Bad "adb not found: $adb"
  Info 'Run: npm run android:toolchain'
  exit 1
}

# Invoke-Adb returns @{out=...; code=...}, NOT a bare array.
# The first version piped .out through Select-Object -Skip 1 / Where-Object and
# then took [0] - which yielded a broken fragment instead of the full line
# (the serial came out as "3"), so adb -s 3 failed with "device '3' not found".
# Parse line by line explicitly instead.
$devOut = (Invoke-Adb @('devices')).out
$serial = $null
# Explicit -Serial wins.
if ($Serial) {
  foreach ($line in $devOut) {
    $t = "$line".Trim()
    if ($t -match '^(\S+)\s+device$' -and $Matches[1] -eq $Serial) { $serial = $Matches[1]; break }
  }
  if (-not $serial) {
    Bad "Requested device '$Serial' is not connected/authorized."
    Info 'adb devices said:'
    foreach ($line in $devOut) { Write-Host "    $line" }
    exit 1
  }
} else {
  # No -Serial: prefer a **USB** serial over a WiFi `ip:port` one.
  #
  # Why: with wireless adb you often still have the USB cable attached, so
  # `adb devices` lists BOTH. The old code took the first match, whichever it
  # was - and adb's ordering is not guaranteed, so the sync could end up
  # targeting a different transport than expected. Deterministic is better.
  $ipMatch = $null
  foreach ($line in $devOut) {
    $t = "$line".Trim()
    if ($t -match '^(\S+)\s+device$') {
      $cand = $Matches[1]
      if ($cand -match '^\d+\.\d+\.\d+\.\d+:\d+$') {
        if (-not $ipMatch) { $ipMatch = $cand }
      } else {
        $serial = $cand      # USB serial wins immediately
        break
      }
    }
  }
  if (-not $serial -and $ipMatch) { $serial = $ipMatch }
}
if (-not $serial) {
  Bad 'No phone detected (or not authorized).'
  Info 'Plug in the USB cable and allow USB debugging on the phone.'
  Info 'If the phone shows an "Allow USB debugging?" dialog, tap Allow.'
  Write-Host ''
  Info 'adb devices said:'
  foreach ($line in $devOut) { Write-Host "    $line" }
  exit 1
}
Ok "phone: $serial"

# ---- 2) desktop app reachable? ----
$desktopState = $null
try {
  $desktopState = Invoke-RestMethod -Uri "http://127.0.0.1:$desktopPort/api/state" -TimeoutSec 5
} catch {
  Bad "Desktop app is not reachable on port $desktopPort"
  Info 'Start it first (npm start), then run this again.'
  exit 1
}
$dEvents = @($desktopState.events).Count
$dCourses = @($desktopState.courses).Count
Ok "desktop: $dEvents events, $dCourses courses"

# ---- 3) phone app reachable? tunnel its port over USB ----
(Invoke-Adb @('-s', $serial, 'forward', '--remove-all')) | Out-Null
$fwdRes = Invoke-Adb @('-s', $serial, 'forward', "tcp:$phonePort", "tcp:$phonePort")
if ($fwdRes.code -ne 0) {
  Bad "adb forward failed: $($fwdRes.out -join ' ')"
  exit 1
}
Ok "port forward ready (PC 127.0.0.1:$phonePort -> phone $phonePort)"

$phoneHealth = $null
try {
  $phoneHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$phonePort/api/health" -TimeoutSec 5
} catch {
  Bad 'Phone app is not running (its local server is not answering).'
  Info 'Open the Timetable app on the phone, then run this again.'
  exit 1
}
Ok "phone: $($phoneHealth.name) v$($phoneHealth.version)"

# ---- 4) what the phone has now ----
$phoneState = Invoke-RestMethod -Uri "http://127.0.0.1:$phonePort/api/state" -TimeoutSec 10
$pEvents = @($phoneState.events).Count
$pCourses = @($phoneState.courses).Count
Info "phone now: $pEvents events, $pCourses courses"

# ---- 5) back up the phone first, so a bad push can be undone ----
$backupDir = Join-Path $repo 'build\phone-backup'
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $backupDir "phone-before-sync-$stamp.json"
$phoneState | ConvertTo-Json -Depth 20 | Set-Content -Path $backupFile -Encoding UTF8
Ok "phone backup: build\phone-backup\phone-before-sync-$stamp.json"

# ---- 6) push ----
Write-Host ''
Info "To push:  $dEvents events / $dCourses courses"
Info "Replaces: $pEvents events / $pCourses courses on the phone"

if ($DryRun) {
  Write-Host ''
  Warn 'DryRun: nothing was changed.'
  exit 0
}

$payload = $desktopState | ConvertTo-Json -Depth 20 -Compress
# Send UTF-8 bytes explicitly, otherwise PowerShell turns CJK into question marks
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
try {
  $res = Invoke-RestMethod -Uri "http://127.0.0.1:$phonePort/api/restore" `
    -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 60
} catch {
  Bad "restore failed: $($_.Exception.Message)"
  Info "Phone data was NOT changed. Backup: $backupFile"
  exit 1
}

# ---- 7) verify ----
$after = Invoke-RestMethod -Uri "http://127.0.0.1:$phonePort/api/state" -TimeoutSec 10
$aEvents = @($after.events).Count
$aCourses = @($after.courses).Count
Write-Host ''
if ($aEvents -eq $dEvents -and $aCourses -eq $dCourses) {
  Ok "done: phone now has $aEvents events, $aCourses courses (matches desktop)"
} else {
  Warn "counts differ -> phone $aEvents/$aCourses, desktop $dEvents/$dCourses"
}

# Restart the phone app so reminders get rescheduled against the new data
(Invoke-Adb @('-s', $serial, 'shell', 'am', 'force-stop', 'com.timetable.app')) | Out-Null
Start-Sleep -Milliseconds 800
(Invoke-Adb @('-s', $serial, 'shell', 'am', 'start', '-n', 'com.timetable.app/.MainActivity')) | Out-Null
Ok 'phone app restarted (reminders rescheduled)'
Write-Host ''
