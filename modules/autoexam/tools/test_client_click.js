// Real-DOM test of the userscript's extraction/matching/click logic
// against the SAVED exam page (wethink-mobile.html) using jsdom.
// This answers: does our parsing + option matching + click dispatch actually work
// on the real page structure? (It cannot verify Vue's internal state changes,
// but it proves the DOM logic and events.)
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'wethink-mobile.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { document, HTMLCollection } = dom.window;

/* ----- replicate userscript helpers (must match autoexam.user.js) ----- */
function norm(t) {
    if (!t) return '';
    const m = { '，': ',', '。': '.', '（': '(', '）': ')', '；': ';', '：': ':', '、': ',',
        '！': '!', '？': '?', '“': '"', '”': '"', '‘': "'", '’': "'", '／': '/', '％': '%',
        '＃': '#', '＆': '&', '＊': '*', '＋': '+', '－': '-', '＝': '=', '＠': '@' };
    let s = t.replace(/[\u3000\u00A0]/g, ' ').replace(/\s+/g, '');
    s = s.replace(/[，。（）；：、！？“”‘’／％＃＆＊＋－＝＠]/g, ch => (m[ch] !== undefined ? m[ch] : ch));
    return s.replace(/[\(\[]([ ＿_..\u3000]*)[\)\]]/g, '()');
}
function optKey(t) {
    let s = norm(t);
    s = s.replace(/^(?:[A-Ha-h]|[ⅠⅡⅢⅣⅤ]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]{1,2})\s*[.．、:：)]/, '');
    return s;
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
function isVisible(el) {
    if (!el) return false;
    const styleMatch = (el.getAttribute('style') || '');
    return !/display:\s*none/.test(styleMatch);
}
function currentBlock() {
    const nodes = document.querySelectorAll('div.topic-mc');
    for (const n of nodes) if (isVisible(n)) return n;
    return nodes[0] || null;
}
function collectOptionLis(block) {
    const seen = new Set();
    const out = [];
    const pick = (nl) => { for (const li of nl) { if (!seen.has(li)) { seen.add(li); out.push(li); } } };
    pick(block.querySelectorAll('ul.selection-01 > li, ul.selection-02 > li, ul.selection-03 > li, ul.selection-04 > li'));
    pick(block.querySelectorAll('ul.module-list-06 > li'));
    if (!out.length) pick(block.querySelectorAll('ul > li'));
    return out;
}
function extractQuestion() {
    const block = currentBlock();
    if (!block) return null;
    let type = 'single', typeText = '';
    const typeEl = block.querySelector('p.font-size16.margin-bottom10');
    if (typeEl) { typeText = typeEl.textContent.replace(/\s+/g, '').trim(); }
    let stemP = null;
    block.querySelectorAll('p.font-size16').forEach(p => { if (!p.classList.contains('margin-bottom10') && !stemP) stemP = p; });
    let num = -1, stem = '';
    if (stemP) {
        const raw = stemP.textContent.replace(/\s+/g, ' ').trim();
        const mm = raw.match(/^(\d+)\s*[.．、]\s*/) || raw.match(/^(\d+)\s+/);
        if (mm) { num = parseInt(mm[1], 10); stem = raw.slice(mm[0].length).trim(); } else stem = raw;
    }
    const optLis = collectOptionLis(block);
    const options = [];
    optLis.forEach(li => { const t = li.textContent.replace(/\s+/g, ' ').trim(); if (t) options.push(t); });
    return { num, type: type.includes('多选') ? 'multi' : (type.includes('判断') ? 'judge' : 'single'),
             typeText, stem, options, block, lis: optLis };
}
function matchAnswers(q, answers) {
    const lis = q.lis || collectOptionLis(q.block);
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
        optKeys.forEach((k, oi) => { if (usedOpt.has(oi)) return; const sc = dice(a.key, k); if (sc > bestSc) { bestSc = sc; bestOi = oi; } });
        if (bestOi >= 0 && bestSc >= 0.8) { usedOpt.add(bestOi); chosen.push({ opt: bestOi, ans: a }); }
    });
    return { lis, chosen, missing: ans.filter(a => !chosen.some(c => c.ans === a)).map(a => a.raw) };
}
function clickOption(li, log) {
    if (!li) { log('⚠ clickOption: li为空(可能选项下标越界)'); return false; }
    try { li.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    const target = li.querySelector('span') || li.querySelector('i') || li;
    if (!target) { log('⚠ clickOption: 找不到点击目标'); return false; }
    let dispatched = 0;
    ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click'].forEach(t => {
        let ev;
        try { ev = new dom.window.PointerEvent ? new dom.window.PointerEvent(t, { bubbles: true, cancelable: true, view: dom.window }) : null; }
        catch (e) { ev = null; }
        if (!ev) { try { ev = new dom.window.MouseEvent(t, { bubbles: true, cancelable: true, view: dom.window }); } catch (e2) { /* ignore */ } }
        if (ev) { target.dispatchEvent(ev); dispatched++; }
    });
    try { target.click(); dispatched++; } catch (e) { /* ignore */ }
    log(`clickOption: target=<${target.tagName.toLowerCase()}> 事件=${dispatched}`);
    return true;
}
function nextButton() {
    const foot = document.querySelector('.exam-foot');
    if (!foot) return null;
    for (const el of foot.querySelectorAll('div, span, a, button')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === '下一题') return el;
    }
    return null;
}

