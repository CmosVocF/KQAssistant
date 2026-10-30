# 构建脚本：编译 debug + release，并把带版本号的 APK 复制到 dist/
# 用法： powershell -ExecutionPolicy Bypass -File tools\build_apk.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$env:JAVA_HOME = Join-Path $root 'env\jdk'
$env:GRADLE_USER_HOME = Join-Path $root 'env\gradle-home'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

Push-Location $root
try {
    & (Join-Path $root 'gradlew.bat') ':app:assembleDebug' ':app:assembleRelease' '--no-daemon' 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败 (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Get-ChildItem (Join-Path $root 'app\build\outputs\apk') -Recurse -Filter 'KQAssistant-*.apk' | ForEach-Object {
    Copy-Item $_.FullName $dist -Force
    Write-Host ("APK -> " + (Join-Path $dist $_.Name))
}
