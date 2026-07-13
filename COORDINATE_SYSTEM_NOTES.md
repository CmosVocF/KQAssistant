# HR 打卡助手 — 坐标系问题排查与解决方案

> 本文档记录了一次 KK/Landray HR 移动端 WebView 注入脚本中，因坐标系不匹配导致的定位偏移与 `position.gcj.encryptwgs` 500 错误的完整排查过程、根因分析与最终方案。
> 供后续维护 Agent 快速理解上下文。

---

## 1. 问题现象

在修复“相机/图片选择无法点击”后（原因：注入脚本缺少 `_hr_isLocationPlugin`，导致 `Was.exec('image', ...)` 抛 `ReferenceError`），重新出现两个问题：

1. **Web 打卡页面显示的定位偏移**（约 1.2 km）。
2. 页面弹出错误：
   ```
   执行api错误:position.gcj.encryptwgs 错误号:...
   ```
   对应服务端 `POST /api/position.gcj.encryptwgs` 返回 `500 Internal Server Error`。

奇怪的是：
- 注入模块内置的高德地图定位始终准确。
- `attend.signin.geocheck` 最终能正确打卡。
- 当 `Was.exec` 因缺少 `_hr_isLocationPlugin` 而失败时，页面定位反而准确。

---

## 2. 排查过程：如何发现 KK SDK 需要 BD-09

### 2.1 第一个反常现象

最初修复相机时，发现 `hr-punch-debug.apk`（参考包）里 `_hr_isLocationPlugin` 函数缺失，导致 `Was.exec('image', ...)` 抛 `ReferenceError`，相机点不动。但用户反馈：**这个参考包的页面定位是准确的**。

当我们补上 `_hr_isLocationPlugin` 后，相机好了，页面定位却开始偏移。

这给出了第一个关键线索：
> **`Was.exec` 正常工作 → 页面偏移；`Was.exec` 失败走 SDK fallback → 页面准确。**

说明我们注入给 `Was.exec` 的坐标系，与 SDK 真正期望的坐标系不一致。

### 2.2 确认 SDK 的坐标转换点

通过给 `console.log` 加钩子，捕获到 SDK 打印：
```
kk gcj translate wgs success
```
该日志来自 `https://hr-mobile.hncsmtr.com:7443/static/service/mobile/common-30f95037f6a18cffff89.js`，说明这个文件是 SDK 的坐标转换模块。

日志还显示：
- `Was.exec` 返回的坐标被 SDK 转成 WGS-84 后发给服务端；
- 但 SDK 计算出的“最终显示坐标”是错的。

这进一步说明：**`Was.exec` 的返回值被 SDK 当作某种坐标系，再转换到显示坐标。我们给的坐标系不对。**

### 2.3 锁定 BD-09 的关键证据

启动后台代理搜索 Landray/KK 官方文档和公开资料，得到关键发现：

> **KK JS SDK 的 `kk.location.getLocation()` 返回的是百度 BD-09 坐标系。**

该结论来自 Landray KK JS SDK 文档的检索结果（`http://kk5.landray.com.cn:6789/jssdk/` 导航页及其版本文档）。

结合以下事实：
- 原生 KK 客户端里，`Was.exec('gps'/'location', ...)` 就是调用 `kk.location.getLocation()`；
- 参考包（Was.exec 失败）走原生 fallback，拿到真正的 BD-09，显示正确；
- 我们的包（Was.exec 成功）注入 GCJ-02，SDK 把它当 BD-09 处理，显示偏移。

于是形成假设：**必须让 `Was.exec` 返回 BD-09，而不是 GCJ-02。**

### 2.4 验证假设

修改 `inject.js`：
1. 新增 `wgs84ToBd09()` / `gcj02ToBd09()` 等转换函数；
2. 把 `_hr_tryGcjPos()` 改为 `_hr_trySdkPos()`，输出由 GCJ-02 改为 BD-09；
3. 同步修改 `Js2JavaProxyBridge.kt`，让原生桥也返回 BD-09。

重新打包测试后：
- ✅ 页面显示定位准确；
- ✅ 相机正常；
- ❌ 新出现 `position.gcj.encryptwgs` 500 错误。

这说明 BD-09 假设对“显示”是正确的，但引出了下一个问题：服务端接口需要 GCJ-02。

### 2.5 为什么 `position.gcj.encryptwgs` 会 500

观察日志：
```
{longitude: NaN, latitude: NaN, accuracy: 40}
[HR] position.gcj.encryptwgs 原始body: {"lng":null,"lat":null} 修正后: {"lng":null,"lat":null}
```

发现两个问题叠加：
1. **坐标系错误**：SDK 把 BD-09 发给了要求 GCJ-02 的接口；
2. **坐标无效**：`Was.exec` 被调用时，真实 GPS 坐标还没注入到 WebView，请求体里是 `NaN`/`null`。

因此需要：
- 在 XHR 层拦截 `position.gcj.encryptwgs`；
- 把请求体里的无效坐标或 BD-09 坐标统一替换为当前 GCJ-02；
- 必要时等待有效 WGS-84 坐标就绪。

