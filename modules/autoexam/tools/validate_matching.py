# -*- coding: utf-8 -*-
"""Validate the matcher against the real page questions and real banks."""
import json, sys, re
sys.path.insert(0, r'D:\Autoexam\backend')

from bank_loader import QuestionBank
from search import search_bank
from matcher import normalize

BANK_FOLDER = r'D:\Autoexam\exambank'

with open(r'D:\Autoexam\tools\_page_questions.json', 'r', encoding='utf-8') as f:
    page_qs = json.load(f)

# header of the page -> bank filter
header = '1.《国务院办公厅关于保障城市轨道交通安全运行的意见》题库练习'
m = re.findall(r'《[^》]*》', header)
bank_filter = m[0] if m else None
print('bank_filter:', bank_filter)

bank = QuestionBank(BANK_FOLDER)
n = bank.load()
print('loaded questions:', n)

# ground truth: bank records whose norm == page norm
truth = {}
for q in bank.questions:
    for pq in page_qs:
        key = (pq['num'], pq['type'])
        if key in truth:
            continue
        if q.norm == normalize(pq['stem']) and q.kind == ('judge' if pq['type'] == '判断题' else 'choice'):
            truth[key] = q

print('ground-truth mapped:', len(truth))

ok = 0
fail = []
for pq in page_qs:
    if pq['type'] == '单选题':
        qtype = 'single'
    elif pq['type'] == '多选题':
        qtype = 'multi'
    else:
        qtype = 'judge'
    best, conf, mtype, top = search_bank(bank, pq['stem'], qtype, bank_filter=bank_filter)
    if best is None:
        fail.append((pq['num'], pq['type'], 'NO RESULT'))
        continue
    exp = truth.get((pq['num'], pq['type']))
    if exp is not None and best is not exp:
        fail.append((pq['num'], pq['type'], f'WRONG -> matched "{best.stem[:30]}" conf={conf:.2f} {mtype}, expected "{exp.stem[:30]}"'))
        continue
    # verify answers appear in page options (for choice)
    page_opts_norm = [normalize(o) for o in pq['options']]
    ok_answers = True
    for at in best.answer_texts:
        if normalize(at) not in page_opts_norm:
            ok_answers = False
    if qtype == 'judge' and best.judge_answer is None:
        ok_answers = False
    if ok_answers:
        ok += 1
    else:
        fail.append((pq['num'], pq['type'], f'ANSWER-MISMATCH conf={conf:.2f} {mtype}'))

print(f'\nRESULT: {ok}/{len(page_qs)} passed')
for f_ in fail:
    print('  FAIL', f_)
