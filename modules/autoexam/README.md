> **项目整合说明**：本模块已并入 KQAssistant 仓库，位于 `modules/autoexam/`。
> 目录调整：`wethink-mobile.html` 与 `wethink-mobile_files/` → `page-archive/`，
> 其余目录（`backend/`、`exambank/`、`userscript/`、`tools/`）保持原名。
> `backend/config.json` 的 `bank_folder` 已置空，默认使用 `backend/../exambank`
> （即本模块下的 `exambank/`）；部署到服务器时仍可改为 `/opt/autoexam/exambank`。

# 自动答题助手（Autoanswer）

针对「wethink 移动端考试页面」的自动答题工具：油猴脚本负责读取当前题目并点击，
本地 Python 后端负责从 Excel 题库中检索正确答案。题库在本地、不走网络，方便随时更换。

```
wethink-mobile.html            考试页面存档(仅用于分析页面结构，运行时不依赖它)
wethink-mobile_files\          页面存档资源
exambank\                      统一题库目录(递归扫描其中所有 *.xlsx)
    └─ 交通运输部政策法规练习题库20260605\
         └─ 1.《…》题库.xlsx … 14 个题库文件
    └─ (以后新题库) 随便建子文件夹放 xxx.xlsx 即可
backend\
    server.py                   后端 API (FastAPI)
    bank_loader.py              Excel 加载 + 列位置自动识别 + 递归扫描(换题库一般不用改)
    matcher.py                  题干规范化 + 模糊匹配
    search.py                   检索编排
    config.json                 后端地址 / 题库目录配置(bank_folder = exambank)
    requirements.txt            依赖
userscript\
    autoexam.user.js            油猴脚本
start_server.bat                一键启动后端
```

---

## 工作原理

1. **油猴脚本**：在考试页找到当前可见的题目（题型、题干、选项）；
2. 把题干 + 选项 + 页面标题里的《…》题库名 POST 到本地后端 `/api/query`；
3. **后端**：规范化题干（去掉所有空白、全角/半角括号统一、把“（   ）”这类空位折叠成 `()`），
   在 Excel 题库里检索，返回正确选项的**文字**（而不是第几项，因为选项会被打乱）；判断题返回 `true/false`；
4. **油猴脚本**：按文字匹配页面上的选项 → 模拟点击（单选点 1 个、多选点全部、判断题点 对/错）；
5. 点「下一题」，直到点不动时**自动停止**。

**匹配的健壮性**（对应你提到的各种坑）：
- 选项乱序 → 后端返回的是**文字**，前端按文字匹配，与选项顺序无关；
- 题干里的 `（   ）` / `(   )` / `（）` 空格、全角全角括号不一致 → 规范化后统一成 `()` 再匹配；
- 题干前半很多题一样（比如都来自同一文件同一原则）→ 匹配不只比“整句相似度”，
  还会比 **空位后方的内容** 和 **空位位置**，避免撞前缀导致匹配错题。
- 空位或题干可能因为转义少/多几个字 → 有模糊匹配兜底，返回置信度，前端照常点击。
- **同一题干在题库里有多条（选项不同）**，比如「以下说法正确的是（  ）。」→ 
  用**页面选项和题库选项的重合度**来挑正确的那个（重合最多者优先，理想 4/4）。

实测：本机这套页面 55 题（30 单选 + 15 多选 + 10 判断）全部命中，命中率 55/55。

---

## 快速开始

### 1. 安装依赖（只需一次）
```bash
python -m pip install -r backend\requirements.txt
```

### 2. 启动后端
双击 `start_server.bat`，或：
```bash
cd backend
python server.py
```
看到 `API -> http://127.0.0.1:8765` 即成功。
可用浏览器访问 `http://127.0.0.1:8765/api/health` 自检（返回 ok 和题目数量）。

### 3. 安装油猴脚本
- 浏览器安装 Tampermonkey（油猴）；
- 新建脚本，把 `userscript\autoexam.user.js` 的内容整体粘贴进去并保存；
- 打开考试页面（`https://hrt-mobile.hncsmtr.com:8085/mobile/exam/...`），
  右上角会出现「自动答题助手」面板；
- **默认会自动开始**（在面板“自动开始”处可勾选/取消）。
  开始后，面板会实时显示进度。到最后一题点不动时自动停止；
