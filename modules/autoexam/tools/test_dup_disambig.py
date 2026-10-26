# -*- coding: utf-8 -*-
"""Verify option-overlap disambiguation fixes the duplicate-stem questions
(Q38/Q45 from file 《城市轨道交通服务质量评价规范》)."""
import os, json, urllib.request

BASE = os.environ.get('AE_BASE', 'http://127.0.0.1:8765')

def norm(t):
    if not t: return ''
    import re
    m = {'，': ',', '。': '.', '（': '(', '）': ')', '；': ';', '：': ':', '、': ',',
         '！': '!', '？': '?', '“': '"', '”': '"', '‘': "'", '’': "'", '／': '/',
         '％': '%', '＃': '#', '＆': '&', '＊': '*', '＋': '+', '－': '-', '＝': '=', '＠': '@'}
    s = t.replace('\u3000', ' ').replace('\u00A0', ' ')
    s = re.sub(r'\s+', '', s)
    for k, v in m.items(): s = s.replace(k, v)
    return re.sub(r'[\(\[]([ ＿_..\u3000]*)[\)\]]', '()', s)

def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))

indicator_opts = [
    '列车运行图兑现率：统计期内，实际开行列车次数与列车运行图规定的计划开行列车次数之比',
    '列车正点率：统计期内，正点列车次数与实际开行列车次数之比',
    '列车退出正线运营故障率：统计期内，列车因发生车辆故障而必须退出正线运营的故障次数与全部列车总行车里程比值，单位为次/万列公里',
    '客运强度：统计期内，运营线路中单位运营里程上平均每日承担的客运量，为线路日均客运量与线路运营里程的比值，单位为万人次/公里·日',
]
j45_opts = [
    '连续中断行车（指线路中有2个及以上车站或区间发生行车中断）30分钟以上（含）2小时以下的，每起减30分',
    '连续中断行车（指线路中有2个及以上车站或区间发生行车中断）30分钟以上（含）2小时以下的，每起减20分',
    '发生一般运营突发事件的，每起减50分',
    '发生一般运营突发事件的，每起减20分',
]

cases = [
    ('Q38', 'multi', '以下说法正确的是？', indicator_opts, '列车运行图兑现率：统计期内，实际开行列车次数与列车运行图规定的计划开行列车次数之比'),
    ('Q45', 'multi', '线路服务质量评价中，出现以下情形的（因地震、洪涝、气象灾害等自然灾害及其他不可抗力因素导致的除外），应进行核减扣分,以下正确的是（ ）。', j45_opts, '发生一般运营突发事件的，每起减50分'),
]
for name, typ, stem, opts, must_include in cases:
    res = post('/api/query', {'type': typ, 'stem': stem, 'options': opts,
                              'bank': '《城市轨道交通服务质量评价规范》'})
    g = lambda t: norm(t) in {norm(o) for o in opts}
    ok = res.get('found') and any(must_include in a for a in res.get('answers', [])) and all(g(a) for a in res.get('answers', []))
    print(f'{name}: found={res.get("found")} 匹配={res.get("match_type")} conf={res.get("confidence")}')
    print(f'   返回答案: {res.get("answers")}')
    print(f'   判定: {"✅ 通过" if ok else "❌ 失败"}')
