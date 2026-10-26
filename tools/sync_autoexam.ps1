# ============================================================
# sync_autoexam.ps1 — 把 PC 油猴原版同步为 App 适配版（app/src/main/assets/autoexam.js）
#
# 每次同步自动重套 5 项 App 独有适配（历史上有过遗漏导致回归，故全部脚本化）：
#   1) 去掉 ==UserScript== 元数据 -> WebView 注释头（含 App/PC 两版差异说明）
#   2) 防重复注入守卫 window.__AUTOEXAM_INJECTED
#   3) 手机面板 CSS（替代桌面版 310px 面板）
#   4) HRBridge.nativeApi 原生网络桥分支
#   5) 后端地址原生持久化 getApiUrl/setApiUrl + 加载写回 CFG.api
#
# 用法: powershell -ExecutionPolicy Bypass -File tools\sync_autoexam.ps1
# 说明: 源文件（PC 原版）为 modules/autoexam/userscript/autoexam.user.js；
#       输出覆盖 App 资产 app/src/main/assets/autoexam.js（仅 App 运行时使用）。
# ============================================================
$ErrorActionPreference = 'Stop'
$Repo = 'D:\KQAssistant'
$src  = Join-Path $Repo 'modules\autoexam\userscript\autoexam.user.js'
$dst  = Join-Path $Repo 'app\src\main\assets\autoexam.js'
$u8   = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $src)) { throw ("找不到 PC 原版: " + $src) }
if (-not (Test-Path $dst)) { throw ("找不到 App 资产: " + $dst) }

# 统一 LF，保证生成结果稳定可复现
$t = [System.IO.File]::ReadAllText($src, $u8)
$t = $t.Replace("`r`n", "`n")

$idx = $t.IndexOf('(function () {')
if ($idx -lt 0) { throw '找不到 IIFE 锚点 (function () {' }

# ---------- 1+2) 头部注释 + 防重复注入守卫 ----------
$header = @(
"// ============================================================================",
"// 自动答题助手（App 适配版）— 安卓 WebView 运行时注入使用",
"// ----------------------------------------------------------------------------",
"// 本文件是 KQAssistant 安卓 App 打包进 APK 的注入脚本（MainActivity 进入",
"// hrt-mobile.hncsmtr.com 时注入），为默认使用的版本；答题逻辑与 PC 油猴版一致。",
"//",
"// PC 油猴原版（未做 App 适配）位于：modules/autoexam/userscript/autoexam.user.js",
"// 本 App 适配版位于：              app/src/main/assets/autoexam.js",
"//",
"// 与 PC 原版的差异（均为 App/WebView 环境适配，不含答题逻辑改动）：",
"//   1) 头部元数据：PC 版有 ==UserScript== 区（@match/@grant/@connect，含 www.ep2w.fun），",
"//      本版用注释头替代（WebView 不解析油猴元数据）。",
"//   2) 防重复注入：新增 window.__AUTOEXAM_INJECTED 守卫（App 在 onPageStarted 与",
"//      onPageFinished 各注入一次，不守卫会执行两遍）。",
"//   3) 面板样式：桌面固定 310px → 手机适配（min(310px, calc(100vw-16px))、",
"//      显式配色防白字、-webkit-appearance 规范化）。",
"//   4) 网络请求通道：PC 用 GM_xmlhttpRequest（可绕 CORS）；本版优先走",
"//      HRBridge.nativeApi（Android 原生请求，绕浏览器 CORS），不可用时回退 fetch。",
"//   5) 后端地址持久化：本版用 HRBridge.getApiUrl/setApiUrl（SharedPreferences，",
"//      不受 http/https 不同源 localStorage 影响），并在加载时写回 CFG.api。",
"//",
"// 其余（题目解析、匹配归一化 numCmpKey/dateCmpKey、单选/多选/判断点击、",
"// 逐项等待 Vue 刷新等）与 PC 原版完全相同。",
"// 修改答题逻辑时请两边同步；本文件由 tools/sync_autoexam.ps1 从 PC 版生成。",
"// ============================================================================"
) -join "`n"

$guard = @(
"    if (window.__AUTOEXAM_INJECTED) return;",
"    window.__AUTOEXAM_INJECTED = true;"
) -join "`n"

$new = $header + "`n" + $t.Substring($idx)
$anchor = "    'use strict';"
$p = $new.IndexOf($anchor)
if ($p -lt 0) { throw '找不到 use strict 锚点' }
$pEnd = $p + $anchor.Length
$new = $new.Substring(0, $pEnd) + "`n" + $guard + $new.Substring($pEnd)

# ---------- 3) 手机面板 CSS ----------
$s0 = $new.IndexOf('<style>')
$s1 = $new.IndexOf('</style>')
if ($s0 -lt 0 -or $s1 -lt 0) { throw '找不到 <style> 块' }
$s1 = $s1 + '</style>'.Length