### 2.6 最终验证

实现上述修复后，最终 APK 通过全部验证：
- 页面显示定位准确；
- 不再弹出 `position.gcj.encryptwgs` 错误；
- 相机/图片选择正常；
- 打卡/签入通过。

---

## 3. 涉及的坐标系

| 坐标系 | 说明 | 本系统中的使用方 |
|--------|------|------------------|
| **WGS-84** | GPS 硬件与国际标准 | Android `LocationManager` 返回；`navigator.geolocation` 标准输出；本应用内部以 WGS-84 作为“真值”存储 |
| **GCJ-02** | 国测局加密坐标（俗称“火星坐标”） | 高德/腾讯地图使用；服务端 `attend.signin.geocheck` 按 GCJ-02 校验；`position.gcj.encryptwgs` 接口要求 GCJ-02 输入 |
| **BD-09** | 百度坐标（在 GCJ-02 基础上二次加密） | **KK/Landray 原生定位 API `kk.location.getLocation()` 返回 BD-09**；SDK 内部通过 `Was.exec` 拿到的坐标预期是 BD-09 |

坐标转换关系：
```
WGS-84  --(国家加密)-->  GCJ-02  --(百度二次加密)-->  BD-09
```

---

## 4. 根因分析

### 4.1 定位偏移的根因：给 SDK 喂了错误的坐标系

KK SDK 的 JS Bridge（`Was.exec` / `Was.execA`）在原生 KK 客户端中，定位插件返回的是 **BD-09**。我们的注入脚本最初返回的是 **GCJ-02**，导致 SDK 把它当成 BD-09 做后续转换和显示，产生偏移。

**证据链：**
1. 运行时日志确认字符串 `kk gcj translate wgs success` 来自 `common-30f95037f6a18cffff89.js`。
2. Landray KK JS SDK 官方文档说明 `kk.location.getLocation()` 返回 **BD-09**。
3. 当 `Was.exec` 因缺少 `_hr_isLocationPlugin` 失败时，SDK 走原生 fallback，拿到真正 BD-09，显示反而正确。

### 4.2 `position.gcj.encryptwgs` 500 的根因：请求体坐标无效 + 坐标系错误

SDK 在拿到 `Was.exec` 返回的坐标后，会调用服务端接口 `position.gcj.encryptwgs` 把坐标转成加密的 WGS-84。该接口要求输入 **GCJ-02**。

把 `Was.exec` 改为返回 BD-09 后，出现两个新问题叠加：
1. **坐标系错误**：SDK 把 BD-09 坐标直接发给要求 GCJ-02 的 `position.gcj.encryptwgs`。
2. **坐标无效（NaN）**：`Was.exec` 被调用时，真实 GPS 坐标可能还没注入到 WebView，SDK 组织请求体时得到 `{"lng":null,"lat":null}`，服务端收到后 500。

**关键日志：**
```
{longitude: NaN, latitude: NaN, accuracy: 40}
[HR] position.gcj.encryptwgs 原始body: {"lng":null,"lat":null} 修正后: {"lng":null,"lat":null}
```

---

## 5. 解决方案

### 5.1 核心原则

以 **WGS-84** 作为内部唯一源坐标，再按“消费方期望的坐标系”分别转换：

| 消费方 | 需要的坐标系 | 实现位置 |
|--------|-------------|----------|
| KK SDK `Was.exec` / `Was.execA` / `Was.callbackResult` | BD-09 | `inject.js` 中 `_hr_trySdkPos()` / `_hr_makeSdkPos()` |
| `__js2java_proxy` 原生桥 | BD-09 | `Js2JavaProxyBridge.kt` |
| 高德地图面板 | GCJ-02 | `inject.js` 中 `getCurrentGcjCoords()` / `getMapCenter()` |
| Angular scope 强制注入 | GCJ-02 | `inject.js` 中 `forcePositionToAngular()` |
| 服务端 `attend.signin.geocheck` / `create` | GCJ-02 | `inject.js` XHR 拦截器 |
| 服务端 `position.gcj.encryptwgs` | GCJ-02 | `inject.js` XHR 拦截器（替换无效/BD-09 坐标） |

### 5.2 关键代码变更

#### `inject.js`

1. **新增 BD-09 转换函数：**
   ```javascript
   function gcj02ToBd09(lng, lat) { ... }
   function bd09ToGcj02(lng, lat) { ... }
   function wgs84ToBd09(lng, lat) { return gcj02ToBd09(wgs84ToGcj02(lng, lat)); }
   function bd09ToWgs84(lng, lat) { return gcj02ToWgs84(bd09ToGcj02(lng, lat)); }
   ```

2. **`Was.exec` / `Was.execA` / `Was.callbackResult` 返回 BD-09：**
   - 原 `_hr_tryGcjPos()` 重命名为 `_hr_trySdkPos()`，输出由 GCJ-02 改为 BD-09。
   - 原 `_hr_makeGcjPos()` 重命名为 `_hr_makeSdkPos()`。

