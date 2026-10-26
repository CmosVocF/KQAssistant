# -*- coding: utf-8 -*-
"""Load xlsx question banks into memory + helpers to answer queries.

The format of the provided banks (and most future ones) is:

  sheet 选择题  columns: 0 文件夹编号 | 1 资源编号 | 2 标题 | 3 题目 | 4 可否更改答案顺序
                        | 5 答案 | 6..15 选项 1..10 | 16 分数 | 17 难度 | 18 状态 | 19 解析
  sheet 判断题  columns: 0 文件夹编号 | 1 资源编号 | 2 标题 | 3 题目 | 4 答案
                        | 5 分数 | 6 难度 | 7 状态 | 8 解析
  sheet 填空题  columns: 0..3 same, 4.. blank answer columns
  sheet 问答题  columns: ... 答案
  sheet 多选题  (not present now but may appear later) same shape as 选择题.

Column positions are detected heuristically from the header row so banks with a
slightly different layout still load: we look for the column whose header
contains 题目 / 题, 答案 / 答, and a run of 选项 N columns.
"""
import os
import re
from collections import defaultdict

import openpyxl

from matcher import normalize

# stop scanning a sheet after this many consecutive empty rows (real banks are dense;
# some legacy files advertise 1M rows but only the top rows have data)
_EMPTY_ROW_STOP = 25


class SheetSpec:
    def __init__(self, name, kind, title_col, stem_col, ans_col, opt_start, opt_end):
        self.name = name
        self.kind = kind          # 'choice' | 'judge' | 'fill' | 'essay' | 'unknown'
        self.title_col = title_col
        self.stem_col = stem_col
        self.ans_col = ans_col
        self.opt_range = (opt_start, opt_end)   # [start, end) column indices, None if n/a


def classify_sheet(name):
    n = name
    if any(k in n for k in ('选择', '多选', '单选')):
        return 'choice'
    if '判断' in n:
        return 'judge'
    if '填空' in n:
        return 'fill'
    if '问答' in n:
        return 'essay'
    if '案例' in n or '简答' in n:
        return 'essay'
    return 'unknown'


def classify_by_header(kind, opt_start, ans_col, header):
    """工作表名认不出题型时(如默认名 Sheet/Sheet1/工作表1)，按表头结构判断。
    有“选项 N”列 -> 选择题；只有“答案”列 -> 判断题。"""
    if kind != 'unknown':
        return kind
    if opt_start != -1:
        return 'choice'
    if any(h is not None and '空白' in str(h) for h in header):
        return 'fill'
    if ans_col != -1:
        return 'judge'
    return 'unknown'


def detect_spec(ws_name, header):
    """Detect column positions from a header row. Returns SheetSpec or None."""
    kind = classify_sheet(ws_name)
    title_col = stem_col = ans_col = -1
    opt_start = opt_end = -1
    for i, h in enumerate(header):
        if h is None:
            continue
        h = str(h).strip()
        if stem_col == -1 and ('题目' in h or h == '题'):
            stem_col = i
        elif title_col == -1 and '标题' in h:
            title_col = i
        elif ans_col == -1 and (h.startswith('答案') or h == '答'):
            ans_col = i
        elif opt_start == -1 and re.match(r'^选项\s*\d+$|^选项\d+$', h):
            opt_start = i
    # option run: consecutive 选项 columns
    if opt_start != -1:
        opt_end = opt_start
        while opt_end < len(header) and header[opt_end] is not None and re.match(r'^选项\s*\d+$|^选项\d+$', str(header[opt_end]).strip()):
            opt_end += 1
    if stem_col == -1:
        return None
    # fail-safe default for standard layouts
    if ans_col == -1:
        ans_col = stem_col + 2
    kind = classify_by_header(kind, opt_start, ans_col, header)
    return SheetSpec(ws_name, kind, title_col, stem_col, ans_col, opt_start, opt_end)


