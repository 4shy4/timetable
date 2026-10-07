# Build the merged Kotlin unit for the HTTP end-to-end test, then run the Node
# test that drives it with fetch.
#
# WHY: LocalServer is hand-written HTTP over ServerSocket. Without a device it
# would otherwise never be exercised, and that is exactly the code most likely
# to be subtly wrong (path mapping, mime types, status codes, JSON shape).
# Its asset source is behind the WebAssets interface so the JVM can serve from
# disk instead of Android's AssetManager.
#
# Note: Store.kt + LocalServer.kt + HttpHarness.kt are concatenated into ONE
# file and compiled together -- compiling them as separate units failed to
# resolve sibling classes (see run.ps1 for the full story).
#
# Pure ASCII: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#
# -CompileOnly: compile the merged unit, print where it landed, and stop
# without running the Node test. WHY this switch exists: the DSH
# workspace-write sandbox forbids node from spawning a child through a pipe
# (spawnSync EPERM), so android-http.test.mjs cannot start the JVM itself
# there. Compile here, start the JVM yourself with java -cp, then run the test
# with TIMETABLE_HTTP_BASE=http://127.0.0.1:<port> -- see the run header in
# android-http.test.mjs. On a normal machine the plain invocation is unchanged.

param([switch]$CompileOnly)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$m2 = Join-Path $env:USERPROFILE '.gradle\caches\modules-2\files-2.1'

function Find-Jar([string]$group, [string]$pattern) {
  $root = Join-Path $m2 $group
  $hit = Get-ChildItem -Recurse -Filter $pattern $root -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*sources*' -and $_.Name -notlike '*javadoc*' } |
    Select-Object -First 1
  if (-not $hit) { throw "jar not found: $group/$pattern" }
  return $hit.FullName
}

$compilerJar = Find-Jar 'org.jetbrains.kotlin\kotlin-compiler-embeddable' 'kotlin-compiler-embeddable-2.0.21.jar'
$stdlibJar = Find-Jar 'org.jetbrains.kotlin\kotlin-stdlib' 'kotlin-stdlib-2.0.21.jar'
$reflectJar = Find-Jar 'org.jetbrains.kotlin\kotlin-reflect' 'kotlin-reflect-*.jar'
$scriptJar = Find-Jar 'org.jetbrains.kotlin\kotlin-script-runtime' 'kotlin-script-runtime-*.jar'
$coroutinesJar = Find-Jar 'org.jetbrains.kotlinx\kotlinx-coroutines-core-jvm' 'kotlinx-coroutines-core-jvm-*.jar'
$troveJar = Find-Jar 'org.jetbrains.intellij.deps\trove4j' 'trove4j-*.jar'
$annotationsJar = Find-Jar 'org.jetbrains\annotations' 'annotations-*.jar'

$jsonJar = Join-Path $repo 'build\json-20240303.jar'
if (-not (Test-Path $jsonJar)) { throw "missing $jsonJar" }

$java = Join-Path $repo 'android\toolchain\jdk\bin\java.exe'
if (-not (Test-Path $java)) { throw "missing JDK: $java" }

$stage = Join-Path $env:TEMP 'timetable-parity-stage'
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Read-Src([string]$p) { return (Get-Content $p -Raw -Encoding UTF8) -replace '(?m)^package com\.timetable\.app\s*$', '' }

