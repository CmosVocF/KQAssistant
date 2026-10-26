# -*- coding: utf-8 -*-
"""Answer-format parsing compatibility test (different bank conventions)."""
import sys
sys.path.insert(0, r'D:\Autoexam\backend')
from bank_loader import parse_answer_ids, match_answer_text_to_options

cases = ['1,3', 'ABD', 'ab', 'b', '(A)、C', '0,2', '②', 'A.', '第3个', '1 3', 'A,C,D', '2']
for raw in cases:
    print(f'{raw!r:10} -> {parse_answer_ids(raw, "choice")}')

print('文字答案 ->', match_answer_text_to_options('绝缘防护用品', ['安全带', '劳保防护用品', '安全帽', '绝缘防护用品']))
print('文字多选 ->', match_answer_text_to_options('安全帽、绝缘防护用品', ['安全带', '安全帽', '绝缘防护用品']))
