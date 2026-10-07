# Compile and run the Kotlin Store on a plain JVM and print its behaviour as
# JSON, so it can be diffed against server/store.js.
#
# WHY THIS EXISTS
#   The Android side re-implements the store in Kotlin, because Android has no
#   node runtime and forbids exec() from app data since targetSdk 29. A
#   re-implementation drifts. So we run both against identical input and diff.
#
# WHY NOT `gradle :app:testDebugUnitTest`
#   Under AGP 8.7.3 + Kotlin 2.0.21 the test task could not find the compiled
#   test class (ClassNotFoundException: StoreTest) even though the .class file
#   was produced under build/tmp/kotlin-classes/. Rather than fight the AGP/KGP
#   output-dir mismatch, we drive kotlinc directly -- Store deliberately has no
#   android.* dependency, so this works and has fewer moving parts.
#
# GOTCHAS HANDLED BELOW (each one cost real time):
#   1. The embeddable compiler needs stdlib / reflect / script-runtime /
#      coroutines / trove4j / annotations on ITS OWN classpath, otherwise it
#      dies with NoClassDefFoundError (annotations shows up as a backend
#      "Exception during IR lowering").
#   2. Source files are staged into an ASCII-only temp dir: the repo path
#      contains Chinese characters, and kotlinc mis-decodes non-ASCII source
#      arguments on Windows.
#   3. Store.kt and the harness are concatenated into ONE file. Compiling them
#      as two compilation units failed to resolve `Store` from the harness
#      (tried classes-dir and jar on -cp; neither worked).
#   4. -no-stdlib also drops the stdlib from the TARGET classpath, so it is
#      passed explicitly via -cp.
#
# This file must stay pure ASCII: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.

param(
  [string]$OutDir = 'build/android-parity'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)
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
if (-not (Test-Path $jsonJar)) {
  throw "missing $jsonJar -- download org.json 20240303 from Maven Central into build/"
}

$java = Join-Path $repo 'android\toolchain\jdk\bin\java.exe'
if (-not (Test-Path $java)) { throw "missing JDK: $java" }

# ---- stage sources into an ASCII path and merge into one file --------------
$stage = Join-Path $env:TEMP 'timetable-parity-stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$storeSrc = Get-Content (Join-Path $repo 'android\app\src\main\java\com\timetable\app\Store.kt') -Raw -Encoding UTF8
$harnessSrc = Get-Content (Join-Path $here 'ParityHarness.kt') -Raw -Encoding UTF8

# drop both package lines, and all imports from the harness (Store already has them)
$storeBody = $storeSrc -replace '(?m)^package com\.timetable\.app\s*$', ''
$harnessBody = $harnessSrc -replace '(?m)^package com\.timetable\.app\s*$', ''
$harnessBody = $harnessBody -replace '(?m)^import .*$\r?\n', ''

$merged = "package com.timetable.app`r`n`r`n" + $storeBody + "`r`n`r`n" + $harnessBody
$mergedPath = Join-Path $stage 'Merged.kt'
[System.IO.File]::WriteAllText($mergedPath, $merged, (New-Object System.Text.UTF8Encoding($false)))

$outClasses = Join-Path $stage 'classes'
New-Item -ItemType Directory -Force -Path $outClasses | Out-Null

$compilerCp = @($compilerJar, $stdlibJar, $reflectJar, $scriptJar, $coroutinesJar, $troveJar, $annotationsJar) -join ';'
$targetCp = @($stdlibJar, $jsonJar) -join ';'

Write-Host "compiler : $(Split-Path -Leaf $compilerJar)" -ForegroundColor DarkGray
Write-Host "staged   : $stage" -ForegroundColor DarkGray

# PowerShell ?? -Dfile.encoding=UTF-8 ????????? ".encoding=UTF-8"??
# ???????????????
$utf8 = '-Dfile.encoding=UTF-8'
$utf8out = '-Dstdout.encoding=UTF-8'
& $java $utf8 -cp $compilerCp org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -cp $targetCp -d $outClasses $mergedPath
if ($LASTEXITCODE -ne 0) { throw "kotlin compile failed ($LASTEXITCODE)" }

# -Dfile.encoding / -Dstdout.encoding keep the Chinese output readable;
# without them the console mangles it and the captured JSON is unusable.
& $java $utf8 $utf8out -cp "$outClasses;$targetCp" com.timetable.app.MergedKt (Join-Path $repo $OutDir)
if ($LASTEXITCODE -ne 0) { throw "harness run failed ($LASTEXITCODE)" }