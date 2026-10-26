# -*- coding: utf-8 -*-
"""Tie matcher + bank together: answer a query from the page."""
from matcher import normalize, score_pair
from bank_loader import QuestionBank


def _matches_bank_filter(q, bank_filter):
    if not bank_filter:
        return True
    return (q.bank_title == bank_filter
            or bank_filter in q.bank_title
            or bank_filter in q.file
            or q.bank_title in bank_filter
            or q.file in bank_filter)


def _option_overlap(q, page_norm_set):
    """How much do the bank question's options overlap the page's options?
    Used to disambiguate when several bank questions share the same stem."""
    if not page_norm_set or not q.options:
        return 0.0
    bank_norm = {normalize(o) for o in q.options if normalize(o)}
    if not bank_norm:
        return 0.0
    inter = len(bank_norm & page_norm_set)
    return inter / max(len(bank_norm), len(page_norm_set))


def search_bank(bank: QuestionBank, stem: str, qtype: str, bank_filter=None,
                top_n=5, page_options=None):
    """Return (best_question, confidence, match_type, top_candidates).

    When several bank questions have the same (normalized) stem — e.g. generic
    stems like "以下说法正确的是（  ）。" — the *page options* are used to pick
    the right one via option overlap.
    """
    q_norm = normalize(stem)
    qs = bank.questions
    page_norm = {normalize(o) for o in (page_options or []) if normalize(o)}

    # 1) exact-normalized hits (within filtered scope)
    exact = [q for q in qs if q.norm == q_norm and _matches_bank_filter(q, bank_filter)]
    if exact:
        if len(exact) == 1:
            return exact[0], 1.0, 'exact', exact
        # duplicate stems -> pick the one whose options match the page best
        exact.sort(key=lambda q: _option_overlap(q, page_norm), reverse=True)
        return exact[0], 1.0, 'exact', exact

    # 2) scored search
    scored = []
    for q in qs:
        if not q.norm:
            continue
        if not _matches_bank_filter(q, bank_filter):
            continue
        if q.kind not in ('choice', 'judge'):
            continue
        if q.kind == 'judge' and qtype != 'judge':
            continue
        if q.kind == 'choice' and qtype not in ('single', 'multi', 'choice'):
            continue
        # cheap length pre-filter
        if abs(len(q.norm) - len(q_norm)) > max(40, int(len(q_norm) * 0.5)):
            continue
        sc = score_pair(q_norm, q.norm)
        if sc > 0.3:
            scored.append((q, sc))

    scored.sort(key=lambda x: -x[1])
    top = [q for q, _ in scored[:top_n]]
    if not scored:
        return None, 0.0, 'none', []
    best_q, best_sc = scored[0][0], scored[0][1]

    # 3) near-tie break by option overlap (page options provided)
    if page_norm and len(scored) >= 2:
        t = 0.14 if best_sc >= 1.0 else 0.20
        tied = [q for q, sc in scored if abs(sc - best_sc) <= t]
        if len(tied) >= 2:
            tied.sort(key=lambda q: _option_overlap(q, page_norm), reverse=True)
            best_q = tied[0]

    if best_sc >= 1.7:
        mtype = 'exact'
        conf = 1.0
    elif best_sc >= 1.35:
        mtype, conf = 'strong', min(1.0, best_sc / 1.5)
    elif best_sc >= 1.05:
        mtype, conf = 'medium', min(0.95, best_sc / 1.3)
    elif best_sc >= 0.75:
        mtype, conf = 'weak', min(0.8, best_sc / 1.1)
    else:
        mtype, conf = 'none', best_sc / 1.0
    return best_q, conf, mtype, top
