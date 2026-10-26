# -*- coding: utf-8 -*-
"""Parse wethink-mobile.html and extract all questions into JSON for testing."""
import re, json, html as html_mod

with open(r'D:\Autoexam\wethink-mobile.html', 'r', encoding='utf-8') as fh:
    html = fh.read()

markers = [m.start() for m in re.finditer(r'class="topic-mc white-bg', html)]
print('count topic-mc blocks:', len(markers))

questions = []
for idx, m in enumerate(markers):
    # opening tag start
    open_start = html.rfind('<div', 0, m)
    tag_end_gt = html.find('>', m)
    depth = 1
    i = tag_end_gt + 1
    # scan forward counting <div and </div>
    while i < len(html):
        nd = html.find('<div', i)
        nc = html.find('</div>', i)
        if nc == -1:
            break
        if nd != -1 and nd < nc:
            depth += 1
            i = nd + 4
        else:
            depth -= 1
            i = nc + 6
            if depth == 0:
                break
    block_end = i
    blk = html[open_start:block_end]
    blk = blk[blk.find('>'):]  # after opening tag
    # type
    tm = re.search(r'<p[^>]*>\[(.*?)\]</p>', blk)
    qtype = tm.group(1) if tm else '?'
    pm = re.search(r'<p[^>]*style="margin-bottom: 40px;">(.*?)</p>', blk, re.S)
    stem_raw = pm.group(1) if pm else ''
    stem_text = re.sub(r'<[^>]+>', '', stem_raw)
    stem_text = html_mod.unescape(stem_text).strip()
    stem_match = re.match(r'^(\d+)\.\s*(.*)$', stem_text, re.S)
    qnum = int(stem_match.group(1)) if stem_match else idx + 1
    stem = stem_match.group(2).strip() if stem_match else stem_text
    # options from ul
    opts = []
    ulm = re.search(r'<ul[^>]*class="(module-list-06[^"]*)"[^>]*>(.*?)</ul>', blk, re.S)
    ulcls = ulm.group(1) if ulm else ''
    ulbody = ulm.group(2) if ulm else ''
    for om in re.finditer(r'<li[^>]*class="[^"]*"[^>]*>(.*?)</li>', ulbody, re.S):
        otxt = re.sub(r'<[^>]+>', '', om.group(1))
        otxt = html_mod.unescape(otxt).strip()
        opts.append(otxt)
    questions.append({'num': qnum, 'type': qtype, 'stem': stem, 'options': opts, 'ul_class': ulcls})

with open(r'D:\Autoexam\_page_questions.json', 'w', encoding='utf-8') as f:
    json.dump(questions, f, ensure_ascii=False, indent=2)

for q in questions[:6]:
    print(q['num'], q['type'], q['ul_class'], '|', q['stem'][:42], '| opts:', q['options'][:3])
print('total:', len(questions))
types = {}
for q in questions:
    types[q['type']] = types.get(q['type'], 0) + 1
print('types:', types)