def parse_answer_ids(raw, kind):
    """Answer cell -> list of 1-based option indices (choice) or truthy (judge).

    选择题答案支持多种写法（兼容不同题库）：
      * 数字序号：'2' / '1,3' / '1、3' / '1 3'
      * 字母序号：'A' / 'ABD' / 'A,C' / 'b'
      * 0 基序号：'0' / '0,2'（整体 +1 视为 1 基）
    """
    if raw is None:
        return []
    if kind == 'judge':
        s = str(raw).strip().lower()
        if s in ('true', 't', '对', '正确', 'yes', 'y', '1', '√'):
            return [True]
        if s in ('false', 'f', '错', '错误', 'no', 'n', '0', '×'):
            return [False]
        return []
    # choice / multi
    text = str(raw).strip()
    ids = []
    for part in re.split(r'[,，;；、\s]+', text):
        if not part:
            continue
        # 纯数字
        if re.fullmatch(r'\d+', part):
            ids.append(int(part))
            continue
        # 字母（A-H / a-h）或 ①②③
        if re.fullmatch(r'[A-Ha-h]', part):
            ids.append(ord(part.upper()) - ord('A') + 1)
            continue
        # 连续字母（多选常见写法）：ABD / ac
        if re.fullmatch(r'[A-Ha-h]{2,}', part):
            ids.extend(ord(ch.upper()) - ord('A') + 1 for ch in part)
            continue
        m = re.fullmatch(r'[①-⑩]', part)
        if m:
            ids.append('①②③④⑤⑥⑦⑧⑨⑩'.index(part) + 1)
            continue
        # 'A.' / '(B)' / '第3个'
        m = re.fullmatch(r'[（(\[]?([A-Ha-h])[）)\].、]?', part) or re.fullmatch(r'第?(\d+)[个题]?', part)
        if m:
            g = m.group(1)
            ids.append(ord(g.upper()) - ord('A') + 1 if g.isalpha() else int(g))
            continue
    # 0 基序号 -> 1 基
    if ids and min(ids) == 0:
        ids = [i + 1 for i in ids]
    return ids


def match_answer_text_to_options(raw, options):
    """答案列直接写的是选项文字时的兜底：把答案文字匹配回选项下标（1 基）。"""
    from matcher import normalize
    if raw is None or not options:
        return []
    parts = [p for p in re.split(r'[,，;；、\s]+', str(raw).strip()) if p]
    norm_opts = [normalize(o) for o in options]
    ids = []
    for p in parts:
        np = normalize(p)
        if not np:
            continue
        for i, no in enumerate(norm_opts):
            if no and no == np:
                ids.append(i + 1)
                break
    return ids


def cell_is_empty(v):
    return v is None or (isinstance(v, str) and v.strip() == '')


class Question:
    __slots__ = ('bank_title', 'file', 'sheet', 'kind', 'stem', 'norm',
                 'answer_ids', 'options', 'answer_texts', 'judge_answer')

    def __init__(self):
        self.bank_title = ''
        self.file = ''
        self.sheet = ''
        self.kind = ''
        self.stem = ''
        self.norm = ''
        self.answer_ids = []
        self.options = []
        self.answer_texts = []
        self.judge_answer = None

    def to_dict(self, include_ans=True):
        d = {
            'bank': self.bank_title,
            'file': os.path.basename(self.file),
            'sheet': self.sheet,
            'kind': self.kind,
            'stem': self.stem,
        }
        if include_ans:
            d['answer_ids'] = self.answer_ids
            d['options'] = self.options
            d['answers'] = self.answer_texts
            if self.kind == 'judge':
                d['judge_answer'] = self.judge_answer
        return d


