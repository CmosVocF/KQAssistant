# -*- coding: utf-8 -*-
"""Auto-answer backend (hardened for network deployment).

Runs a small HTTP API that the Tampermonkey userscript queries.  Loads every
``*.xlsx`` question bank from ``exambank`` (recursively), indexes the stems,
and answers "which option(s) is/are correct" for a stem from the exam page.

Security model (see README「部署与安全」):
  * ALL /api/* routes require an API key when configured.
  * Deployment safety default: binding to a non-loopback address refuses to
    start unless an api_key is set in config.json.
  * /api/reload only accepts folders INSIDE the configured bank base dirs.
  * Swagger docs are off unless config["docs"]=true.
  * CORS only answers for an explicit allow-list (never plain '*').
  * Per-IP rate limits on /api/query and /api/reload.
  * DoS guardrails on workbook size / row count (bank_loader).
  * Responses never echo absolute server paths.

Run:  python server.py        (or:  uvicorn server:app --port 8765)
"""
import hmac
import ipaddress
import json
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
DEFAULT_FOLDER = HERE.parent / 'exambank'


def _load_config():
    cfg = {}
    cfg_path = HERE / 'config.json'
    try:
        if cfg_path.exists():
            # utf-8-sig 兼容带 BOM 的编辑器保存
            cfg = json.loads(cfg_path.read_text(encoding='utf-8-sig'))
    except Exception:
        cfg = {}
    return cfg


CFG = _load_config()


def host_allows_keyless(host: str) -> bool:
    """True if binding to this host may run without an api_key.
    回环地址与私网地址(含 ZeroTier/Tailscale 常用网段)视为可信：局域网/私网 VPN 本身就是隔离层。
    公网 IP / 0.0.0.0(监听所有网卡) / :: 返回 False，必须配 api_key。"""
    if host in ('localhost', '127.0.0.1', '::1'):
        return True
    if host in ('0.0.0.0', '::'):
        return False            # 监听所有网卡 => 包含公网出入口，绝不能免密钥
    try:
        ip = ipaddress.ip_address(host.split('%')[0])
        return not ip.is_global or ip.is_loopback
    except ValueError:
        return False


# ---- auth ------------------------------------------------------------------
API_KEY = str(CFG.get('api_key', '') or '').strip()
# require_key: true=强制(公网/私网都要)  false=强制关闭(危险，仅私网)  auto=默认
_require_cfg = CFG.get('require_key', 'auto')
_CFG_HOST = str(CFG.get('host', '127.0.0.1'))
if _require_cfg is True:
    REQUIRE_KEY = True
elif _require_cfg is False:
    REQUIRE_KEY = False
else:
    # auto：只有监听“非私网地址”(公网/0.0.0.0)时才启用密钥；私网/本机自动免密钥
    REQUIRE_KEY = bool(API_KEY) and not host_allows_keyless(_CFG_HOST)

# ---- allowed bank bases (server may only read banks under these) ------------
def _canon(p):
    return os.path.realpath(os.path.abspath(p))


def bank_bases():
    bases = [DEFAULT_FOLDER]
    env = os.environ.get('AUTOEXAM_BANK_FOLDER')
    if env and os.path.isdir(env):
        bases.insert(0, Path(env))
    bf = CFG.get('bank_folder')
    if bf and os.path.isdir(bf):
        bases.insert(0, Path(bf))
    for extra in CFG.get('extra_bank_dirs', []):
        if extra and os.path.isdir(extra):
            bases.append(Path(extra))
    return [_canon(b) for b in dict.fromkeys(bases)]


BANK_BASES = bank_bases()


def allowed_bank_folder(override=''):
    """Resolve the folder for /api/reload; refuse anything outside the bases."""
    if override:
        c = _canon(override)
        for base in BANK_BASES:
            if c == base or c.startswith(base + os.sep):
                return c
        raise HTTPException(status_code=403, detail='folder is outside the allowed bank directories')
    return BANK_BASES[0]


# ---- rate limiting (per IP, dependency-free) --------------------------------
_rate = {}
_rate_lock = threading.Lock()


