# -*- coding: utf-8 -*-
"""End-to-end check: ask the running API for all 55 page questions exactly like
the userscript does (type mapping + bank filter from the page header), and
verify every returned answer text exists among the page options."""
import json
import re
import urllib.request

BASE = 'http://127.0.0.1:8765'
page = json.load(open(r'D:\Autoexam\tools\_page_questions.json', encoding='utf-8'))
header = '1.《国务院办公厅关于保障城市轨道交通安全运行的意见》题库练习'
bank_filter = re.findall(r'《[^》]*》', header)[0]


def norm(t):
    if not t:
        return ''
    m = {'，': ',', '。': '.', '（': '(', '）': ')', '；': ';', '：': ':', '、': ',',
         '！': '!', '？': '?', '“': '"', '”': '"', '‘': "'", '’': "'", '／': '/',
         '％': '%', '＃': '#', '＆': '&', '＊': '*', '＋': '+', '－': '-', '＝': '=', '＠': '@'}
    s = t.replace('\u3000', ' ').replace('\u00A0', ' ')
    s = re.sub(r'\s+', '', s)
    for k, v in m.items():
        s = s.replace(k, v)
    return re.sub(r'[\(\[]([ ＿_..\u3000]*)[\)\]]', '()', s)


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


results = {'single': {}, 'multi': {}, 'judge': {}}
for pq in page:
    qtype = 'judge' if pq['type'] == '判断题' else ('multi' if pq['type'] == '多选题' else 'single')
    res = post('/api/query', {'type': qtype, 'stem': pq['stem'], 'options': pq['options'], 'bank': bank_filter})
    ok = False
    detail = res.get('match_type', '')
    if not res.get('found'):
        detail += ' NOT-FOUND'
    elif qtype == 'judge':
        ok = res.get('judge_answer') is not None
        detail += f" -> {'对' if res.get('judge_answer') else '错'} (page {pq['options']})"
    else:
        want = [norm(a) for a in res.get('answers', [])]
        have = [norm(o) for o in pq['options']]
        ok = bool(want) and all(w in have for w in want)
        detail += f" ans={res.get('answers')}"
    results[qtype][pq['num']] = (ok, detail, res.get('confidence'))

tot = allt = 0
for qt in results:
    good = sum(1 for v in results[qt].values() if v[0])
    tot += len(results[qt]); allt += good
    print(f'{qt}: {good}/{len(results[qt])}')
    for num, (ok, d, conf) in sorted(results[qt].items()):
        if not ok:
            print(f'    FAIL Q{num}: {d}  conf={conf}')
print(f'\nTOTAL {allt}/{tot}')