$mobile = @(
"<style>",
"/* ---- 自动答题悬浮面板（WebView 手机适配版） ---- */",
"#autoexam-dock{position:fixed;z-index:2147483647;width:min(310px, calc(100vw - 16px));max-width:310px;background:#fff;color:#24292f;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:8px 10px;font-family:-apple-system,'Microsoft YaHei',sans-serif;font-size:12px;line-height:1.4;touch-action:none;will-change:left,top}",
"#autoexam-dock *{box-sizing:border-box}",
"#autoexam-dock button{margin:2px 4px 2px 0;padding:5px 10px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#24292f;cursor:pointer;font-size:12px;line-height:1.2;-webkit-appearance:none;appearance:none}",
"#autoexam-dock button:hover{background:#eaeef2}",
"#autoexam-dock input{border:1px solid #d0d7de;border-radius:4px;padding:3px 5px;font-size:12px;color:#24292f;background:#fff}",
"#autoexam-dock label{color:#444}",
"#autoexam-dock .good{color:#1a7f37}",
"#autoexam-dock .bad{color:#c0392b}",
"#autoexam-dock.collapsed{width:46px;height:46px;border-radius:50%;padding:0;box-shadow:0 2px 10px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;overflow:hidden}",
"#autoexam-dock.collapsed #autoexam-body{display:none}",
"#autoexam-bubble{font-size:24px;line-height:1;padding:0;position:relative;cursor:move;display:flex;align-items:center;justify-content:center;width:100%;height:100%}",
"#autoexam-bubble .dot{position:absolute;right:-1px;top:-1px;width:12px;height:12px;border-radius:50%;border:2px solid #fff}",
"#autoexam-bubble .dot.good{background:#1a7f37}",
"#autoexam-bubble .dot.bad{background:#c0392b}",
"</style>"
) -join "`n"

$new = $new.Substring(0, $s0) + $mobile + $new.Substring($s1)

# ---------- 4) 原生网络桥分支（插入 GM 分支之前） ----------
$gm = "            if (typeof GM_xmlhttpRequest === 'function') {"
$gp = $new.IndexOf($gm)
if ($gp -lt 0) { throw '找不到 GM_xmlhttpRequest 分支锚点' }

$native = @(
"            // KQ WebView 原生网络桥：用 Android 原生发起请求，绕过浏览器 CORS，可直连公网后端。",
"            if (window.HRBridge && typeof window.HRBridge.nativeApi === 'function') {",
"                try {",
"                    const r = JSON.parse(window.HRBridge.nativeApi(CFG.api + path, method, payload ? JSON.stringify(payload) : '', CFG.apiKey || ''));",
"                    if (r && r.ok) done(r.text); else fail(r.status || 0);",
"                    return;",
"                } catch (e) { /* 原生桥异常则继续走 GM/fetch */ }",
"            }"
) -join "`n"

$new = $new.Substring(0, $gp) + $native + "`n" + $new.Substring($gp)

# ---------- 5) 后端地址原生持久化 + 加载写回 ----------
$oldBlock = @(
"        const apiInp = dock.querySelector('#autoexam-api');",
"        apiInp.value = storageGet('api', CFG.api);",
"        apiInp.onchange = () => {",
"            CFG.api = apiInp.value.trim().replace(/\/+`$/, '') || CFG.api;",
"            storageSet('api', CFG.api);",
"        };"
) -join "`n"
$ap = $new.IndexOf($oldBlock)
if ($ap -lt 0) { throw '找不到后端地址面板初始化块（源文件锚点可能已变）' }

$newBlock = @(
"        const apiInp = dock.querySelector('#autoexam-api');",
"        let storedApi = '';",
"        try { if (window.HRBridge && typeof window.HRBridge.getApiUrl === 'function') storedApi = window.HRBridge.getApiUrl() || ''; } catch (e) {}",
"        if (!storedApi) { const v = storageGet('api', null); if (v !== null && v !== undefined) storedApi = String(v); }",
"        if (storedApi && storedApi.trim()) CFG.api = storedApi.trim().replace(/\/+`$/, '');",
"        apiInp.value = CFG.api;",
"        apiInp.onchange = () => {",
"            const clean = (apiInp.value || '').trim().replace(/\/+`$/, '');",
"            if (clean) CFG.api = clean;",
"            try { storageSet('api', CFG.api); } catch (e) {}",
"            try { if (window.HRBridge && typeof window.HRBridge.setApiUrl === 'function') window.HRBridge.setApiUrl(CFG.api); } catch (e) {}",
"        };"
) -join "`n"
$new = $new.Substring(0, $ap) + $newBlock + $new.Substring($ap + $oldBlock.Length)

# ---------- 自检 ----------
$check = @(
"    if (window.__AUTOEXAM_INJECTED) return;",
"window.__AUTOEXAM_INJECTED",
"typeof window.HRBridge.nativeApi",
"HRBridge.getApiUrl",
"min(310px, calc(100vw - 16px))"
)
foreach ($c in $check) {
    $n = ([regex]::Matches($new, [regex]::Escape($c))).Count
    Write-Host ("[{0}] {1} 出现 {2} 次" -f ($(if ($n -ge 1) { 'OK' } else { 'MISS' })), $c, $n)
}

[System.IO.File]::WriteAllText($dst, $new, $u8)
Write-Host ("[OK] 已生成: " + $dst)
Write-Host ("     源: {0} 字节 -> 目标: {1} 字节" -f (Get-Item $src).Length, (Get-Item $dst).Length)