- **■ 停止** 随时手动中断；**单题测试** 只答当前题不跳题。
- 面板可拖动、点击 `—` 缩成右上角一个小浮窗（🎯），再点小浮窗展开。

> 后端默认 `http://127.0.0.1:8765`。如果要在另一台机器的浏览器上跑，
> 把 `autoexam.user.js` 里面板的“后端”输入框改成 `http://ip:8765`，
> 并给脚本增加一行 `// @connect  ip`。

### 4. 面板自检（排查“脚本不起效”）
面板上直接能看到：
- **后端已连接 · xxxx 题** / **后端未连接…** —— 连不上说明 `start_server.bat` 没启动或端口冲突；
- **当前题：第 N 题 [单选题] 题干「…」选项 x 个** —— 这里能立刻判断页面解析是否正常。

如果自检显示“后端未连接”，先启动后端；如果显示“未解析到当前题”，说明考试页 DOM 还没加载完或结构变了，刷新一下页面。

---

## 换题库（很重要的一节）

后端启动（或点「重载题库」）时会**递归扫描** `config.json` 里的 `bank_folder`（默认
`D:\Autoexam\exambank`）下**所有子目录**里的 `*.xlsx`。所以题库可以随意归档：

```
D:\Autoexam\exambank\
  ├─ 交通运输部政策法规练习题库20260605\1.《…》题库.xlsx   ← 现有题库
  ├─ 2026新题库\xx.xlsx                                    ← 以后新增，随便建文件夹
  └─ 更深的层级\再放一层.xlsx                              ← 任意层级都行
```

换题库只需要：

1. 把新的 xlsx 放到 `exambank\` 下任意子目录（或改 `config.json` 的 `bank_folder` 指向新目录）；
2. **无需重启**：在油猴面板点 **「重载题库」** 按钮（等价于
   `POST http://127.0.0.1:8765/api/reload`），几秒内完成；
   或直接重启后端（关旧窗口 → 双击 `start_server.bat`）。

> 多个题库可以同时放在目录里，互不影响：答题时后端会用考试页标题里的《…》自动锁定到对应题库。

想永久换目录：改 `backend\config.json` 的 `bank_folder`，
或设置环境变量 `AUTOEXAM_BANK_FOLDER`，或重启时 `POST /api/reload {"folder":"D:\\xxx"}`。

### 题库格式自适应
后端**不需要**为每个题库写死格式：加载时自动识别每一列的位置。

已支持的子表（按表名关键词识别）：
- `选择题` / `单选题`（答案列 = 第几项，可能 `2` 或 `2,3,4` 多选）
- `判断`（答案列 = True/False）
- `填空`、`问答题`（自动跳过，不做自动作答）

标准表头（当前这套题库的样式）：
```
选择题: 文件夹编号 | 资源编号 | 标题 | 题目 | 可否更改答案顺序 | 答案 | 选项 1 | 选项 2 | … | 解析
判断题: 文件夹编号 | 资源编号 | 标题 | 题目 | 答案 | 分数 | 难度 | 状态 | 解析
```
识别规则是按表头文字找：含「题目/题」的列 = 题干、含「答案」的列 = 答案、
连续「选项 N」列 = 选项。所以只要新题库表头差不多（这很常见），换进去就能用；
若个别列名怪一些，也只需调整 `backend\bank_loader.py` 里 `detect_spec()` 的匹配关键词。

---

## 部署与安全（局域网 / 云服务器）

### ⭐ 装好即用（零配置）
**你不用手动配密钥、也不用在每台设备装工具**：
- 后端 `config.json` 与油猴脚本里**内置同一把默认密钥**；
- 规则全自动：监听**私网/本机**地址 → 后端自动免密钥；监听**公网/0.0.0.0** → 才启用密钥，且**脚本自动带上内置密钥**，你始终不用填；
- 密钥永久有效，只有你主动换服务器密钥时才需要去面板填一次。

几个场景只需改一个 `host` 即可，其它都不动：

| 场景 | 做一件事 |
|---|---|
| 只在本机（默认） | 什么都不用做 |
| 手机同一 Wi‑Fi | 后端 `host` 改局域网 IP（如 `192.168.31.16`）；面板「后端」填 `http://该IP:8765`，脚本加一行 `// @connect 该IP` |
| 云服务器 | 后端 `host` 改 `0.0.0.0`（内置默认密钥自动生效）；面板填 `http://服务器IP:8765`，脚本加 `// @connect 服务器IP` |
| 云服务器走 ZeroTier 私网 | 后端 `host` 改 ZeroTier IP，两边都不用填密钥，公网也扫不到 |

