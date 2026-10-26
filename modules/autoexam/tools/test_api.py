# -*- coding: utf-8 -*-
"""End-to-end API test: post a few real page questions and print the answers."""
import json
import urllib.request

BASE = 'http://127.0.0.1:8765'
page = json.load(open(r'D:\KQAssistant\modules\autoexam\tools\_page_questions.json', encoding='utf-8'))
by_num = {q['num']: q for q in page}
header = '1.《国务院办公厅关于保障城市轨道交通安全运行的意见》题库练习'
import re
bank_filter = re.findall(r'《[^》]*》', header)[0]


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


cases = [
    (1, 'single'),
    (4, 'single'),
    (31, 'multi'),
    (32, 'multi'),
    (46, 'judge'),
    (55, 'judge'),
    (2, 'single'),   # normalizes to exact even with (   )
]
for num, qtype in cases:
    q = by_num[num]
    payload = {'type': qtype, 'stem': q['stem'], 'options': q['options'], 'bank': bank_filter}
    res = post('/api/query', payload)
    print(f'-- Q{num} [{qtype}] -> found={res["found"]} {res["match_type"]} conf={res["confidence"]}')
    if res['found']:
        print(f'   bank={res["bank"]} sheet={res["sheet"]}')
        if res['kind'] == 'judge':
            print(f'   judge_answer = {res["judge_answer"]}')
        else:
            print(f'   answers = {res["answers"]}')
        print(f'   page opts = {q["options"]}')
    else:
        print('   candidates:', [(c['stem'][:24]) for c in res['candidates']])

# banks + reload
with urllib.request.urlopen(BASE + '/api/banks', timeout=20) as r:
    print('\n--- banks ---')
    print(r.read().decode('utf-8')[:1200])
r = post('/api/reload', {})
print('\n--- reload ---', r)
