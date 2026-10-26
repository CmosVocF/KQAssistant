// Verify the userscript's extraction logic against the saved exam page.
// Runs the exact same candidate selectors the Tampermonkey script uses,
// but on the static HTML (via regex) to confirm structure/class names.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'wethink-mobile.html'), 'utf8');

// --- simulate the userscript helper: find visible topic block -----------------
function extractFrom(html) {
  // locate a topic block: <... class="topic-mc white-bg" ...> ... </div>
  const blocks = [];
  const marker = 'class="topic-mc white-bg';
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const openStart = html.lastIndexOf('<div', idx);
    const gt = html.indexOf('>', idx);
    let depth = 1, i = gt + 1;
    while (i < html.length) {
      const nd = html.indexOf('<div', i);
      const nc = html.indexOf('</div>', i);
      if (nc === -1) break;
      if (nd !== -1 && nd < nc) { depth++; i = nd + 4; }
      else { depth--; i = nc + 6; if (depth === 0) break; }
    }
    blocks.push(html.slice(openStart, i));
    idx = html.indexOf(marker, i);
  }
  const out = [];
  for (const blk of blocks) {
    // visible? (style has no 'display: none') -> matches the live visible question
    const styleMatch = blk.match(/class="topic-mc white-bg[^"]*"[^>]*style="([^"]*)"/);
    const visible = !(styleMatch && /display:\s*none/.test(styleMatch[1]));
    // type tag
    const typeMatch = blk.match(/<p[^>]*class="font-size16 margin-bottom10"[^>]*>\s*\[(.*?)\]/);
    const type = typeMatch ? typeMatch[1] : '?';
    // stem <p class="font-size16" style="margin-bottom: 40px;">N.\n <span>...</span></p>
    const stemP = blk.match(/<p[^>]*class="font-size16"[^>]*style="[^"]*margin-bottom:\s*40px[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    let stem = stemP ? stemP[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
    const numMatch = stem.match(/^(\d+)\.\s*([\s\S]*)$/);
    let num = -1;
    if (numMatch) { num = +numMatch[1]; stem = numMatch[2].trim(); }
    // selection class
    const ul = blk.match(/<ul[^>]*class="(module-list-06[^"]*)"[^>]*>([\s\S]*?)<\/ul>/);
    const options = [];
    if (ul) {
      const lis = ul[2].match(/<li[^>]*>([\s\S]*?)<\/li>/g) || [];
      for (const li of lis) options.push(li.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    }
    out.push({ num, type, visible, ulcls: ul ? ul[1] : '', stem, options });
  }
  return out;
}

const parsed = extractFrom(html);
console.log('blocks:', parsed.length, 'visible:', parsed.filter(b => b.visible).length);
console.log('types:', parsed.reduce((a, b) => (a[b.type] = (a[b.type] || 0) + 1, a), {}));

// compare with the gold fixture
const gold = JSON.parse(fs.readFileSync(__dirname + '/_page_questions.json', 'utf8'));
let mism = 0;
parsed.forEach((b, i) => {
  const g = gold[i];
  const same = b.type === g.type && b.stem === g.stem && JSON.stringify(b.options) === JSON.stringify(g.options);
  if (!same) { mism++; console.log('MISMATCH', i + 1, 'vs gold', b.type, b.stem.slice(0, 20), g.stem.slice(0, 20)); }
});
console.log('mismatches vs gold:', mism, '/', parsed.length);

// footer buttons check
const foot = html.slice(html.indexOf('class="exam-foot"'));
const footText = foot.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').trim();
console.log('foot text (first 80):', footText.slice(0, 80));
console.log('has 下一题:', foot.includes('下一题'), '| has 交卷:', html.includes('交卷'));