3. **XHR 拦截 `position.gcj.encryptwgs`：**
   - 等待有效 WGS-84 坐标（最多 5 秒）。
   - 把请求体中的 `lat`/`latitude`/`lng`/`longitude`/`longtitude` 字段：
     - 若为 `null` / `undefined` / `NaN` / `0` / 空字符串 → 替换为当前 GCJ-02。
     - 若等于当前 BD-09 → 替换为当前 GCJ-02。

4. **`getCurrentWgsCoords()` 过滤无效坐标：**
   ```javascript
   if (real && typeof real.lng === 'number' && typeof real.lat === 'number' &&
       !isNaN(real.lng) && !isNaN(real.lat)) { ... }
   ```

#### `Js2JavaProxyBridge.kt`

原生桥返回给 SDK 的坐标也改为 BD-09：
- 模拟模式：从 `__hr_fake_coords_bd09` 读取。
- 真实模式：用 `wgs84ToBd09()` 把 WGS-84 转为 BD-09。

---

## 6. 数据流（最终状态）

```
Android GPS
    │ WGS-84
    ▼
window.__hr_real_coords_wgs
    │ WGS-84
    ├──► AMap 面板 ──wgs84ToGcj02()──► GCJ-02
    ├──► Angular scope 注入 ──wgs84ToGcj02()──► GCJ-02
    ├──► Was.exec / execA / callbackResult ──wgs84ToBd09()──► BD-09
    │         │
    │         ▼
    │    SDK 用 BD-09 显示页面（正确）
    │         │
    │         ▼
    │    position.gcj.encryptwgs
    │    （请求体被 XHR 拦截器修正为 GCJ-02）
    │         │
    │         ▼
    │    服务端返回加密 WGS-84
    │         │
    │         ▼
    └──► attend.signin.geocheck
         （XHR 拦截器把坐标统一替换为 GCJ-02 + 重新计算 hash）
                │
                ▼
         服务端按 GCJ-02 校验通过
```

---

## 7. 排查过程中的关键日志与线索

| 日志/线索 | 含义 |
|-----------|------|
| `kk gcj translate wgs success` | SDK 完成坐标转换的调试日志，来自 `common-30f95037f6a18cffff89.js` |
| `geo:in kk` → `kk_success` | SDK 走 KK 原生定位桥，配置成功 |
| `{longitude: NaN, latitude: NaN, accuracy: 40}` | `Was.exec` 被调用时真实坐标尚未就绪 |
| `POST /api/position.gcj.encryptwgs 500` | 请求体坐标无效或坐标系错误 |
| `执行api错误:position.gcj.encryptwgs 错误号:...` | 页面弹出的错误提示 |
| `[HR] API 请求已修正为 GCJ-02: attend.signin.geocheck...` | XHR 拦截器工作正常，最终 geocheck 坐标正确 |

---

## 8. 给其他 Agent 的提示

1. **不要假设 KK SDK 使用 WGS-84 或 GCJ-02。** Landray KK 原生定位返回 BD-09，任何直接给 SDK 的坐标都应先转 BD-09。

2. **服务端校验用 GCJ-02。** `attend.signin.geocheck` 和 `position.gcj.encryptwgs` 都需要 GCJ-02。如果只在 `Was.exec` 层修正，服务端请求仍会错。

3. **坐标可能异步到达。** `Was.exec` 被调用时 `__hr_real_coords_wgs` 可能为空。处理 `position.gcj.encryptwgs` 时要能等待或兜底替换无效坐标。

4. **显示与校验是两条路径。** 页面显示依赖 SDK 对 `Was.exec` 返回值的处理；服务端校验依赖 XHR 请求体。两条路径要分别验证。

5. **高德地图用 GCJ-02。** 任何 AMap 相关操作（标记、中心点、逆地理编码）必须保持 GCJ-02。

6. **调试时重点观察这些文件/接口：**
   - `common-30f95037f6a18cffff89.js`：坐标转换模块
   - `common.framework.mobile-*.js`：KK 主框架（定位、WiFi 检查）
   - `lib.kk.sdk-*.js`：`Was.exec` 调用方
   - `/api/position.gcj.encryptwgs`：GCJ-02 加密接口
   - `/api/attend.signin.geocheck`：打卡校验接口

---

## 9. 相关文件

- `D:\kkdecompiler\hr-punch-apk\app\src\main\assets\inject.js`
- `D:\kkdecompiler\hr-punch-apk\app\src\main\java\com\hrpunch\Js2JavaProxyBridge.kt`
- `D:\kkdecompiler\hr-punch-apk\app\src\main\java\com\hrpunch\LocationHelper.kt`

---

## 10. 已验证通过的 APK

最终稳定版本：
- `D:\kkdecompiler\KQAssistant-v1.2.5-fixencrypt.apk`

验证项：
- [x] 页面显示定位准确
- [x] 不再弹出 `position.gcj.encryptwgs` 错误
- [x] 相机/图片选择正常
- [x] 打卡/签入通过
