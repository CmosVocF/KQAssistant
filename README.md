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

## 版本

当前版本：**1.2.7**

主要变更：

- 移除所有硬编码默认坐标，未选点时不再 fallback 到任何固定地址。
- 模拟定位开启前强制校验坐标有效性。
- 图片 EXIF GPS 改为从 WebView 动态读取用户所选坐标。
- 完善坐标系转换与 XHR 拦截逻辑。
