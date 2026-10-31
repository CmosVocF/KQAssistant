# 页面截图：用本机 Chromium 内核浏览器无头渲染本地预览页
# 用法：powershell -ExecutionPolicy Bypass -File tools\shot.ps1 -Name job -Url "http://127.0.0.1:8788/xuanlun-job.html?demo=1#jdemo"
param(
    [string]$Name = 'page',
    [string]$Url = 'http://127.0.0.1:8788/xuanlun.html?demo=1',
    [string]$Size = '430,950'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'env\_shots'
New-Item -ItemType Directory -Force $outDir | Out-Null
$chrome = 'D:\360ChromeX\Chrome\Application\360ChromeX.exe'
if (-not (Test-Path $chrome)) { throw "未找到浏览器：$chrome" }

$shot = Join-Path $outDir ($Name + '.png')
& $chrome --headless=new --disable-gpu --hide-scrollbars --no-first-run `
    --user-data-dir="$root\env\_chrome_tmp" --window-size=$Size `
    --screenshot="$shot" $Url | Out-Null
Write-Host "已生成：$shot"