$storeSrc = Read-Src (Join-Path $repo 'android\app\src\main\java\com\timetable\app\Store.kt')
# LocalServer.kt references android.content.res.AssetManager only inside the
# AndroidAssets adapter (lines 28-35). For the JVM build we drop that import and
# that adapter; the WebAssets interface and LocalServer itself are untouched, so
# what gets tested is the real HTTP code.
# (Do NOT put non-ASCII inside a -replace pattern here: PowerShell 5.1 mangles it
#  into '?', the regex silently stops matching, and you get a confusing failure.)
$serverPath = Join-Path $repo 'android\app\src\main\java\com\timetable\app\LocalServer.kt'
$serverLines = Get-Content $serverPath -Encoding UTF8
# Locate the AndroidAssets adapter by its declaration (NOT by hard-coded line
# numbers -- those go stale the moment the file is edited, and the failure is a
# confusing cascade of Kotlin errors).
$aaStart = -1
$aaEnd = -1
for ($i = 0; $i -lt $serverLines.Count; $i++) {
  if ($serverLines[$i] -match '^class AndroidAssets') { $aaStart = $i }
  elseif ($aaStart -ge 0 -and $aaEnd -lt 0 -and $serverLines[$i] -match '^\}') { $aaEnd = $i }
}
if ($aaStart -lt 0 -or $aaEnd -lt 0) { throw "could not locate AndroidAssets adapter in LocalServer.kt" }
$serverLines = $serverLines[0..($aaStart - 1)] + $serverLines[($aaEnd + 1)..($serverLines.Count - 1)]
$serverText = $serverLines -join "`r`n"

# Each source brings its own imports. When concatenating we must take the UNION
# of the import sets:
#   - keeping both copies -> "imported name is ambiguous"
#   - deleting both       -> LocalServer loses java.net.ServerSocket etc and
#                            everything turns into unresolved reference
# Note: trim + explicit case-insensitive sort/unique. Select-Object -Unique alone
# did NOT dedupe here because the matched strings still carried a trailing CR,
# so the compiler saw duplicate imports and reported them as ambiguous.
$storeImports = [regex]::Matches($storeSrc, '(?m)^import .+$') | ForEach-Object { $_.Value.Trim() }
$serverImports = [regex]::Matches($serverText, '(?m)^import .+$') | ForEach-Object { $_.Value.Trim() }
$allImports = @($storeImports + $serverImports) |
  Where-Object { $_ -and $_ -notmatch 'android\.content\.res\.AssetManager' } |
  Sort-Object -Unique
$importBlock = ($allImports -join "`r`n")

$storeSrc = $storeSrc -replace '(?m)^import .*$\r?\n', ''
$serverSrc = $serverText -replace '(?m)^package com\.timetable\.app\s*$', ''
$serverSrc = $serverSrc -replace '(?m)^import .*$\r?\n', ''

$harnessSrc = Read-Src (Join-Path $here 'android-parity\HttpHarness.kt')
$harnessSrc = $harnessSrc -replace '(?m)^import .*$\r?\n', ''

$merged = "package com.timetable.app`r`n`r`n" + $importBlock + "`r`n`r`n" + $storeSrc + "`r`n`r`n" + $serverSrc + "`r`n`r`n" + $harnessSrc
$mergedPath = Join-Path $stage 'HttpMerged.kt'
[System.IO.File]::WriteAllText($mergedPath, $merged, (New-Object System.Text.UTF8Encoding($false)))

$outClasses = Join-Path $stage 'http-classes'
if (Test-Path $outClasses) { Remove-Item -Recurse -Force $outClasses }
New-Item -ItemType Directory -Force -Path $outClasses | Out-Null

$compilerCp = @($compilerJar, $stdlibJar, $reflectJar, $scriptJar, $coroutinesJar, $troveJar, $annotationsJar) -join ';'
$targetCp = @($stdlibJar, $jsonJar) -join ';'
$utf8 = '-Dfile.encoding=UTF-8'

Write-Host "compiling merged unit (Store + LocalServer + HttpHarness)..." -ForegroundColor DarkGray
& $java $utf8 -cp $compilerCp org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -cp $targetCp -d $outClasses $mergedPath
if ($LASTEXITCODE -ne 0) { throw "kotlin compile failed ($LASTEXITCODE)" }
Write-Host "compiled -> $outClasses" -ForegroundColor Green

if ($CompileOnly) {
  Write-Host "CLASSES=$outClasses"
  Write-Host "CLASSPATH=$targetCp"
  exit 0
}

Push-Location $repo
try {
  & node (Join-Path $repo 'tools\android-http.test.mjs')
  exit $LASTEXITCODE
}
finally { Pop-Location }