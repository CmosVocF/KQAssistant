# KQAssistant / KQ 助手

基于 Android WebView 的内部工具集：**人力资源打卡**、**员工培训自动答题**、**镟轮数据自动填写**。
应用通过 JavaScript 注入 + Kotlin 原生 Bridge，在同一个 WebView 中承载多个业务系统，并新增本地页面（作业管理 / 模型设置 / 图片识别 / 表格导出）。

> **声明**：本工具仅用于合法授权的内部测试、自身考勤打卡或学习研究。请勿用于任何违反公司制度、法律法规或侵犯他人权益的场景。使用本工具产生的任何后果由使用者自行承担。

---

## 目录

- [功能入口](#功能入口)
- [镟轮数据模块](#镟轮数据模块)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [构建](#构建)
- [使用说明](#使用说明)
  - [镟轮数据使用流程](#镟轮数据使用流程)
  - [模型设置](#模型设置)
  - [导出 Excel](#导出-excel)
- [数据存储](#数据存储)
- [版本与测试包](#版本与测试包)
- [坐标系说明](#坐标系说明)
- [已知限制](#已知限制)
- [贡献与许可](#贡献与许可)

---

## 功能入口

启动页（`assets/launcher.html`）提供三个入口，右上角 ⚙ 为**全局模型设置**：

| 入口 | 地址/页面 | 注入/资源 | 用途 |
|------|-----------|-----------|------|
| 人力资源 | `hr-mobile.hncsmtr.com:7443` | `assets/inject.js` | HR 打卡（定位 / 相机 / 坐标） |
| 员工培训 | `hrt-mobile.hncsmtr.com:8085` | `assets/autoexam.js` | 自动答题（配合 `modules/autoexam` 后端） |
| 镟轮数据 | `assets/xuanlun.html`（本地） | `assets/xuanlun-*.{html,css,js}` | 拍照识数 → 自动填表 → 导出 xlsx |

- 两个业务系统共用同一 WebView 与 Cookie（SSO）。
- 镟轮数据为纯本地页面，不需要登录；识别调用用户在设置中配置的 OpenAI 兼容多模态模型。

---

## 镟轮数据模块

### 功能

- **作业管理**：新建作业只填「线路 + 车号」，自动生成 6 节（如 4 号线 047048 → `04A047/04B047/04C047/04C048/04B048/04A048`）。
- **每节独立参数**：日期、镟修人、复核人（各节可不同，本地持久化）。
- **每轴上传**：`04A047-1 … -4` 各一行，点「上传照片」→ 应用内弹窗「拍照 / 从相册选择」。
- **透视校正**：自动预检纸张四角，可拖动微调；确认后透视变换 + 灰度增强，保留原图与增强图。
- **多模态识别**：调用当前模型提取 轮对ID/车辆ID/方向/加工前与加工后 的左/右轮 4 项数据；主模型失败自动回退备选模型。
- **人工核对**：识别结果进入编辑页（上半屏图片、下半屏数据），可逐项修改后保存；方向 A-B/B-A 在编辑页设置，B-A 时填表自动交换左右轮。
- **预览**：按模板版式复刻 15 列表格，公式（轮经差、轮径切削量、一转/二转/整节最大差值）实时计算。
- **导出**：生成保留原公式与格式的 `.xlsx`（6 页整本），文件名 `{线路}号线轮对数据尺寸统计表{车号}车{YYYY年M月D日}.xlsx`。

### 文件与数据结构

- 本地存储（SharedPreferences，JSON）：
  - `xuanlun_data`：作业、每节参数、每轴数据与图片路径；
  - `xuanlun_models`：服务商、模型库、当前/备选模型。
- 图片：`/data/data/com.hrpunch/files/xuanlun/{作业}/{节}/{轴}.jpg`（增强图）与 `{轴}_orig.jpg`（原图）。
- 空白模板：`assets/xuanlun/template.xlsx`（数据清空、公式/合并/样式保留）。

---

## 技术栈

- **Kotlin**：WebView 宿主、Bridge、相机/相册、透视校正、识别请求。
- **JavaScript**：注入脚本 + 本地页面（作业、设置、编辑、预览、导出）。
- **ExcelJS**：本地页面内读写 xlsx（`assets/exceljs.min.js`）。
- **Android Gradle Plugin 8.x**，`compileSdk = 34`，`minSdk = 24`。
- 依赖：`androidx.core:core-ktx`、`androidx.appcompat:appcompat`、`material`、`androidx.webkit:webkit`。

---

## 项目结构

```
KQAssistant/
├── app/
│   ├── build.gradle.kts                  # 版本号、APK 输出命名（KQAssistant-<版本>-<变体>.apk）
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── assets/
│       │   ├── launcher.html             # 本地引导页（三入口 + ⚙）
│       │   ├── inject.js                 # 人力资源注入脚本
│       │   ├── autoexam.js               # 员工培训注入脚本
│       │   ├── xuanlun.css / xuanlun-common.js
│       │   ├── xuanlun.html              # 作业列表
│       │   ├── xuanlun-job.html          # 作业详情（预览/每轴上传）
│       │   ├── xuanlun-edit.html         # 编辑页（上半图片/下半数据）
│       │   ├── xuanlun-models.html       # 镟轮模型选择（当前/备选）
│       │   ├── xuanlun-settings.html     # 模型设置（服务商/模型库/测试）
│       │   ├── exceljs.min.js            # xlsx 读写库
│       │   └── xuanlun/template.xlsx     # 空白模板（保留公式与格式）
│       ├── java/com/hrpunch/
│       │   ├── MainActivity.kt           # WebView、注入分流、拍照/相册、识别
│       │   ├── JSBridge.kt               # 通用桥（页面/存储/LLM/图片/xlsx/分享）
│       │   ├── CropView.kt               # 四角透视校正视图
│       │   ├── XuanlunCropActivity.kt    # 校正页（透视 + 增强 + 保存）
│       │   ├── Js2JavaProxyBridge.kt
│       │   ├── LocationHelper.kt
│       │   └── ImagePluginHandler.kt
│       └── res/
├── modules/autoexam/                     # 培训自动答题（后端/题库/油猴脚本）
├── tools/
│   ├── build_apk.ps1                     # 构建并复制带版本号 APK 到 dist/
│   └── sync_autoexam.ps1
├── dist/                                 # 本地构建产物（.gitignore）
└── README.md
```

---

## 构建

环境：JDK 17、Android SDK（API 34 编译）、Build-Tools。

```powershell
# 方式一：脚本（自动设置 JAVA_HOME/GRADLE_USER_HOME，并把 APK 复制到 dist\）
powershell -ExecutionPolicy Bypass -File tools\build_apk.ps1

# 方式二：手动
$env:JAVA_HOME='D:\KQAssistant\env\jdk'
$env:GRADLE_USER_HOME='D:\KQAssistant\env\gradle-home'
.\gradlew.bat :app:assembleDebug :app:assembleRelease --no-daemon
```

输出（文件名带版本号，不同测试版不会互相覆盖）：

```
app/build/outputs/apk/debug/KQAssistant-<版本>-debug.apk
app/build/outputs/apk/release/KQAssistant-<版本>-release.apk
```

Release 复用 debug keystore，可直接安装测试。

---

## 使用说明

### 镟轮数据使用流程

1. 启动页 →「镟轮数据」→「＋ 新建作业」→ 填线路（如 4）与车号（如 047048）；
2. 进入作业 → 顶部 6 节页签 → 选一节，填日期/镟修人/复核人；
3. 某轴点「上传照片」→ 弹窗选「拍照」或「从相册选择」；
4. 进入**四角校正页**：拖动四个圆点贴合纸张边缘 →「确认校正」；
5. 自动识别（主模型失败会换备选模型）→ 进入**编辑页**：上半屏看图片（点图切换原图/增强图），下半屏核对/修改数据 → 保存；
6. 回到作业页，表格预览实时显示数值与计算结果；
7. 全部完成后点「导出 Excel」→ 分享/另存为，得到可打印的 xlsx。

### 模型设置

启动页右上角 ⚙：

1. 「＋ 添加服务商」→ 填名称（可选）、Base URL（OpenAI 兼容，如 `https://xxx/v1`）、API Key → 保存后自动拉取模型列表；
2. 模型列表中点「＋ 添加」加入**可用模型**；
3. 每个可用模型可单独设置**上下文长度**、**思考等级**，并单独「测试」；
4. 镟轮数据 → 作业列表 →「模型」：选择**当前模型**与**备选模型**（主模型失败时回退）。

### 导出 Excel

- 使用内置空白模板（公式 G/L/N/O、合并单元格、边框样式保留）；
- 6 个 sheet 按作业节命名，标题与页脚（镟修人/复核人/时间）自动写入；
- B-A 方向的轴，导出时左右轮数据互换；
- 未上传/未填写的轴保持空白。

---

## 数据存储

| 键 | 内容 |
|----|------|
| `xuanlun_data` | 作业列表、每节参数、每轴识别数据、图片路径 |
| `xuanlun_models` | 服务商、模型库、当前/备选模型 |
| `hrpunch_config` | 原有 HR 打卡配置（UA、预设坐标、autoexam 后端地址等） |

图片保存在应用私有目录 `files/xuanlun/...`，卸载应用即清除。

---

## 版本与测试包

- 正式功能版本：`1.4.0`（新增镟轮数据模块）。
- 测试构建：`1.4.0-test001`、`test002` … 递增，`versionCode` 每次 +1；
- APK 文件名带版本号，构建后同时复制到 `dist/`，不会互相覆盖；
- 正式发布时去掉 `-testNNN` 后缀。

---

## 坐标系说明

| 坐标系 | 说明 | 使用方 |
|--------|------|--------|
| **WGS-84** | GPS 硬件与国际标准 | 应用内部存储的"真值" |
| **GCJ-02** | 国测局加密坐标（火星坐标） | 高德地图、服务端校验 |
| **BD-09** | 百度二次加密坐标 | KK 原生定位 API |

内部约定：`__hr_real_coords_wgs`（真实）、`__hr_fake_coords_wgs`（模拟）、`__hr_fake_coords_bd09/gcj`（分发）。
详细排查见 [`COORDINATE_SYSTEM_NOTES.md`](./COORDINATE_SYSTEM_NOTES.md)。

---

## 已知限制

- 识别依赖多模态模型能力，票据模糊/反光时可能识别错误，**必须人工核对后再导出**；
- 不同网关对 `reasoning_effort` 等参数支持不一，失败时应用会自动去掉该参数重试；
- 镟轮模板为旧版 `.xls` 转换的 `.xlsx`（`assets/xuanlun/template.xlsx`），如模板改版需同步替换；
- ExcelJS 在 WebView 内导出大文件时耗时数秒，属正常现象。

---

## 贡献与许可

- 仅限内部使用；二次分发请保留声明并遵守所在单位制度。
- 题库与业务数据不随仓库分发。