def rate_limit(per_min):
    def dep(request: Request):
        ip = request.client.host if request.client else '?'
        now = time.time()
        with _rate_lock:
            arr = _rate.setdefault(ip, [])
            arr[:] = [t for t in arr if now - t < 60.0]
            if len(arr) >= per_min:
                raise HTTPException(status_code=429, detail='too many requests')
            arr.append(now)
            if len(_rate) > 10000:        # bound memory
                _rate.clear()
    return dep


# ---- runtime bank instance ---------------------------------------------------
from bank_loader import QuestionBank  # noqa: E402
from search import search_bank        # noqa: E402

_bank = QuestionBank(
    str(BANK_BASES[0]),
    max_file_mb=int(CFG.get('max_file_mb', 50) or 50),
    max_sheet_rows=int(CFG.get('max_sheet_rows', 100_000) or 100_000),
)
_reload_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    folder = allowed_bank_folder()
    try:
        _bank.load(folder)
        print(f'[startup] loaded {len(_bank.questions)} questions (api_key_required={REQUIRE_KEY})')
    except Exception as e:  # pragma: no cover
        print(f'[startup] failed to load banks: {e}')
    yield
    print('[shutdown] bye')


docs_on = bool(CFG.get('docs', False))
app = FastAPI(title='Autoexam backend', version='1.0.0', lifespan=lifespan,
              docs_url='/docs' if docs_on else None,
              redoc_url=None,
              openapi_url='/openapi.json' if docs_on else None)

# CORS: only for an explicit allow-list; empty list = no CORS headers at all.
allowed_origins = [o for o in CFG.get('allowed_origins', []) if isinstance(o, str) and o]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=['GET', 'POST'],
        allow_headers=['Content-Type', 'X-API-Key', 'Authorization'],
    )


@app.middleware('http')
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    resp.headers.setdefault('Cache-Control', 'no-store')
    return resp


def require_api_key(
    x_api_key: str = Header(default=''),
    authorization: str = Header(default=''),
):
    """Optional auth: enforced automatically once config['api_key'] is set."""
    if not REQUIRE_KEY:
        return
    got = x_api_key.strip()
    if not got and authorization.startswith('Bearer '):
        got = authorization[7:].strip()
    if not got or not hmac.compare_digest(got, API_KEY):
        raise HTTPException(status_code=401, detail='invalid or missing API key')


class QueryIn(BaseModel):
    stem: str
    type: str = Field(default='single', description='single | multi | judge | choice')
    options: list = Field(default_factory=list)   # page options (optional)
    bank: str = Field(default='', description='optional 《...》 name from the page header')


class ReloadIn(BaseModel):
    folder: str = ''


@app.get('/api/health', dependencies=[Depends(require_api_key)])
def health():
    return {
        'status': 'ok',
        'questions': len(_bank.questions),
        'files': len(_bank.files),
        'bank_dir': os.path.basename(os.path.normpath(_bank.folder)) or _bank.folder,
        'auth_required': REQUIRE_KEY,
    }


@app.get('/api/banks', dependencies=[Depends(require_api_key)])
def banks():
    """List question banks (grouped by bank title) with counts."""
    counts = {}
    for q in _bank.questions:
        key = q.bank_title or q.file
        counts.setdefault(key, 0)
        counts[key] += 1
    return {'banks': [{'name': k, 'count': v} for k, v in sorted(counts.items())]}


@app.post('/api/reload', response_model=dict, dependencies=[Depends(require_api_key), Depends(rate_limit(5))])
def reload_banks(body: ReloadIn):
    """Re-scan the bank folders (only inside the configured bank base dirs)."""
    folder = allowed_bank_folder(body.folder)
    with _reload_lock:
        t0 = time.time()
        try:
            n = _bank.load(folder)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f'reload failed: {e}')
    return {'ok': True, 'questions': n, 'elapsed_ms': round((time.time() - t0) * 1000, 2)}


