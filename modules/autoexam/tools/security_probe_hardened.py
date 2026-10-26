# -*- coding: utf-8 -*-
"""Re-probe the HARDENED backend: every vulnerability from the first audit should
now be blocked. Local only, 127.0.0.1:8766, uses the API key."""
import json
import os
import shutil
import time
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:8766'
KEY = 'test-secret-123-xyz'
VICTIM = r'D:\Autoexam\tools\_deploytest\victim_docs'
BIG = r'D:\Autoexam\tools\_deploytest\dos_big.xlsx'
KEYHDR = {'X-API-Key': KEY}


def req(method, path, payload=None, headers=None, timeout=30):
    body = json.dumps(payload).encode('utf-8') if payload is not None else None
    h = {'Content-Type': 'application/json; charset=utf-8'} if body else {}
    if headers:
        h.update(headers)
    r = urllib.request.Request(BASE + path, data=body, headers=h, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.headers, resp.read(), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read(), time.time() - t0
    except Exception as e:
        return None, None, str(e).encode(), time.time() - t0


ok_cnt = bad_cnt = 0
def check(name, cond, extra=''):
    global ok_cnt, bad_cnt
    if cond:
        ok_cnt += 1
        print(f'  ✅ {name}' + (f'  {extra}' if extra else ''))
    else:
        bad_cnt += 1
        print(f'  ❌ {name}' + (f'  {extra}' if extra else ''))


print('=' * 78)
print('加固复测 A —— 鉴权')
print('=' * 78)
for path, method, payload in [('/api/health', 'GET', None),
                              ('/api/banks', 'GET', None),
                              ('/api/query', 'POST', {'stem': 'x'}),
                              ('/api/reload', 'POST', {})]:
    st, _, _, _ = req(method, path, payload)
    check(f'无密钥 {method} {path} 被拒(401)', st == 401, f'status={st}')
st, _, _, _ = req('GET', '/api/health', headers={'X-API-Key': 'wrong-key'})
check('错误密钥被拒(401)', st == 401, f'status={st}')
st, _, data, _ = req('GET', '/api/health', headers=KEYHDR)
check('正确密钥 health 200', st == 200, f'status={st}')
j = json.loads(data)
check('health 不再泄露绝对路径(只给目录名)', '\\' not in j.get('bank_dir', 'X') and 'Drives' not in j.get('bank_dir', ''), f'bank_dir={j.get("bank_dir")!r}')

print('=' * 78)
print('加固复测 B —— 任意目录读取 / 路径穿越')
print('=' * 78)
st, _, data, _ = req('POST', '/api/reload', {'folder': VICTIM}, headers=KEYHDR)
check('超范围目录 reload 被拒(403)', st == 403, f'status={st} {data[:60]!r}')
st, _, data, _ = req('POST', '/api/reload', {'folder': VICTIM + r'\..\victim_docs'}, headers=KEYHDR)
check('路径穿越 ../ 被拒(403)', st == 403, f'status={st}')
st, _, data, _ = req('GET', '/api/banks', headers=KEYHDR)
j = json.loads(data) if data else {}
check('受害目录内容未被读出(无“公司机密”标题)', all('机密' not in (b.get('name') or '') for b in j.get('banks', [])), f'banks={[b["name"] for b in j.get("banks", [])][:3]}')

print('=' * 78)
print('加固复测 C —— 文档与 CORS')
print('=' * 78)
st, _, _, _ = req('GET', '/docs')
check('/docs 关闭(404)', st == 404, f'status={st}')
st, _, _, _ = req('GET', '/openapi.json')
check('/openapi.json 关闭(404)', st == 404, f'status={st}')
st, hd, _, _ = req('GET', '/api/health', headers={**KEYHDR, 'Origin': 'https://evil.example.com'})
aca = hd.get('Access-Control-Allow-Origin')
check('跨域读写被阻止(CORS 无通配)', not aca or aca != '*', f'ACAO={aca!r}')

print('=' * 78)
print('加固复测 D —— 限流 / DoS')
print('=' * 78)
got429 = False
for i in range(70):
    st, _, _, _ = req('POST', '/api/query', {'type': 'single', 'stem': f'限流测试{i} (   )。'}, headers=KEYHDR, timeout=10)
    if st == 429:
        got429 = True
        break
check('query 触发限流(429)', got429, f'status最后={st}')

# 大文件(5.4MB>max 5MB)放入允许目录内，reload 应被快速跳过
os.makedirs(os.path.join(r'D:\Autoexam\exambank', '_DoS'), exist_ok=True)
shutil.copy(BIG, os.path.join(r'D:\Autoexam\exambank', '_DoS', 'big.xlsx'))
st, _, data, dt = req('POST', '/api/reload', {'folder': r'D:\Autoexam\exambank\_DoS'}, headers=KEYHDR, timeout=30)
j = json.loads(data) if data else {}
check('超大文件被跳过(不加载12万题)', st == 200 and j.get('questions', 999999) == 0, f'status={st} q={j.get("questions")} 用时{dt:.2f}s')
shutil.rmtree(os.path.join(r'D:\Autoexam\exambank', '_DoS'), ignore_errors=True)

print('=' * 78)
print('加固复测 E —— 恢复正常后查询可用')
print('=' * 78)
st, _, data, _ = req('POST', '/api/reload', {}, headers=KEYHDR)
j = json.loads(data) if data else {}
check('reload 恢复到 exambank 成功', st == 200 and j.get('questions', 0) > 1000, f'q={j.get("questions")}')
st, _, data, _ = req('POST', '/api/query',
                     {'type': 'single', 'stem': '《国务院办公厅关于保障城市轨道交通安全运行的意见》的文件号(   )。',
                      'options': ['国办发〔2018〕13号', '国办发〔2018〕12号', '国办发〔2018〕14号', '国办发〔2018〕15号']},
                     headers=KEYHDR)
j = json.loads(data)
check('带密钥正常查询仍可用', st == 200 and j.get('found') and j['answers'] == ['国办发〔2018〕13号'], f"answers={j.get('answers')}")

print()
print(f'RESULT: {ok_cnt} 项防护通过 / {bad_cnt} 项失败')