### 监听端口
改 `backend\config.json` 的 `host` / `port`：
```json
{ "host": "127.0.0.1", "port": 8765, "api_key": "oJF9_...(内置默认)", "require_key": "auto" }
```
- 只在本机用：`host` 保持 `127.0.0.1`（默认）。
- 局域网 / 私网 VPN：`host=私网 IP`（如 `192.168.x.x`、`10.x.x.x`）。
- 公网直连：`host=0.0.0.0`（脚本会自动带上内置密钥）；不建议把不配密钥的版本开在公网，后端会拒绝启动。

### 已内置的安全防护（审查后修复）
| 防护 | 说明 |
|---|---|
| **API 密钥鉴权** | 需要时所有 `/api/*` 都要求 `X-API-Key` 或 `Authorization: Bearer`，否则 401；恒定时间比较防时序侧信道 |
| **安全默认值** | 公网/`0.0.0.0` 监听却没配 `api_key` → **拒绝启动**；私网/本机 IP 允许免密钥运行（私网本身即隔离层） |
| **reload 目录白名单** | `/api/reload` 只能指向 `bank_folder`（及 `extra_bank_dirs`）内的路径，路径穿越 `../` 一律 403 |
| **关闭文档** | `/docs`、`/openapi.json` 默认 404（需要时 config `"docs": true`） |
| **收紧 CORS** | 只有在 `allowed_origins` 白名单里才回 CORS 头，绝不返回 `*` |
| **限流** | `/api/query` 60 次/分钟/IP、`/api/reload` 5 次/分钟/IP，超限 429 |
| **DoS 防护** | 单个 xlsx 超过 `max_file_mb` 或单表超过 `max_sheet_rows` 直接跳过 |
| **响应脱敏** | 响应体不再返回服务器绝对路径（health 只回目录名） |
| **安全响应头** | nosniff / X-Frame-Options / CSP / no-store |

### 密钥不需要“定期更换”
`api_key` 是**永久有效**的，只有泄露才需要换。本机/局域网/私有网络后端会自动免密钥；公网后端会用**内置默认密钥**自动鉴权——**正常使用下你全程不用碰密钥**。

### 换服务器密钥（极少需要）
如果你想换掉内置默认密钥：把 `config.json` 的 `api_key` 改成新随机串，并在油猴面板「密钥」填同一串，改一次即可，永久有效。

### ⭐ ZeroTier / 私网免密钥部署（最无感，推荐）
你的云服务器已装 ZeroTier，那就把后端**只绑到 ZeroTier 私网 IP**，公网根本扫不到，官方天然隔离，可以免密钥：

1. 云服务器 `zerotier-cli listnetworks` 拿到 ZT IP（形如 `10.x`、`100.x`、`172.x`、`192.168.x`）；
2. `config.json` 设 `"host": "<该 ZT IP>"`（内置默认密钥会自动被忽略，免密钥运行；想更稳可保留密钥）；
3. 手机/电脑装 **ZeroTier 客户端**并加入同一个网络（登录一次即可，之后无感）；
4. 油猴面板「后端」填 `http://<ZT IP>:8765`，脚本顶部加一行 `// @connect <ZT IP>`：**不用填密钥**。

安全说明：后端判断“私网/本机”才允许免密钥——`0.0.0.0`、`::` 和公网 IP 一律强制 api_key，所以就算配置写错也不会裸奔到公网。
> 局域网设备不走 ZeroTier 也 OK：把 `host` 设为局域网 IP（如 `192.168.31.16`）同样可免密钥，仅本网段可达。

### 云服务器部署建议（加分项）
- 用非 root 用户跑；`python server.py`（或 systemd 保活）；
- 公网直连建议套 Caddy（自动 HTTPS）或 Nginx，把 `8765` 留在内网不要直接暴露外网端口；
- 反代示例（Caddy）：
  ```
  exam.example.com {
      reverse_proxy 127.0.0.1:8765
  }
  ```
- 即使 HTTPS 反代，API 内层仍可保留 api_key 二次鉴权，双重保险。

### 云服务器部署（1Panel 面板 · 手把手）
以 1Panel 面板为例，把后端放到云服务器上，走 域名+HTTPS 反代：

