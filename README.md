# KQAssistant / HR 打卡助手

一个基于 Android WebView 的辅助工具，用于在特定 Landray/KK 人力资源移动门户中注入自定义定位、相机与位置相关能力。应用通过 JavaScript 注入与原生的 Kotlin Bridge 配合，协调 WGS-84 / GCJ-02 / BD-09 三种坐标系，使页面显示、服务端校验与照片 EXIF 保持一致。

> **声明**：本工具仅用于合法授权的内部测试、自身考勤打卡或学习研究。请勿用于任何违反公司制度、法律法规或侵犯他人权益的场景。使用本工具产生的任何后果由使用者自行承担。

---

## 目录

- [功能特性](#功能特性)
- [适用场景](#适用场景)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [构建 Debug APK](#构建-debug-apk)
  - [构建 Release APK](#构建-release-apk)
  - [安装](#安装)
- [使用说明](#使用说明)
  - [首次启动](#首次启动)
  - [模拟定位](#模拟定位)
  - [相机与图片](#相机与图片)
  - [预设坐标](#预设坐标)
- [坐标系说明](#坐标系说明)
- [核心实现](#核心实现)
- [已知限制](#已知限制)
- [排错记录](#排错记录)
- [贡献与许可](#贡献与许可)

---

## 功能特性

- **WebView 注入**：在目标 HR 移动站点加载自定义 `inject.js`，接管定位、相机等 KK SDK API。
- **模拟定位**：支持手动输入经纬度或在地图上选点，关闭模拟后恢复真实 GPS。
- **坐标系自动转换**：内部统一使用 WGS-84，按需转换为 GCJ-02（高德/服务端）或 BD-09（KK SDK）。
- **相机接管**：拦截 `Was.exec('image', ...)`，调用系统相机/相册，并将用户所选坐标写入照片 EXIF GPS。
- **预设管理**：可保存常用坐标，支持长按删除。
- **原生定位辅助**：当未开启模拟定位时，使用 Android `LocationManager` 提供真实坐标。
- **KK SDK 兼容**：模拟 KK JS SDK 的 `Was.exec` / `Was.execA` / `Was.callbackResult` / `__js2java_proxy`。

---

## 适用场景

本应用针对以下地址进行适配：

```
https://hr-mobile.hncsmtr.com:7443/login?sso=customer_sso&next=/&j_lang=zh-CN
```

如果你需要适配其他 Landray/KK 站点，通常只需修改 `MainActivity.kt` 中的 `loadUrl` 地址，并视情况调整 `inject.js` 中的 URL/接口匹配逻辑。

---

## 双门户合一（本地引导页 + 两个系统）

应用用**同一个 WebView、同一套 Cookie** 承载员工培训与人力资源两个系统，首次打开进入
**本地引导页**（`assets/launcher.html`），点击按钮进入对应系统，网页铺满手机屏幕：

| 入口 | 登录地址 | 注入脚本 | 用途 |
|------|----------|----------|------|
| 人力资源 | `hr-mobile.hncsmtr.com:7443/login...` | `assets/inject.js` | HR 打卡助手（定位/相机/坐标） |
| 员工培训 | `hrt-mobile.hncsmtr.com:8085/mobile/ssoLogin?j_lang=zh-CN` | `assets/autoexam.js` | 自动答题助手（配合 Autoexam 后端） |

- 两套系统都走 SSO 登录、共用同一套 Cookie：在人力资源登录后，进员工培训会自动带登录态。
- **返回引导页**：两个系统的首页没有返回历史时，按系统返回键（或导航栏返回）即回到本地引导页；
  在引导页按返回则退出应用。
- **两份 JS 完全独立、互不合并**：`inject.js` 保持原样；`autoexam.js` 来自
  `D:\Autoexam\userscript\autoexam.user.js`（去掉油猴元数据、加防重复注入守卫，
  并对 WebView 做了手机适配——面板显式配色、宽度自适应；系统菜单改用本地引导页后已移除）。

### 考试答题仍需 PC 上的 Autoexam 后端

- **Python 后端完全不动**：在 PC 上运行 `D:\Autoexam\start_server.bat`（或 `python backend\server.py`），
  API 在 `http://127.0.0.1:8765`。
- **手机真机连后端**：手机上的 `127.0.0.1` 指向的是手机自身，不是 PC。请在考试页面板的
  「后端」输入框里改成 PC 的局域网 IP，例如 `http://192.168.1.10:8765`（用 `ipconfig` 查 PC 实际 IP；
  若连不上，确认后端能通过系统防火墙）。
- 为支持「https 考试页 → 局域网 http 后端」的请求，已放行混合内容
  （`MIXED_CONTENT_ALWAYS_ALLOW`）与局域网明文流量（`network_security_config` 的 `base-config`），
  对 `hr-mobile` / 高德 / unpkg / OSM 等原有 https 域名仍保持禁明文。

---

## 技术栈

- **Kotlin**：原生 Android 逻辑（`MainActivity`、Bridge、定位、图片处理）。
- **JavaScript**：WebView 注入脚本，负责坐标转换、DOM 面板、XHR 拦截、SDK API 模拟。
- **Android Gradle Plugin 8.x**，`compileSdk = 34`，`minSdk = 24`。
- **依赖**：
  - `androidx.core:core-ktx`
  - `androidx.appcompat:appcompat`
  - `com.google.android.material:material`
  - `androidx.webkit:webkit`

---

## 项目结构

```
hr-punch-apk/
├── app/
│   ├── build.gradle.kts              # 模块构建配置
│   └── src/main/
│       ├── AndroidManifest.xml       # 权限与组件声明
│       ├── assets/
│       │   └── inject.js             # WebView 注入脚本（核心逻辑）
│       ├── java/com/hrpunch/
│       │   ├── MainActivity.kt       # WebView 初始化、页面加载
│       │   ├── JSBridge.kt           # JS ↔ Native 通用桥
│       │   ├── Js2JavaProxyBridge.kt # 模拟 __js2java_proxy，返回 BD-09
│       │   ├── LocationHelper.kt     # Android GPS 获取与权限管理
│       │   └── ImagePluginHandler.kt # 相机/图片处理与 EXIF GPS 写入
│       └── res/                      # 布局、图标、主题等资源
├── build.gradle.kts                  # 项目级构建配置
├── settings.gradle.kts               # Gradle 项目设置
├── gradle.properties                 # Gradle 属性
├── COORDINATE_SYSTEM_NOTES.md        # 坐标系问题排查与技术文档
└── README.md                         # 本文件
```

---

## 快速开始

### 环境要求

- JDK 17+
- Android SDK（API 34 编译，API 24 起可安装）
- Android SDK Build-Tools（用于 `aapt` 验证等可选操作）
- 一台 Android 设备或模拟器（用于运行测试）

将 SDK 路径写入 `local.properties`（该文件已加入 `.gitignore`，不会被提交）：

```properties
sdk.dir=C:\\Users\\YourName\\android-sdk
```

### 构建 Debug APK

```bash
./gradlew assembleDebug
```

输出：`app/build/outputs/apk/debug/app-debug.apk`

### 构建 Release APK

Release 构建已配置为复用 **debug keystore**，因此无需你提供签名文件即可直接安装测试。

```bash
./gradlew assembleRelease
```

输出：`app/build/outputs/apk/release/app-release.apk`

### 安装

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

或把 APK 复制到手机后通过文件管理器安装（需允许“安装未知应用”）。

---

## 使用说明

### 首次启动

1. 打开应用，授予 **位置** 与 **相机/存储** 权限。
2. 应用会自动加载目标 HR 登录页。
3. 页面右上角（或脚本注入的面板中）会出现“HR 助手”浮动控制面板。

### 模拟定位

1. 在面板中输入目标经纬度（GCJ-02 火星坐标）。
2. 点击“开启模拟定位”。
3. 页面上的定位标记、打卡校验将使用你设定的坐标。
4. 关闭模拟定位后，应用恢复使用真实 GPS。

> **注意**：未输入有效坐标时，面板会阻止开启模拟定位，避免误定位到默认地址。

### 相机与图片

在 HR 页面点击拍照/相册时：

- 应用会拦截 KK SDK 的 `Was.exec('image', ...)`。
- 调用系统相机或相册选择图片。
- 如果已开启模拟定位，照片 EXIF 的 GPS 信息会写入你设定的坐标；否则不写入 GPS。

### 预设坐标

- 可将常用坐标保存为预设，方便快速切换。
- 长按预设项可删除。

---

## 坐标系说明

本应用涉及三种常见坐标系：

| 坐标系 | 说明 | 使用方 |
|--------|------|--------|
| **WGS-84** | GPS 硬件与国际标准 | 应用内部存储的“真值” |
| **GCJ-02** | 国测局加密坐标（火星坐标） | 高德地图、服务端 `attend.signin.geocheck`、`position.gcj.encryptwgs` |
| **BD-09** | 百度二次加密坐标 | Landray/KK 原生定位 API `kk.location.getLocation()` |

转换关系：

```
WGS-84 --(国家加密)--> GCJ-02 --(百度二次加密)--> BD-09
```

应用内部约定：

- `__hr_real_coords_wgs`：真实 GPS（WGS-84）。
- `__hr_fake_coords_wgs`：用户输入/地图选点转换后的 WGS-84。
- `__hr_fake_coords_bd09` / `__hr_fake_coords_gcj`：分别给 KK SDK 和服务端使用的坐标。

更详细的排查过程、根因分析与数据流图请参见 [`COORDINATE_SYSTEM_NOTES.md`](./COORDINATE_SYSTEM_NOTES.md)。

---

## 核心实现

### 1. `inject.js`

- 在页面加载后向 `document.head` 注入 `<script>`，覆盖/增强 KK SDK。
- 提供 `wgs84ToGcj02`、`gcj02ToBd09`、`wgs84ToBd09` 等坐标转换函数。
- 重写 `Was.exec` / `Was.execA` / `Was.callbackResult`，使其返回 **BD-09**。
- XHR 拦截器修正 `position.gcj.encryptwgs` 与 `attend.signin.geocheck` 的请求体为 **GCJ-02**，并重新计算校验 hash。
- 提供浮动 UI 面板：坐标输入、模拟开关、预设管理、地图选点。

### 2. `Js2JavaProxyBridge.kt`

- 处理 SDK 的 `__js2java_proxy` 调用。
- 模拟模式返回 `__hr_fake_coords_bd09`。
- 真实模式将 `__hr_real_coords_wgs` 转换为 **BD-09** 返回。
- 无有效坐标时返回错误，不再使用任何硬编码兜底坐标。

### 3. `LocationHelper.kt`

- 请求位置权限。
- 通过 `LocationManager` 获取真实 GPS/WiFi 定位。
- 每 5 秒刷新一次，写入 `window.__hr_real_coords_wgs`。

### 4. `ImagePluginHandler.kt`

- 处理 `Was.exec('image', ...)` 回调。
- 启动系统相机或相册。
- 对图片进行缩放、旋转校正。
- 从 WebView 异步读取 `__hr_fake_coords_wgs`，写入 JPEG EXIF GPS。

---

## 已知限制

- 当前仅针对 `https://hr-mobile.hncsmtr.com:7443` 这个特定站点做了适配。
- Release APK 使用 debug keystore 签名，**仅适合内部测试**，不能上传到 Google Play 等应用商店。
- 部分企业版 Landray/KK 可能有额外的风控或签名校验，超出本工具处理范围。
- Android 10+ 对后台定位、相册读取有更严格限制，建议授予必要权限。

---

## 排错记录

主要问题与修复已整理在 [`COORDINATE_SYSTEM_NOTES.md`](./COORDINATE_SYSTEM_NOTES.md)，包括：

- 相机/图片无法点击（`_hr_isLocationPlugin` 缺失）。
- 页面定位偏移约 1.2 km（KK SDK 期望 BD-09，之前返回 GCJ-02）。
- `position.gcj.encryptwgs` 500 错误（请求体坐标无效/坐标系错误）。
- 硬编码默认坐标移除过程。

---

## 贡献与许可

本项目为个人/内部学习与研究用途。

- 欢迎提交 Issue 或 PR 改进坐标转换精度、适配更多站点、优化 UI。
- 请勿将本工具用于未经授权的考勤作弊或其他违法行为。
- 代码按原样提供，不提供任何明示或暗示的担保。

---

## 常见问题

**Q：App 连公网后端（如 www.ep2w.fun）时面板提示"后端未连接"？**
油猴的 `@connect` 只对油猴有效，App 内的 `fetch()` 受浏览器 CORS 约束。从 1.3.6 起，App 已内置
**原生网络桥**（`HRBridge.nativeApi`）：用 Android 原生发请求、绕过浏览器 CORS，因此
**连 `https://www.ep2w.fun`（或 `http://` 自动跳转）无需再给服务器配 CORS**，
面板"后端"填 `https://www.ep2w.fun` 点「自检」应显示"后端已连接"。

> 若仍连不上，用 Chrome 的 chrome://inspect 看日志；确认密钥与后端 config.json 一致
> （401 会在面板提示"后端要密钥"）。油猴版则仍需 `@connect` 或服务器 CORS，两者互不影响。

**Q：为什么每次退出 App 都要重新登录？不是有 Cookie 吗？**
两套系统共用同一套 SSO 登录 Cookie，App 已默认持久化并强制写盘
（进入后台/退出时 `CookieManager.flush()`，避免杀进程丢登录态）。
但仍要重登，通常是**服务端 SSO 会话超时**（会话 ID 过期，服务器判定失效）导致的——
这由服务器决定，App 无法绕过。建议：不要频繁在最近任务栏把 App 滑掉，避免会话被中断。

**Q：Debug 和 Release 有什么区别？Debug 怎么用？**
两者功能完全一致，均未混淆、签名均为 debug keystore（仅供自测，不能上架）。
Debug 提供调试能力：
- Chrome 远程调试：手机开 USB 调试连 PC，PC Chrome 打开 `chrome://inspect`
  即可实时查看 WebView 的 DOM/控制台/网络（排查注入脚本是否生效最方便）。
- `adb logcat` 查看 App 日志。
注意两个包 `applicationId` 相同，不能同时安装，装一个会覆盖另一个；日常使用推荐 Release。

---

## 版本

当前版本：**1.4.3**

主要变更：

- autoexam 升级到 **1.6.3**，新增**日期归一化**：选项/答案中的日期文本
  （2024年11月9日 / 2024-11-09 / 2024/11/9）与 **Excel 序列日期**（如 45605）归为同一比较键，
  解决"题库存序列号、页面显示日期"导致的匹配失败（与 5%↔0.05 同思路）。已用 Node 验证
  `45605 == 2024年11月9日` 且不同日期不混淆。

### 1.4.2

- **修复后端地址输入框退格删不掉**：之前"输入即保存"会在每次按键时把旧值写回输入框，
  导致删空后最后一个字符删不掉。改为**只在失焦/回车时提交保存**，打字过程不再重写输入框。
- **多选撤销双策略**：回到固定的"逐项点击 + 等待 Vue 刷新"方式（每点多选仍稳定）。

### 1.4.1

- autoexam 升级到 **1.6.3**，多选题采用"双策略"：
  1) 先按桌面原版**同步快速连点**（桌面 Chrome 里 Vue 批处理一次全选中，兼容原行为）；
  2) 若验证未选中（常见于窄屏 WebView 点击伴随滚动/重渲染打断批处理），自动降级为
     **逐项点击 + 等待 Vue 刷新**，已选中的项跳过避免误取消。
- （该版本随后按用户要求回退，见 1.4.2 说明。）

### 1.4.0

- autoexam 升级到 **1.6.2**，进一步修复多选题：多选题改为**逐项点击 + 等待 Vue 刷新**
  （每点一项 `await ~120ms` 再点下一项），并在每项点击后按“选中态”做兜底确认；
  把多选调用改为 `await`。解决"日志显示已点 N 项但页面没选中"。

### 1.3.9

- **修复 1.3.8 回归**：同步脚本时把 App 独有的两处适配（原生网络桥 `HRBridge.nativeApi`、
  后端地址原生持久化）覆盖掉了，导致连不上 `www.ep2w.fun`。已重新套回：
  原生网络桥分支、后端地址持久化/写回、手机面板 CSS、防重复注入守卫全部恢复。

### 1.3.8

- autoexam 升级到 **1.6.1**，修复多选题作答：
  - **多选点不中**：之前用页面重渲染前的旧 DOM 节点逐项点击，点完第一项后其余失效；
    现改为每一项都在点击时重新抓取当前最新选项节点。
  - **5% vs 0.05 匹配不上**：选项比较键新增数字/百分比归一化（5% ↔ 0.05 ↔ 5.0% 视为相等）。

### 1.3.7

- **修复后端地址回退 bug**：面板保存的后端地址之前在页面重载后不会写回配置（一直用默认
  127.0.0.1），表现为"连上后又回退"。现在加载时会把保存值真正写入，并改为输入即保存、
  App 原生持久化（不随 http/https 不同源切换而丢失）；失败提示会显示当前实际连接地址。

### 1.3.6

- **新增原生网络桥**（`HRBridge.nativeApi`）：autoexam 在 App 内改用 Android 原生发请求，
  绕过浏览器 CORS，可直连公网后端（如 https://www.ep2w.fun），无需服务器配 CORS。

### 1.3.5

- autoexam 注入脚本头加入 `@connect www.ep2w.fun`（油猴专用，App 内为注释无效）；
  定位并记录公网后端无 CORS 导致「后端未连接」的原因。

### 1.3.4

- autoexam 注入脚本升级到 **1.6.0**（`assets/autoexam.js`），保留 WebView 适配
  （防重复注入 + 手机面板显式配色/宽度自适应）。

### 1.3.3

- autoexam 注入脚本升级到 **1.5.1**：新增后端 API 密钥支持（内置密钥与 backend/config.json
  一致，公网后端自动发送）、更多匹配/点击健壮性；保留 WebView 适配。

### 1.3.2

- 登录态改进：显式开启 Cookie 接受，并在进入后台/退出时强制 `CookieManager.flush()` 写盘，
  减少"退出 App 后要重新登录"的情况（服务端 SSO 会话超时仍由服务器决定）。

### 1.3.1

主要变更：

- 新增本地引导页（`assets/launcher.html`）：首次打开进引导页，两个按钮分别进入
  **人力资源 / 员工培训**，替代原先的顶部菜单；无标题栏、网页铺满全屏。
- 员工培训入口改为 SSO 登录：`hrt-mobile.hncsmtr.com:8085/mobile/ssoLogin?j_lang=zh-CN`
  （与人力资源共用同一套 Cookie）。
- 修复员工培训面板在手机 WebView 的兼容性：关闭算法深色模式（原会导致白字看不清），
  面板显式配色 + 宽度自适应（`min(310px, calc(100vw - 16px))`）。

### 1.3.0

- 双门户合一：新增员工培训门户（`hrt-mobile.hncsmtr.com:8085`）支持，进入考试页自动注入
  `autoexam.js`（来自 Autoexam 项目，答题逻辑与 Python 后端均未改动）。
- 保留两份独立 JS（`inject.js` / `autoexam.js`），按页面 host 分流注入，互不干扰。

### 1.2.11 及更早的历史变更

- 模拟定位（预设/手动坐标）使用时加入约 10 米半径的随机偏移，避免每次打卡经纬度完全一致。
- 移除 `attend.signin.create` 的 XHR 拦截，恢复旧版 debug 的成功模式。
- `position.gcj.encryptwgs` 仍修正为 GCJ-02，`attend.signin.geocheck` 仍修正为 GCJ-02。
- 移除所有硬编码默认坐标，未选点时不再 fallback 到任何固定地址。
- 模拟定位开启前强制校验坐标有效性。
- 图片 EXIF GPS 改为从 WebView 动态读取用户所选坐标。