class QuestionBank:
    def __init__(self, folder, max_file_mb=50, max_sheet_rows=100_000):
        self.folder = folder
        self.questions = []          # list[Question]
        self._by_norm = defaultdict(list)   # norm -> question indices
        self.files = []
        # DoS guards: skip oversized workbooks / sheets that explode into millions of rows
        self.max_file_bytes = int(max_file_mb) * 1024 * 1024
        self.max_sheet_rows = int(max_sheet_rows)

    def load(self, folder=None):
        if folder:
            self.folder = folder
        new_questions = []
        # 递归扫描所有子目录里的 xlsx，方便按“exambank/随便放/新题库.xlsx”归档
        self.files = []
        for root, _dirs, fnames in os.walk(self.folder):
            for fname in sorted(fnames):
                if fname.lower().endswith('.xlsx'):
                    self.files.append(os.path.join(root, fname))
        self.files.sort()
        for path in self.files:
            try:
                if os.path.getsize(path) > self.max_file_bytes:
                    print(f'[warn] 跳过超大文件(>{self.max_file_bytes // (1024*1024)}MB): {os.path.basename(path)}')
                    continue
            except OSError:
                continue
            self._load_file(path, new_questions)
        # 原子替换：查询方持有的旧列表引用不受影响，并发安全
        self.questions = new_questions
        self._by_norm = defaultdict(list)
        for i, q in enumerate(new_questions):
            if q.norm:
                self._by_norm[q.norm].append(i)
        return len(new_questions)

    def _load_file(self, path, sink):
        try:
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        except Exception as e:          # pragma: no cover
            print(f'[warn] cannot open {os.path.basename(path)}: {e}')
            return
        filetitle = os.path.basename(path)
        try:
            for ws in wb.worksheets:
                rows = ws.iter_rows(values_only=True)
                header = next(rows, None)
                if not header:
                    continue
                spec = detect_spec(ws.title, header)
                if spec is None:
                    continue
                empty_run = 0
                row_count = 0
                aborted = False
                for row in rows:
                    if all(cell_is_empty(v) for v in row):
                        empty_run += 1
                        if empty_run >= _EMPTY_ROW_STOP:
                            break            # trailing blanks -> bail out
                        continue
                    empty_run = 0
                    row_count += 1
                    if row_count > self.max_sheet_rows:
                        print(f'[warn] 跳过超大表(>{self.max_sheet_rows}行): {os.path.basename(path)}/{ws.title}')
                        aborted = True
                        break
                    q = self._row_to_question(filetitle, ws.title, spec, row)
                    if q is not None:
                        sink.append(q)
        finally:
            wb.close()

    def _row_to_question(self, filetitle, sheet_name, spec, row):
        q = Question()
        q.file = filetitle
        q.sheet = sheet_name
        q.kind = spec.kind
        stem = row[spec.stem_col] if spec.stem_col < len(row) else None
        if cell_is_empty(stem):
            return None
        q.stem = str(stem).strip()
        q.norm = normalize(q.stem)
        if spec.title_col is not None and spec.title_col < len(row) and not cell_is_empty(row[spec.title_col]):
            q.bank_title = str(row[spec.title_col]).strip()
        elif not q.bank_title:
            q.bank_title = filetitle
        if spec.kind == 'choice':
            for i in range(*spec.opt_range):
                if i < len(row) and not cell_is_empty(row[i]):
                    q.options.append(str(row[i]).strip())
            raw_ans = row[spec.ans_col] if spec.ans_col < len(row) else None
            q.answer_ids = parse_answer_ids(raw_ans, 'choice')
            if not q.answer_ids:
                # 兜底：答案列直接写的是选项文字
                q.answer_ids = match_answer_text_to_options(raw_ans, q.options)
            q.answer_texts = [q.options[i - 1] for i in q.answer_ids if 1 <= i <= len(q.options)]
        elif spec.kind == 'judge':
            raw_ans = row[spec.ans_col] if spec.ans_col < len(row) else None
            ids = parse_answer_ids(raw_ans, 'judge')
            if ids:
                q.judge_answer = ids[0]
        # fill / essay are loaded but have no usable auto answer (skipped later)
        return q

    def candidates(self, query_norm, bank_filter=None, limit=200):
        """Return likely candidate Questions for a normalized query."""
        qs = self.questions
        if bank_filter:
            filt = bank_filter
            qs = [q for q in qs if q.bank_title == filt or filt in q.bank_title or filt in q.file]
        # exact bucket first (fast)
        exact = self._by_norm.get(query_norm) or []
        hits = [self.questions[i] for i in exact]
        if bank_filter:
            hits = [q for q in hits if q.bank_title == bank_filter or bank_filter in q.bank_title or bank_filter in q.file]
        hits = list(dict.fromkeys(hits))
        return qs, hits

    def index_exact(self):
        self._by_norm = defaultdict(list)
        for i, q in enumerate(self.questions):
            if q.norm:
                self._by_norm[q.norm].append(i)