**1. 上传项目**
用 1Panel「文件」把 `Autoexam` 里的 `backend` 和 `exambank` 两个文件夹上传到服务器，例如放到 `/opt/autoexam/` 下，最终结构：
```
/opt/autoexam/backend/        # server.py 等
/opt/autoexam/exambank/       # 题库文件夹
```

**2. 改配置 `backend/config.json`**
```json
{
  "host": "0.0.0.0",
  "port": 8765,
  "bank_folder": "/opt/autoexam/exambank",
  "api_key": "oJF9_FbS9DD0mLd9g7sZfGCm-UBuhMoXcgvCQVskF8A",
  "require_key": "auto"
}
```
（`api_key` 保持内置默认即可；脚本会自动带上它。）

**3. 装 Python 依赖（服务器上，先装 python3/pip）**
```bash
cd /opt/autoexam/backend
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install fastapi "uvicorn[standard]" openpyxl
```

**4. 1Panel 创建 Python 网站（负责把服务跑起来 + 保活）**
- 1Panel →「网站」→「Python 项目」→ 创建网站/添加项目；
- 运行目录：`/opt/autoexam/backend`
- 启动命令：`./venv/bin/python server.py`（或先把 `.conf` 里 venv 写对）
- 端口：`8765`
- 保存后应能看到进程在跑；服务器上验证：
  ```bash
  curl -H "X-API-Key: oJF9_FbS9DD0mLd9g7sZfGCm-UBuhMoXcgvCQVskF8A" http://127.0.0.1:8765/api/health
  ```

**5. 反代 + HTTPS（用域名访问，不出裸 http）**
- 1Panel →「网站」→ 创建「反向代理」网站，填你的域名（如 `exam.example.com`）；
- 反向代理目标：`http://127.0.0.1:8765`；
- 申请/开启 HTTPS（Let's Encrypt 免费证书，1Panel 一键）。

**6. 云安全组 / 防火墙**
- 只放行 `80/443`；**不要**对外开放 `8765`（反代已经把它包在内网，公网只会经过 HTTPS 域名）。

**7. 客户端（油猴）**
- 面板「后端」填 `https://exam.example.com`；
- 脚本顶部加一行 `// @connect exam.example.com`；
- 「密钥」不用填（内置默认与服务器一致）；点「自检」显示“后端已连接 · N 题”即成功。

> 说明：这样部署，公网只有 HTTPS 域名这一条受控入口，内部的 `8765` 不对外开放；
> 即便未来把 8765 也暴露了，内置 api_key 也会挡一层（`host=0.0.0.0` 时强制启用）。

---

## API 说明

> 注：config 里设置了 `api_key` 后，以下所有接口都要求请求头
> `X-API-Key: <密钥>`（或 `Authorization: Bearer <密钥>`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务状态、题目数量 |
| GET | `/api/banks` | 已加载的题库清单 |
| POST | `/api/reload` | 重载题库，body `{"folder":""}`（空则用默认；仅限白名单目录） |
| POST | `/api/query` | 答题查询（见下） |

`/api/query` 请求：
```json
{
  "type": "single | multi | judge",
  "stem": "从事城市轨道交通安全检查的……立即向(   )报告。",
  "options": ["人民政府","运营单位","公安机关","管理单位"],
  "bank": "《国务院办公厅关于保障城市轨道交通安全运行的意见》"
}
```
返回（节选）：
```json
{
  "found": true, "match_type": "exact", "confidence": 1.0,
  "kind": "choice", "bank": "《…》题库", "sheet": "选择题",
  "answers": ["公安机关"], "judge_answer": null
}
```
- 选择/多选看 `answers`（正确选项的文字，可能多个）；
- 判断题看 `judge_answer`（true=对 / false=错）。

---

## 调参
油猴面板里可调：
- **间隔(ms)**：选题后到点下一题之间的间隔；
- 更多节奏/抖动在脚本顶部 `CFG` 里：`delayBefore / delayAfter / delayAdvance / jitter`。

---

## 其它页面的适配
- 脚本按「当前可见的 `div.topic-mc`」定位题目，题型取 `[单选题]/[多选题]/[判断题]`，
  选项取 `ul.module-list-06 li`，「下一题」取 `.exam-foot` 里文字等于“下一题”的按钮。
- 若未来系统改版 DOM 变了，改 `userscript\autoexam.user.js` 里的
  `currentBlock() / extractQuestion() / nextButton()` 三个函数即可，后端不用动。
