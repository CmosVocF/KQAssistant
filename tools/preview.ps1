# 本地预览：在电脑浏览器里打开镟轮数据页面（无需安装 APK）
# 用法：powershell -ExecutionPolicy Bypass -File tools\preview.ps1 [-Port 8788]
param([int]$Port = 8788)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'app\src\main\assets'
$url = "http://127.0.0.1:$Port/xuanlun.html?demo=1"

Write-Host "预览地址: $url"
Write-Host "（按 Ctrl+C 停止）"
Start-Process $url
Push-Location $assets
try {
    python -m http.server $Port
} finally {
    Pop-Location
}
