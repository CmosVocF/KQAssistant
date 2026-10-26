# -*- coding: utf-8 -*-
"""Stem normalization + fuzzy matching for the auto-answer backend.

Design notes (per requirements):
  * Options may be shuffled on the exam page -> answers are returned as TEXT,
    never as "click the Nth option".
  * Stems may differ in symbol escaping: full/half width brackets, whitespace
    inside the blank (e.g. `(   )` vs `（）`).  We normalize those away.
  * Many stems share the same prefix, so a plain ratio over the whole string is
    not enough: we also compare the text *after* the blank and the blank
    position, so a correct question with a common prefix still wins.
"""
from difflib import SequenceMatcher
import re

# ---- normalization ----------------------------------------------------------

_FW_TO_HALF = {
    '，': ',', '。': '.', '（': '(', '）': ')', '；': ';', '：': ':',
    '、': ',', '！': '!', '？': '?', '“': '"', '”': '"', '‘': "'", '’': "'",
    '／': '/', '％': '%', '＃': '#', '＆': '&', '＊': '*', '＋': '+',
    '－': '-', '＝': '=', '＠': '@',
}
_FW_RE = re.compile('[' + ''.join(_FW_TO_HALF.keys()) + ']')

# content that can sit inside a blank placeholder (spaces, underscore, dots ...)
_BLANK_INSIDE = re.compile(r'[\(\[]([\s＿_\.\.\u00A0\u3000]*)[\)\]]')


def normalize(text) -> str:
    """Return a comparison key: no whitespace, () stands for any blank slot,
    bracket chars normalized, full-width punctuation -> half width."""
    if not text:
        return ''
    s = str(text)
    s = s.replace('\u3000', ' ').replace('\u00A0', ' ')   # ideographic/nbsp space
    s = re.sub(r'\s+', '', s)                             # remove ALL whitespace
    s = _FW_RE.sub(lambda m: _FW_TO_HALF[m.group(0)], s)  # full -> half width
    # collapse blank placeholders: ( )  (   )  （） etc. -> ()
    s = _BLANK_INSIDE.sub('()', s)
    return s


def split_blank(norm: str):
    """Position of the first blank '()' and the suffix after it."""
    i = norm.find('()')
    if i == -1:
        return -1, norm
    return i, norm[i + 2:]


def ratio(a, b):
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def score_pair(q_norm: str, c_norm: str) -> float:
    """Score 0..~1 how well a candidate bank stem matches the query stem."""
    if q_norm == c_norm:
        return 2.0                       # perfect (above any fuzzy score)
    r = ratio(q_norm, c_norm)
    qi, qs = split_blank(q_norm)
    ci, cs = split_blank(c_norm)
    suf = ratio(qs, cs) if (qs or cs) else 1.0
    pos_penalty = 0.0
    if qi != -1 and ci != -1:
        pos_penalty = min(abs(qi - ci), 30) / 30.0
    # whole-string ratio + suffix agreement, minus position mismatch
    return 0.65 * r + 0.35 * suf - 0.25 * pos_penalty
