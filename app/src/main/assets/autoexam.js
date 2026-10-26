// ============================================================================
// 自动答题助手（App 适配版）— 安卓 WebView 运行时注入使用
// ----------------------------------------------------------------------------
// 本文件是 KQAssistant 安卓 App 打包进 APK 的注入脚本（MainActivity 进入
// hrt-mobile.hncsmtr.com 时注入），为默认使用的版本；答题逻辑与 PC 油猴版一致。
//
// PC 油猴原版（未做 App 适配）位于：modules/autoexam/userscript/autoexam.user.js
// 本 App 适配版位于：              app/src/main/assets/autoexam.js
//
// 与 PC 原版的差异（均为 App/WebView 环境适配，不含答题逻辑改动）：
//   1) 头部元数据：PC 版有 ==UserScript== 区（@match/@grant/@connect，含 www.ep2w.fun），
//      本版用注释头替代（WebView 不解析油猴元数据）。
//   2) 防重复注入：新增 window.__AUTOEXAM_INJECTED 守卫（App 在 onPageStarted 与
//      onPageFinished 各注入一次，不守卫会执行两遍）。
//   3) 面板样式：桌面固定 310px → 手机适配（min(310px, calc(100vw-16px))、
//      显式配色防白字、-webkit-appearance 规范化）。
//   4) 网络请求通道：PC 用 GM_xmlhttpRequest（可绕 CORS）；本版优先走
//      HRBridge.nativeApi（Android 原生请求，绕浏览器 CORS），不可用时回退 fetch。
//   5) 后端地址持久化：本版用 HRBridge.getApiUrl/setApiUrl（SharedPreferences，
//      不受 http/https 不同源 localStorage 影响），并在加载时写回 CFG.api。
//
// 其余（题目解析、匹配归一化 numCmpKey/dateCmpKey、单选/多选/判断点击、
// 逐项等待 Vue 刷新等）与 PC 原版完全相同。
// 修改答题逻辑时请两边同步；本文件由 tools/sync_autoexam.ps1 从 PC 版生成。
// ============================================================================
(function () {
    'use strict';
    if (window.__AUTOEXAM_INJECTED) return;
    window.__AUTOEXAM_INJECTED = true;

    /* ---------------- config ---------------- */
    // 内置默认密钥：与 backend/config.json 的 api_key 一致。
    // 平时完全不用管：本机/局域网/私网后端会自动免密钥；公网后端才用它，也是自动发送。
    // 只有当你改了服务器密钥时，才需要在面板“密钥”里填一次新的。
    const DEFAULT_API_KEY = 'oJF9_FbS9DD0mLd9g7sZfGCm-UBuhMoXcgvCQVskF8A';
    let CFG = {
        api: 'http://127.0.0.1:8765',       // 后端地址(面板里也能改)
        delayBefore: 300,                    // 开始答当前题前的等待(ms)
        delayAfter: 1000,                    // 选题后、点下一题前的等待(ms)
        delayAdvance: 420,                   // 点下一题后等待页面切换(ms)
        jitter: 300,                         // 额外随机抖动(ms)
        maxStall: 3,                         // 连续点不到下一题的次数，达到即自动停止
        maxNetRetry: 6,                      // 后端连续无响应的重试上限，达到即自动暂停
        autoBankFilter: true,                // 用页面标题里的《…》限定题库范围(更准更快)
        judgeClick: true,                    // 判断题：自动点击 对/错
        autoStart: false,                    // 默认不自动开始，需手动点「▶ 开始」(可在面板勾选)
        apiKey: DEFAULT_API_KEY,             // 默认即内置密钥，无需填写
    };

    /* ---------------- state ---------------- */
    let running = false;
    let stopFlag = false;
    let stats = { answered: 0, ok: 0, miss: 0, err: 0 };

    /* ---------------- storage (localStorage fallback) ---------------- */
    function storageGet(key, def) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); } catch (e) { /* ignore */ }
        try {
            const raw = localStorage.getItem('autoexam_' + key);
            if (raw === null) return def;
            try { return JSON.parse(raw); } catch (e) { return raw; }
        } catch (e) { return def; }
    }
    function storageSet(key, val) {
        try { if (typeof GM_setValue === 'function') return GM_setValue(key, val); } catch (e) { /* ignore */ }
        try { localStorage.setItem('autoexam_' + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
    }

    /* ---------------- helpers ---------------- */
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function jitter(ms) { return Math.max(50, Math.round(ms + Math.random() * CFG.jitter)); }
    function norm(t) {
        if (!t) return '';
        const m = { '，': ',', '。': '.', '（': '(', '）': ')', '；': ';', '：': ':', '、': ',',
            '！': '!', '？': '?', '“': '"', '”': '"', '‘': "'", '’': "'", '／': '/', '％': '%',
            '＃': '#', '＆': '&', '＊': '*', '＋': '+', '－': '-', '＝': '=', '＠': '@' };
        let s = t.replace(/[\u3000\u00A0]/g, ' ').replace(/\s+/g, '');
        s = s.replace(/[，。（）；：、！？“”‘’／％＃＆＊＋－＝＠]/g, ch => (m[ch] !== undefined ? m[ch] : ch));
        return s.replace(/[\(\[]([ ＿_..\u3000]*)[\)\]]/g, '()');
    }

    const TRUE_WORDS = ['对', '正确', 'true', '是', 't', 'y', '√'];
    const FALSE_WORDS = ['错', '错误', 'false', '否', 'f', 'n', '×'];

    function apiRequest(method, path, payload) {
        return new Promise((resolve, reject) => {
            const done = (text) => {
                try { resolve(JSON.parse(text)); }
                catch (e) { reject(new Error('后端返回非JSON: ' + String(text).slice(0, 80))); }
            };
            const fail = (st) => reject(new Error(
                (st === 401 ? '后端要密钥：请在面板填与 config.json 相同的 api_key' :
                 st === 429 ? '请求过于频繁(限流)' :
                 '连不上 ' + CFG.api + '，请先双击 start_server.bat 启动后端')));
            const mkHeaders = () => {
                const h = payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {};
                if (CFG.apiKey) h['X-API-Key'] = CFG.apiKey;
                return h;
            };
            // KQ WebView 原生网络桥：用 Android 原生发起请求，绕过浏览器 CORS，可直连公网后端。
            if (window.HRBridge && typeof window.HRBridge.nativeApi === 'function') {
                try {
                    const r = JSON.parse(window.HRBridge.nativeApi(CFG.api + path, method, payload ? JSON.stringify(payload) : '', CFG.apiKey || ''));
                    if (r && r.ok) done(r.text); else fail(r.status || 0);
                    return;
                } catch (e) { /* 原生桥异常则继续走 GM/fetch */ }
            }
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method, url: CFG.api + path, timeout: 15000,
                    data: payload ? JSON.stringify(payload) : undefined,
                    headers: mkHeaders(),
                    onload: r => { if (r.status && r.status >= 400) fail(r.status); else done(r.responseText); },
                    onerror: () => fail(0),
                    ontimeout: () => reject(new Error('请求超时')),
                });
            } else {
                fetch(CFG.api + path, {
                    method,
                    headers: mkHeaders(),
                    body: payload ? JSON.stringify(payload) : undefined,
                }).then(async r => {
                    const text = await r.text();
                    if (!r.ok) fail(r.status); else done(text);
                }).catch(() => fail(0));
            }
        });
    }
    const apiGet = (p) => apiRequest('GET', p);
    const apiPost = (p, b) => apiRequest('POST', p, b);

    /* ---------------- page parsing ---------------- */
    function isVisible(el) {
        if (!el) return false;
        try {
            if (el.getClientRects().length > 0) return true;
            const st = getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden';
        } catch (e) { return false; }
    }

    function currentBankFilter() {
        if (!CFG.autoBankFilter) return '';
        const h = document.querySelector('h1.vux-header-title, .vux-header-title');
        const t = h ? h.textContent : '';
        const m = t.match(/《[^》]*》/);
        return m ? m[0] : '';
    }

    function currentBlock() {
        const nodes = document.querySelectorAll('div.topic-mc');
        for (const n of nodes) if (isVisible(n)) return n;
        return nodes[0] || null;
    }

    function extractQuestion() {
        const block = currentBlock();
        if (!block) return null;
        let type = 'single', typeText = '';
        const typeEl = block.querySelector('p.font-size16.margin-bottom10');
        if (typeEl) {
            typeText = typeEl.textContent.replace(/\s+/g, '').trim();
            if (typeText.includes('多选')) type = 'multi';
            else if (typeText.includes('判断')) type = 'judge';
        }
        let stemP = null;
        block.querySelectorAll('p.font-size16').forEach(p => {
            if (!p.classList.contains('margin-bottom10') && !stemP) stemP = p;
        });
        let num = -1;
        let stem = '';
        if (stemP) {
            const raw = stemP.textContent.replace(/\s+/g, ' ').trim();
            const mm = raw.match(/^(\d+)\s*[.．、]\s*/) || raw.match(/^(\d+)\s+/);
            if (mm) { num = parseInt(mm[1], 10); stem = raw.slice(mm[0].length).trim(); }
            else stem = raw;
        }
        // 选项：优先 selection-xx / module-list-06，退而求其次任意 <ul><li>（兼容真实页面 class 差异）
        const optLis = collectOptionLis(block);
        const options = [];
        optLis.forEach(li => {
            const t = li.textContent.replace(/\s+/g, ' ').trim();
            if (t) options.push(t);
        });
        // 调试：选择题 1 的时候把原始选项记录到全局，便于排查
        window.__aeOpts = options;
        return { num, type, typeText, stem, options, block, lis: optLis };
    }

    // 在一个题目块里找出“选项列表”的 li（去重、保序）
    function collectOptionLis(block) {
        const seen = new Set();
        const out = [];
        const pick = (nl) => {
            for (const li of nl) {
                if (!seen.has(li)) { seen.add(li); out.push(li); }
            }
        };
        pick(block.querySelectorAll('ul.selection-01 > li, ul.selection-02 > li, ul.selection-03 > li, ul.selection-04 > li'));
        pick(block.querySelectorAll('ul.module-list-06 > li'));
        if (!out.length) pick(block.querySelectorAll('ul > li'));   // 兜底：随便一个 ul 下的 li
        return out;
    }

    function clickOption(li) {
        if (!li) { logLine(undefined, '⚠ 点击失败: li 为空(旧DOM节点可能已被页面重新渲染)'); return false; }
        try { li.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { /* ignore */ }
        const target = li.querySelector('span') || li.querySelector('i') || li;
        if (!target) { logLine(undefined, '⚠ 点击失败: 选项内找不到点击目标'); return false; }
        let dispatched = 0;
        // 一次完整事件序列，适配 @click / @mousedown / @touchstart 等绑定方式
        ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click'].forEach(t => {
            let ev = null;
            try { ev = new PointerEvent(t, { bubbles: true, cancelable: true, view: window }); }
            catch (e) { try { ev = new MouseEvent(t, { bubbles: true, cancelable: true, view: window }); } catch (e2) { ev = null; } }
            if (ev) { target.dispatchEvent(ev); dispatched++; }
        });
        try { target.click(); dispatched++; } catch (e) { /* ignore */ }
        return true;
    }

    function nextButton() {
        const foot = document.querySelector('.exam-foot');
        if (!foot) return null;
        const els = foot.querySelectorAll('div, span, a, button');
        for (const el of els) {
            if (el.children.length === 0 && (el.textContent || '').trim() === '下一题') return el;
        }
        return null;
    }

    /* ---------------- selection ---------------- */
    // 数字/百分比归一化：5% ↔ 0.05 ↔ 5.0% 视为相等，解决“页面选项写 5%、题库答案写 0.05”匹配不上
    function numCmpKey(k) {
        const s = String(k).replace(/[,\s\u3000]/g, '');
        let m = s.match(/^(-?\d+(?:\.\d+)?)%$/);
        if (m) return String(Number(m[1]) / 100);
        m = s.match(/^(-?\d+(?:\.\d+)?)$/);
        if (m) return String(Number(m[1]));
        return k;
    }

    // Excel 序列日期 -> YYYY-MM-DD（Excel 1900 日期系统，含伪闰日 1900-02-29 的修正）
    function excelSerialToYmd(serial) {
        const days = serial - 2;   // serial>=60 时与 1900-01-01 的偏移修正
        const d = new Date(Date.UTC(1900, 0, 1) + days * 86400000);
        const p = n => (n < 10 ? '0' + n : '' + n);
        return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    }

    // 日期归一化：把 "2024年11月9日"/"2024-11-09"/"2024/11/9" 与 Excel 序列 "45605" 归成同一个键(YYYY-MM-DD)
    function dateCmpKey(k) {
        const s = String(k).trim();
        let m = s.match(/^(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?$/);
        if (m) {
            const p = n => (n < 10 ? '0' + n : '' + n);
            return m[1] + '-' + p(+m[2]) + '-' + p(+m[3]);
        }
        m = s.match(/^(\d{5,6})$/);   // 纯 5-6 位数字 -> 可能是 Excel 序列日期
        if (m) {
            const n = +m[1];
            if (n >= 30000 && n <= 90000) return excelSerialToYmd(n);
        }
        return k;
    }

    // 选项比较键：去掉常见序号前缀(A. ① 1、 一、等)，再归一化（含数字/百分比/日期等价）
    function optKey(t) {
        let s = norm(t);
        s = s.replace(/^(?:[A-Ha-h]|[ⅠⅡⅢⅣⅤ]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]{1,2})\s*[.．、:：)]/, '');
        return dateCmpKey(numCmpKey(s));
    }

    function dice(a, b) {
        if (a === b) return 1;
        if (!a.length || !b.length) return 0;
        const sb = new Set();
        for (let i = 0; i < b.length - 1; i++) sb.add(b.slice(i, i + 2));
        let inter = 0;
        for (let i = 0; i < a.length - 1; i++) if (sb.has(a.slice(i, i + 2))) inter++;
        return (2 * inter) / (a.length - 1 + b.length - 1);
    }

    // 把“答案文字”匹配到“页面选项下标”；精确优先，模糊兜底
    function matchAnswers(q, answers) {
        const lis = q.lis && q.lis.length ? q.lis : collectOptionLis(q.block);
        const optKeys = q.options.map(optKey);
        const ans = answers.map(t => ({ raw: t, key: optKey(t) }));
        const usedOpt = new Set();
        const chosen = [];
        ans.forEach(a => {
            if (!a.key) return;
            const i = optKeys.findIndex((k, oi) => !usedOpt.has(oi) && k === a.key);
            if (i >= 0) { usedOpt.add(i); chosen.push({ opt: i, ans: a }); }
        });
        ans.forEach(a => {
            if (chosen.some(c => c.ans === a)) return;
            if (!a.key || a.key.length < 4) return;
            let bestOi = -1, bestSc = 0;
            optKeys.forEach((k, oi) => {
                if (usedOpt.has(oi)) return;
                const sc = dice(a.key, k);
                if (sc > bestSc) { bestSc = sc; bestOi = oi; }
            });
            if (bestOi >= 0 && bestSc >= 0.8) { usedOpt.add(bestOi); chosen.push({ opt: bestOi, ans: a }); }
        });
        const missing = ans.filter(a => !chosen.some(c => c.ans === a)).map(a => a.raw);
        return { lis, chosen, missing };
    }

    function logOptionDebug(q, answers) {
        const short = arr => arr.map(x => '「' + String(x).slice(0, 16) + '」').join('  ');
        logLine(q.num, `⚠ 页面没匹配到选项。选项(${q.options.length}): ` + short(q.options));
        logLine(q.num, `   答案(${answers.length}): ` + short(answers));
    }

    function answeredCount() {
        try {
            const txt = ((document.querySelector('.exam-nav') || {}).textContent) || '';
            const m = txt.match(/已答\s*[:(（]?\s*(\d+)\s*[\/／]/);
            return m ? parseInt(m[1], 10) : -1;
        } catch (e) { return -1; }
    }

    function countSelectedLis(q) {
        let n = 0;
        collectOptionLis(q.block).forEach(li => {
            const cls = (li.className || '') + ' ' + ((li.querySelector('i') || {}).className || '');
            if (/\b(?:selected|active|cur|checked|highlight|on|s|sel|choose)\b/.test(cls)) n++;
        });
        return n;
    }

    // 点击后确认是否真的选中（看“已答”计数或选中样式）
    async function verifySelection(q) {
        try {
            const before = answeredCount();
            await sleep(400);
            const after = answeredCount();
            const selNow = countSelectedLis(q);
            if (after > before || selNow > 0) return true;
            logLine(q.num, `⚠ 点了选项但“已答”还是 ${before}，可能没点中（选项带序号前缀或点击事件未触发）`);
            return false;
        } catch (e) { return true; }
    }

    function selectSingle(q, answers) {
        const r = matchAnswers(q, answers || []);
        if (!r.chosen.length) { logOptionDebug(q, answers || []); return false; }
        const c = r.chosen[0];
        if (clickOption(r.lis[c.opt])) { logLine(q.num, '单选 → 点击: ' + q.options[c.opt]); return true; }
        return false;
    }

    // 在当前题目块里，按“答案比较键”找到对应的最新选项节点
    function findLiByKey(block, key) {
        if (!block) return null;
        const lis = collectOptionLis(block);
        for (const li of lis) {
            if (optKey((li.textContent || '').replace(/\s+/g, ' ').trim()) === key) return li;
        }
        return null;
    }

    // 判断某个选项节点是否已进入选中态（按常见 class 名判断）
    function isSelectedLi(li) {
        if (!li) return false;
        try {
            const cls = (li.className || '') + ' ' + ((li.querySelector('i') || {}).className || '');
            return /\b(?:selected|active|cur|checked|highlight|on|s|sel|choose)\b/.test(cls);
        } catch (e) { return false; }
    }

    async function selectMulti(q, answers) {
        const r = matchAnswers(q, answers || []);
        if (!r.chosen.length) { logOptionDebug(q, answers || []); return false; }
        let clicked = 0;
        let missAny = false;
        const doneKeys = new Set();
        for (const c of r.chosen) {
            const key = c.ans.key;
            if (!key || doneKeys.has(key)) continue;
            let block = null;
            try { block = (q.block && q.block.isConnected) ? q.block : currentBlock(); } catch (e) { block = null; }
            const li = findLiByKey(block, key);
            if (!li) { missAny = true; continue; }
            doneKeys.add(key);
            clickOption(li);
            // 关键：页面是 Vue 渲染，点一项后等它刷新，再点下一项，避免旧 DOM/状态被重渲染冲掉
            await sleep(120);
            // 保险：若该项仍未进入选中态，把“最新”节点再直接 click 一次
            let block2 = null;
            try { block2 = (q.block && q.block.isConnected) ? q.block : currentBlock(); } catch (e) { block2 = block; }
            const li2 = findLiByKey(block2, key);
            if (li2 && !isSelectedLi(li2)) {
                try { li2.click(); } catch (e) { /* ignore */ }
                await sleep(120);
            }
            clicked++;
        }
        logLine(q.num, `多选 → 点击 ${clicked} 项` + (missAny ? `（有未匹配项）` : ''));
        return clicked > 0 && !missAny;
    }

    function selectJudge(q, answer) {
        const lis = q.lis && q.lis.length ? q.lis : collectOptionLis(q.block);
        const keys = q.options.map(optKey);
        for (const w of (answer === true ? TRUE_WORDS : FALSE_WORDS)) {
            const wk = optKey(w);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] === wk) {
                    clickOption(lis[i]);
                    logLine(q.num, `判断题(${answer ? '对' : '错'}) → 点击: ${q.options[i]}`);
                    return true;
                }
            }
        }
        logOptionDebug(q, [answer === true ? '对' : '错']);
        return false;
    }

    /* returns: 'ok' | 'skip' | 'error' */
    async function answerCurrent(q) {
        try {
            return await answerCurrentInner(q);
        } catch (e) {
            logLine(q.num, '⚠ 处理题目异常: ' + (e && e.message ? e.message : e));
            stats.err++;
            return 'error';
        }
    }

    async function answerCurrentInner(q) {
        try { await sleep(jitter(CFG.delayBefore)); } catch (e) { /* ignore */ }
        const bank = currentBankFilter();
        let res;
        try {
            res = await apiPost('/api/query', { type: q.type, stem: q.stem, options: q.options, bank });
        } catch (e) {
            logLine(q.num, '⚠ 后端请求失败: ' + e.message);
            stats.err++;
            return 'error';
        }
        if (!res || !res.found) {
            logLine(q.num, '未匹配(题库里没有/题库未加载) → 跳过本题');
            stats.miss++;
            return 'skip';
        }
        logLine(q.num, `匹配 ${res.match_type} 置信度 ${Math.round((res.confidence || 0) * 100)}% [${res.file || res.bank}]`);

        // 关键：等待后端返回的这段时间里页面(Vue)可能已重新渲染，旧 DOM 节点已失效。
        // 这里重新抓一次“最新”题目，用最新的选项节点去点。
        let fresh;
        try { fresh = extractQuestion(); } catch (e) { fresh = null; }
        if (q.num !== -1 && fresh && fresh.num !== -1 && fresh.num !== q.num) {
            // 页面已经跳到别的题（自动前进等），这一题就不点了，交给下一轮循环处理当前题
            return 'ok';
        }
        const target = (fresh && fresh.block && fresh.lis && fresh.lis.length) ? fresh : q;

        let done = false;
        if (target.type === 'judge' && res.judge_answer !== null && res.judge_answer !== undefined) {
            done = selectJudge(target, res.judge_answer);
        } else if (target.type === 'multi') {
            done = await selectMulti(target, res.answers || []);
        } else {
            done = selectSingle(target, res.answers || []);
        }
        if (done) { stats.ok++; done = await verifySelection(target); if (!done) stats.miss++; }
        else stats.miss++;
        try { await sleep(jitter(CFG.delayAfter)); } catch (e) { /* ignore */ }
        return done ? 'ok' : 'skip';
    }

    async function advanceToOnePast(expectedNum) {
        const q0 = extractQuestion();
        if (q0 && q0.num !== -1 && q0.num !== expectedNum) return true;
        const btn = nextButton();
        if (!btn) return false;
        btn.click();
        await sleep(jitter(CFG.delayAdvance));
        const q = extractQuestion();
        return !!(q && q.num !== -1 && q.num !== expectedNum);
    }

    /* ---------------- main loop ---------------- */
    async function run() {
        running = true;
        stopFlag = false;
        stats = { answered: 0, ok: 0, miss: 0, err: 0 };
        uiUpdate();
        log('▶ 开始自动答题');

        let lastHandledNum = null;
        let stall = 0;
        let netRetry = 0;
        let retrying = false;

        while (!stopFlag) {
            let q;
            try { q = extractQuestion(); } catch (e) { q = null; }
            if (!q || !q.block) {
                log('⏳ 未找到题目，等待页面加载…');
                await sleep(1200);
                continue;
            }
            if (!retrying && q.num !== -1 && q.num === lastHandledNum) {
                stall++;
                if (stall >= CFG.maxStall) { log('⏹ 题目没有变化（可能已到最后），自动停止'); break; }
                await sleep(900);
                continue;
            }
            retrying = false;
            lastHandledNum = q.num;

            if (q.num !== -1) {
                const mm = ((document.querySelector('.exam-nav') || {}).textContent || '').match(/\((\d+)\/(\d+)\)/);
                log(`— 第 ${q.num} 题 ${q.typeText} 选项${q.options.length}（已答 ${mm ? mm[1] : '?'}/${mm ? mm[2] : '?'}）`);
            } else {
                log(`— ${q.typeText} 选项${q.options.length}`);
            }

            const status = await answerCurrent(q);
            stats.answered++;
            uiUpdate();

            if (status === 'error' || status === 'retry') {
                retrying = true;
                netRetry++;
                if (netRetry >= CFG.maxNetRetry) {
                    log('⏹ 后端多次未响应，已自动暂停（启动后端后点「开始」继续；已答过的题不会重答当前题）');
                    break;
                }
                await sleep(2000);
                continue;                      // 不跳题，原地重试
            }
            netRetry = 0;

            await sleep(jitter(280));
            const moved = await advanceToOnePast(q.num);
            if (!moved) {
                stall++;
                log(`⏹ 无法进入下一题(连续 ${stall})`);
                if (stall >= CFG.maxStall) { log('⏹ 已达到最后一题，自动停止'); break; }
            }
            uiUpdate();
        }

        running = false;
        if (!stopFlag) log('✅ 已自动完成并停止');
        else log('⏹ 已手动停止');
        uiUpdate();
    }

    /* ---------------- UI (collapsible + draggable + self-check) ---------------- */
    let dock = null, bodyEl = null, bubbleEl = null;
    let logEl = null, healthEl = null, parseEl = null, statEl = null, statusEl = null;
    let collapsed = !!storageGet('collapsed', false);
    // v1.6.0 一次性重置：自动开始默认关、间隔默认 1000（尊重用户新默认）
    if (storageGet('cfgver', '') !== '2') {
        storageSet('autoStart', false);
        storageSet('delay', 1000);
        storageSet('cfgver', '2');
    }
    let autoStart = !!storageGet('autoStart', CFG.autoStart);
    let diagTimer = null;

    function logLine(num, msg) {
        const t = new Date().toTimeString().slice(0, 8);
        const line = (num !== undefined && num !== null && num !== -1 ? `#${num} ` : '') + msg;
        if (logEl) {
            logEl.textContent += `[${t}] ${line}\n`;
            logEl.scrollTop = logEl.scrollHeight;
        }
    }
    function log(msg) { logLine(undefined, msg); }

    function uiUpdate() {
        if (!panelAlive()) return;
        statusEl.textContent = running ? '答题中…' : '已停止';
        statusEl.style.color = running ? '#1a7f37' : '#c0392b';
        statEl.textContent = `已处理 ${stats.answered} | 成功 ${stats.ok} | 未匹配 ${stats.miss} | 异常 ${stats.err}`;
    }
    function panelAlive() { return !!(dock && dock.isConnected && healthEl); }

    async function refreshHealth() {
        let text, cls;
        try {
            const h = await apiGet('/api/health');
            text = `后端已连接 · ${h.questions} 题 / ${h.files} 个题库`;
            cls = 'good';
        } catch (e) {
            text = '后端未连接（请先双击 start_server.bat）';
            cls = 'bad';
        }
        if (panelAlive()) {
            healthEl.textContent = text;
            healthEl.className = cls;
            const dot = dock.querySelector('#autoexam-bubble-dot');
            if (dot) dot.className = 'dot ' + cls;
        }
    }

    function refreshParse() {
        if (!panelAlive()) return;
        let q = null;
        try { q = extractQuestion(); } catch (e) { q = null; }
        if (!q || !q.block) { parseEl.textContent = '当前题：未解析到（不在答题页）'; return; }
        const optCnt = q.options.length;
        const stemShow = q.stem.length > 26 ? q.stem.slice(0, 26) + '…' : q.stem;
        parseEl.textContent = `当前题：${q.num !== -1 ? '第 ' + q.num + ' 题 ' : ''}${q.typeText} 题干「${stemShow}」选项 ${optCnt} 个`;
    }

    function setCollapsed(c) {
        collapsed = !!c;
        storageSet('collapsed', collapsed);
        if (!panelAlive()) return;
        dock.classList.toggle('collapsed', collapsed);
        bodyEl.style.display = collapsed ? 'none' : '';
        bubbleEl.style.display = collapsed ? '' : 'none';
        if (!collapsed) { refreshParse(); refreshHealth(); }
        clampDock();   // 展开或收起后都保证整个浮窗在屏幕内（停靠右边缘时向左展开）
    }

    function clampDock() {
        const r = dock.getBoundingClientRect();
        const vw = window.innerWidth || 800;
        const vh = window.innerHeight || 600;
        const maxLeft = Math.max(8, vw - r.width - 8);
        const maxTop = Math.max(8, vh - r.height - 8);
        // 如果从未设置 left（用 right 定位），先按“右边缘不动”换算成 left
        let L, T;
        if (dock.style.left && dock.style.left !== 'auto') {
            L = parseInt(dock.style.left, 10) || 8;
        } else {
            const R = parseInt(dock.style.right, 10);
            L = !isNaN(R) ? (vw - r.width - R) : (vw - r.width - 10);
        }
        if (dock.style.top && dock.style.top !== 'auto') {
            T = parseInt(dock.style.top, 10) || 8;
        } else {
            T = 10;
        }
        L = Math.min(Math.max(8, L), maxLeft);
        T = Math.min(Math.max(8, T), maxTop);
        dock.style.left = L + 'px';
        dock.style.top = T + 'px';
        dock.style.right = 'auto';
        storageSet('dockpos', JSON.stringify({ left: L, top: T }));
    }

    function makeDraggable(handleEl) {
        if (!handleEl) return;
        handleEl.style.touchAction = 'none';     // 关键：不让浏览器把拖动手势抢去滚动
        let sx = 0, sy = 0, sox = 0, soy = 0, dragging = false;
        const down = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target.closest && (e.target.closest('button') || e.target.closest('input'))) return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            sox = dock.offsetLeft; soy = dock.offsetTop;
            if (handleEl.setPointerCapture) { try { handleEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
            e.preventDefault();
        };
        const mv = (e) => {
            if (!dragging) return;
            dock.style.left = (sox + e.clientX - sx) + 'px';
            dock.style.top = (soy + e.clientY - sy) + 'px';
            dock.style.right = 'auto';
        };
        const up = () => {
            if (!dragging) return;
            dragging = false;
            clampDock();
        };
        handleEl.addEventListener('pointerdown', down);
        handleEl.addEventListener('pointermove', mv);
        handleEl.addEventListener('pointerup', up);
        handleEl.addEventListener('pointercancel', up);
    }

    function buildPanel() {
        if (document.getElementById('autoexam-dock')) return;
        dock = document.createElement('div');
        dock.id = 'autoexam-dock';
        let dpos = null;
        try { dpos = JSON.parse(storageGet('dockpos', 'null')); } catch (e) { dpos = null; }
        if (dpos && dpos.left !== undefined) {
            dock.style.left = dpos.left + 'px';
            dock.style.top = dpos.top + 'px';
        } else {
            dock.style.right = '10px';
            dock.style.top = '10px';
        }
        dock.innerHTML = `
<div id="autoexam-body">
  <div id="autoexam-drag" style="cursor:move;font-size:13px;font-weight:700;color:#111;margin-bottom:6px;user-select:none">
    🎯 自动答题助手
    <span id="autoexam-status" style="float:right;font-weight:600;color:#c0392b">已停止</span>
    <span style="float:right;margin-right:8px">
      <button id="autoexam-collapse" title="收起">—</button>
    </span>
  </div>
  <div id="autoexam-health" class="good" style="font-size:12px;margin-bottom:4px">后端检测中…</div>
  <div id="autoexam-parse" style="font-size:12px;color:#333;margin-bottom:4px;word-break:break-all">当前题：解析中…</div>
  <div id="autoexam-stat" style="font-size:12px;color:#555;margin-bottom:6px"></div>
  <div style="margin-bottom:5px">
    <button id="autoexam-start">▶ 开始</button>
    <button id="autoexam-stop">■ 停止</button>
    <button id="autoexam-one">单题测试</button>
    <button id="autoexam-reload" title="重新扫描题库目录(添加/删除/更新 xlsx 后点这里)">重载题库</button>
    <button id="autoexam-re" title="重新检测后端并解析当前题">自检</button>
    <button id="autoexam-clear">清日志</button>
  </div>
  <div style="font-size:12px;color:#666;margin-bottom:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <label title="载入考试页后自动开始答题"><input id="autoexam-autostart" type="checkbox">自动开始</label>
    <label>间隔 <input id="autoexam-delay" type="number" style="width:56px" title="选题后到点下一题的间隔(ms)"></label>
    <label>后端 <input id="autoexam-api" type="text" style="width:112px"></label>
    <label title="与后端 config.json 里的 api_key 一致；本机用它才会启用鉴权">密钥 <input id="autoexam-apikey" type="password" style="width:92px"></label>
  </div>
  <pre id="autoexam-log" style="margin:0;height:110px;overflow:auto;font-size:11px;background:#0d1117;color:#c9d1d9;padding:6px;border-radius:4px;white-space:pre-wrap;word-break:break-all"></pre>
</div>
<div id="autoexam-bubble" style="display:none;cursor:move;user-select:none;">🎯<span id="autoexam-bubble-dot" class="dot"></span></div>
<style>
/* ---- 自动答题悬浮面板（WebView 手机适配版） ---- */
#autoexam-dock{position:fixed;z-index:2147483647;width:min(310px, calc(100vw - 16px));max-width:310px;background:#fff;color:#24292f;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:8px 10px;font-family:-apple-system,'Microsoft YaHei',sans-serif;font-size:12px;line-height:1.4;touch-action:none;will-change:left,top}
#autoexam-dock *{box-sizing:border-box}
#autoexam-dock button{margin:2px 4px 2px 0;padding:5px 10px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#24292f;cursor:pointer;font-size:12px;line-height:1.2;-webkit-appearance:none;appearance:none}
#autoexam-dock button:hover{background:#eaeef2}
#autoexam-dock input{border:1px solid #d0d7de;border-radius:4px;padding:3px 5px;font-size:12px;color:#24292f;background:#fff}
#autoexam-dock label{color:#444}
#autoexam-dock .good{color:#1a7f37}
#autoexam-dock .bad{color:#c0392b}
#autoexam-dock.collapsed{width:46px;height:46px;border-radius:50%;padding:0;box-shadow:0 2px 10px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;overflow:hidden}
#autoexam-dock.collapsed #autoexam-body{display:none}
#autoexam-bubble{font-size:24px;line-height:1;padding:0;position:relative;cursor:move;display:flex;align-items:center;justify-content:center;width:100%;height:100%}
#autoexam-bubble .dot{position:absolute;right:-1px;top:-1px;width:12px;height:12px;border-radius:50%;border:2px solid #fff}
#autoexam-bubble .dot.good{background:#1a7f37}
#autoexam-bubble .dot.bad{background:#c0392b}
</style>`;
        (document.body || document.documentElement).appendChild(dock);

        bodyEl = dock.querySelector('#autoexam-body');
        bubbleEl = dock.querySelector('#autoexam-bubble');
        logEl = dock.querySelector('#autoexam-log');
        healthEl = dock.querySelector('#autoexam-health');
        parseEl = dock.querySelector('#autoexam-parse');
        statEl = dock.querySelector('#autoexam-stat');
        statusEl = dock.querySelector('#autoexam-status');

        dock.querySelector('#autoexam-collapse').onclick = (e) => { e.stopPropagation(); setCollapsed(!collapsed); };
        bubbleEl.addEventListener('click', () => setCollapsed(false));
        dock.querySelector('#autoexam-start').onclick = () => { if (!running) { stopFlag = false; run(); } };
        dock.querySelector('#autoexam-stop').onclick = () => { if (running) { stopFlag = true; log('⏹ 正在停止…'); } };
        dock.querySelector('#autoexam-one').onclick = async () => {
            if (running) { stopFlag = true; await sleep(300); }
            const q = extractQuestion();
            if (!q) { log('⚠ 未解析到当前题（页面还没渲染完？）'); return; }
            log(`— 单题测试：第 ${q.num} 题 ${q.typeText}`);
            const s = await answerCurrent(q);
            if (s === 'error') log('单题测试：后端请求失败，请检查 start_server.bat');
        };
        dock.querySelector('#autoexam-re').onclick = async () => {
            log('🔄 自检中…');
            await refreshHealth();
            refreshParse();
            log('🧪 自检完成：' + healthEl.textContent);
        };
        dock.querySelector('#autoexam-reload').onclick = async () => {
            log('🔄 正在重载题库（重新扫描题库目录）…');
            try {
                const r = await apiPost('/api/reload', {});
                log(`✅ 重载完成：共 ${r.questions} 题`);
                await refreshHealth();
            } catch (e) {
                log('⚠ 重载失败：' + e.message);
            }
        };
        dock.querySelector('#autoexam-clear').onclick = () => { if (logEl) logEl.textContent = ''; };

        const autoEl = dock.querySelector('#autoexam-autostart');
        autoEl.checked = autoStart;
        autoEl.onchange = () => { autoStart = autoEl.checked; storageSet('autoStart', autoStart); };

        const dInp = dock.querySelector('#autoexam-delay');
        dInp.value = storageGet('delay', CFG.delayAfter);
        dInp.onchange = () => { CFG.delayAfter = parseInt(dInp.value, 10) || 500; storageSet('delay', CFG.delayAfter); };

        const apiInp = dock.querySelector('#autoexam-api');
        let storedApi = '';
        try { if (window.HRBridge && typeof window.HRBridge.getApiUrl === 'function') storedApi = window.HRBridge.getApiUrl() || ''; } catch (e) {}
        if (!storedApi) { const v = storageGet('api', null); if (v !== null && v !== undefined) storedApi = String(v); }
        if (storedApi && storedApi.trim()) CFG.api = storedApi.trim().replace(/\/+$/, '');
        apiInp.value = CFG.api;
        apiInp.onchange = () => {
            const clean = (apiInp.value || '').trim().replace(/\/+$/, '');
            if (clean) CFG.api = clean;
            try { storageSet('api', CFG.api); } catch (e) {}
            try { if (window.HRBridge && typeof window.HRBridge.setApiUrl === 'function') window.HRBridge.setApiUrl(CFG.api); } catch (e) {}
        };
        const keyInp = dock.querySelector('#autoexam-apikey');
        // 从未设置过 -> 用内置默认密钥；设置过(含清空) -> 用保存值
        const _rawKey = storageGet('apikey', null);
        CFG.apiKey = (_rawKey === null || _rawKey === undefined) ? DEFAULT_API_KEY : String(_rawKey);
        keyInp.value = CFG.apiKey;
        keyInp.onchange = () => {
            CFG.apiKey = (keyInp.value || '').trim();
            storageSet('apikey', CFG.apiKey);
            log(CFG.apiKey ? '🔑 密钥已更新，点「自检」确认是否能连通' : '🔓 已清空密钥(连接私有/局域网后端)');
        };

        makeDraggable(dock.querySelector('#autoexam-drag'));
        makeDraggable(bubbleEl);   // 收起成圆形小图标之后，也可以直接拖动
        setCollapsed(collapsed);
        uiUpdate();
        refreshHealth();
        refreshParse();

        if (diagTimer) clearInterval(diagTimer);
        diagTimer = setInterval(() => {
            if (!panelAlive()) return;
            if (!collapsed) { refreshParse(); }
        }, 2500);
        setInterval(() => { if (panelAlive() && !collapsed) refreshHealth(); }, 15000);
    }

    /* ---------------- boot / auto start ---------------- */
    function boot() {
        try { console.log('[autoexam] 脚本已加载 v1.5.1，host=' + location.host + ' path=' + location.pathname); } catch (e) { /* ignore */ }
        try {
            buildPanel();
        } catch (e) {
            try { console.error('[autoexam] 面板创建失败:', e); } catch (err) { /* ignore */ }
        }
        // 某些 SPA 路由切换会重建 body，面板被移除时补回来
        try {
            const obs = new MutationObserver(() => {
                if (!document.getElementById('autoexam-dock')) buildPanel();
            });
            obs.observe(document.body || document.documentElement, { childList: true });
        } catch (e) { /* ignore */ }

        if (autoStart) {
            // 等题目真正渲染出来再自动开始；最多等 90 秒
            let tries = 0;
            const t = setInterval(() => {
                let q = null;
                try { q = extractQuestion(); } catch (e) { q = null; }
                tries++;
                if (q && q.block) {
                    clearInterval(t);
                    log('⚡ 检测到考试页已加载，自动开始…');
                    run();
                } else if (tries > 90) {
                    clearInterval(t);
                    log('⏳ 90 秒内没解析到题目，自动开始已跳过（可手动点「开始」）');
                }
            }, 1000);
        } else {
            log('🖐 未开启自动开始，点「▶ 开始」启动');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