@app.post('/api/query', dependencies=[Depends(require_api_key), Depends(rate_limit(60))])
def query(body: QueryIn):
    """Find the correct answer(s) for the given stem."""
    stem = (body.stem or '').strip()
    if not stem:
        raise HTTPException(status_code=400, detail='stem is required')

    qtype_map = {'single': 'choice', 'multi': 'choice', 'choice': 'choice',
                 'judge': 'judge', '判断题': 'judge', '单选题': 'choice', '多选题': 'choice'}
    qtype = qtype_map.get(body.type, 'choice')

    # take a stable reference: concurrent /api/reload swaps the list atomically
    bank = _bank
    best, conf, mtype, top = search_bank(bank, stem, qtype, bank_filter=body.bank or None,
                                         top_n=5, page_options=body.options or None)

    if best is None:
        return {
            'ok': True, 'found': False, 'match_type': mtype, 'confidence': round(conf, 3),
            'kind': qtype, 'bank': '', 'sheet': '', 'stem': stem,
            'judge_answer': None, 'answers': [],
            'candidates': [{'stem': t.stem, 'sheet': t.sheet, 'bank': t.bank_title} for t in top[:5]],
        }

    answers = best.answer_texts if best.kind == 'choice' else []
    judge_ans = best.judge_answer if best.kind == 'judge' else None

    return {
        'ok': True,
        'found': True,
        'match_type': mtype,
        'confidence': round(conf, 3),
        'kind': best.kind,
        'bank': best.bank_title,
        'file': best.file,
        'sheet': best.sheet,
        'stem': best.stem,
        'judge_answer': judge_ans,
        'answers': answers,
        'candidates': [{'stem': t.stem, 'sheet': t.sheet, 'bank': t.bank_title} for t in top[:5]],
    }


# console encoding nicety for Windows
if sys.platform == 'win32':
    try:
        os.system('chcp 65001 >nul')
    except Exception:
        pass


def _port_busy(host, port):
    import socket
    import errno
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        try:
            s.bind((host, port))
            return False
        except OSError as e:
            # 只有“地址被占用”才算占用；IP 未分配的其它错误交给 uvicorn 报真实原因
            if e.errno in (errno.EADDRINUSE, 10048):
                return True
            return False


def main():
    import uvicorn
    host = str(CFG.get('host', '127.0.0.1'))
    port = int(CFG.get('port', 8765))

    if REQUIRE_KEY and not API_KEY:
        print()
        print('  [配置错误] require_key 为 true，但 config.json 里没有设置 api_key。')
        print('  请在 config.json 填一个 api_key。')
        print()
        return

    keyless_ok = host_allows_keyless(host)
    print(f'[autoexam] bank folder : {os.path.normpath(BANK_BASES[0])}')
    print(f'[autoexam] bind        : {host}:{port}')
    print(f'[autoexam] api_key     : {"required" if REQUIRE_KEY else "off"}' +
          ('' if REQUIRE_KEY else (' (私网/本机可信，可不带密钥)' if keyless_ok else '')))

    # 安全默认值：公网/任意地址监听却没有鉴权 => 拒绝启动
    if not keyless_ok and not REQUIRE_KEY:
        print()
        print('  [安全] 你要监听的是公网/任意地址(非私网)，但没有配置 api_key，后端拒绝启动。')
        print('  两种做法任选其一：')
        print('   a) 走私网：把 host 设为 ZeroTier/Tailscale 或局域网私网 IP（如 10.x / 192.168.x / 172.16-31.x），')
        print('      这样在私网内可不带密钥，公网扫不到；')
        print('   b) 若一定想公网直连：在 config.json 里设置 api_key，并把油猴面板“密钥”填入相同值。')
        print()
        return
    if keyless_ok and not REQUIRE_KEY:
        print('  [提示] 当前为“私网可信、免密钥”模式；若该私网里还有其他用户，建议仍设置 api_key 更稳妥。')

    if _port_busy(host, port):
        print()
        print('  [提示] 端口 {} 已被占用，可能有另一个后端实例正在运行。'.format(port))
        print('  请先关闭旧窗口，或改 config.json 的 port。')
        print()
        return

    uvicorn.run(app, host=host, port=port, log_level='info', server_header=False)


if __name__ == '__main__':
    main()