/* ------------- run the test on the visible question ------------- */
let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra ? ' => ' + extra : '')); }
}

console.log('=== 测试1: 解析当前(可见)题目 ===');
const q = extractQuestion();
check('取到题目块', !!q && !!q.block);
if (q) {
    console.log('  第'+q.num+'题', q.typeText, '选项数='+q.options.length, '题干前28字:「'+q.stem.slice(0,28)+'」');
    check('选项数为4', q.options.length === 4, '实际=' + q.options.length);
    console.log('  选项原文:', q.options.map((o, i) => '[' + i + ']' + o).join(' | '));
}

console.log('\n=== 测试2: 选项匹配(用后端已知答案) ===');
const realAnswers = ['公安机关'];   // 题目1的正确选项文本（来自题库/后端）
const r = matchAnswers(q, realAnswers);
check('匹配到选项', r.chosen.length >= 1, 'chosen=' + JSON.stringify(r.chosen));
if (r.chosen.length) {
    const idx = r.chosen[0].opt;
    console.log('  正确答案「'+realAnswers[0]+'」 → 命中页面选项[' + idx + ']「'+q.options[idx]+'」');
    check('命中文本一致', q.options[idx] === realAnswers[0]);
}

console.log('\n=== 测试3: 点击事件是否真的派发到该 li ===');
if (r.chosen.length) {
    const li = r.lis[r.chosen[0].opt];
    const hits = [];
    ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click'].forEach(t => {
        li.addEventListener(t, () => hits.push(t));
    });
    const okClick = clickOption(li, m => console.log('  ' + m));
    check('clickOption返回成功', okClick === true);
    check('li 收到 click 事件', hits.includes('click'), '收到=' + JSON.stringify(hits));
    check('li 收到鼠标/触摸/指针事件', hits.length >= 5, 'events=' + JSON.stringify(hits));
    console.log('  li 实际收到的全部事件:', JSON.stringify(hits));
}

console.log('\n=== 测试4: 下一题按钮 ===');
const nb = nextButton();
check('找到下一题按钮', !!nb, 'foot存在=' + !!document.querySelector('.exam-foot'));
if (nb) {
    let clicked = false;
    nb.addEventListener('click', () => { clicked = true; });
    nb.click();
    check('下一题可点击(事件可派发)', clicked);
}

console.log('\n=== 测试5: 判断题选项识别 ===');
const q46 = (() => { // 直接构造一个判断题为 true 的选项列表来验证 optKey 匹配对/错
    const fake = { options: ['对', '错'], lis: [] };
    const ans = ['对'];
    const rr = matchAnswers(fake, ans);
    check('判断题 对 匹配成功', rr.chosen.length >= 1);
    return rr;
})();

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
