package com.hrpunch

import android.content.Context
import android.content.SharedPreferences
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

class JSBridge(
    private val context: Context,
    private val locationHelper: LocationHelper? = null,
    private val onUaChanged: ((String) -> Unit)? = null,
    private val onOpenSite: ((String) -> Unit)? = null,
    private val onPickImage: ((String) -> Unit)? = null,
    private val onRecognize: ((String) -> Unit)? = null
) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("hrpunch_config", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun getPresets(): String? {
        val json = prefs.getString("presets", null)
        return if (json != null && json.isNotEmpty()) json else null
    }


    @JavascriptInterface
    fun savePresets(json: String) {
        prefs.edit().putString("presets", json).apply()
    }

    @JavascriptInterface
    fun getUserAgent(): String {
        return prefs.getString("web_ua", "") ?: ""
    }

    @JavascriptInterface
    fun setUserAgent(ua: String) {
        prefs.edit().putString("web_ua", ua).apply()
        onUaChanged?.invoke(ua)
    }

    @JavascriptInterface
    fun toast(msg: String) {
        android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_SHORT).show()
    }

    @JavascriptInterface
    fun startRealLocation() {
        locationHelper?.start(null)
    }

    @JavascriptInterface
    fun stopRealLocation() {
        locationHelper?.stop()
    }

    /** App 原生持久化后端地址：不随页面 http/https 不同源切换而丢失（autoexam 面板用）。 */
    @JavascriptInterface
    fun getApiUrl(): String? {
        return prefs.getString("backend_api_url", null)
    }

    @JavascriptInterface
    fun setApiUrl(url: String) {
        prefs.edit().putString("backend_api_url", (url ?: "").trim()).apply()
    }

    /** 本地引导页调用：切换到 'hr' / 'exam' / 'home' / 'xuanlun' / 'xuanlun-settings'。 */
    @JavascriptInterface
    fun openSite(site: String) {
        onOpenSite?.invoke(site)
    }

    // ==================== 镟轮数据：本机持久化 ====================

    /** 镟轮数据：作业与填表数据（JSON 字符串）。 */
    @JavascriptInterface
    fun getXuanlunData(): String? {
        return prefs.getString("xuanlun_data", null)
    }

    @JavascriptInterface
    fun setXuanlunData(json: String) {
        prefs.edit().putString("xuanlun_data", (json ?: "")).apply()
    }

    /** 镟轮数据：大模型配置（baseUrl/apiKey/model/参数，JSON 字符串）。 */
    @JavascriptInterface
    fun getLlmConfig(): String? {
        return prefs.getString("xuanlun_llm", null)
    }

    @JavascriptInterface
    fun setLlmConfig(json: String) {
        prefs.edit().putString("xuanlun_llm", (json ?: "")).apply()
    }

    /** 镟轮数据：模型配置（服务商 / 模型库 / 当前与备选模型，JSON 字符串）。 */
    @JavascriptInterface
    fun getXuanlunModels(): String? {
        return prefs.getString("xuanlun_models", null)
    }

    @JavascriptInterface
    fun setXuanlunModels(json: String) {
        prefs.edit().putString("xuanlun_models", (json ?: "")).apply()
    }

    /**
     * 镟轮数据：OpenAI 兼容协议请求（Authorization: Bearer），原生发起以绕过浏览器 CORS。
     * 供「获取模型 / 测试连接 / 图片识别」使用。
     * @return JSON 字符串 {"ok":bool,"status":int,"text":"响应文本"}
     */
    @JavascriptInterface
    fun llmRequest(url: String, method: String, body: String, apiKey: String): String {
        return try {
            val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn.requestMethod = if (method.isBlank()) "GET" else method.uppercase()
            conn.connectTimeout = 20000
            conn.readTimeout = 120000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("Accept", "application/json")
            if (!apiKey.isNullOrBlank()) conn.setRequestProperty("Authorization", "Bearer " + apiKey.trim())
            val payload = body ?: ""
            if (payload.isNotEmpty()) {
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.doOutput = true
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            conn.disconnect()
            JSONObject().put("ok", code in 200..299).put("status", code).put("text", text).toString()
        } catch (e: Exception) {
            try { JSONObject().put("ok", false).put("status", 0).put("text", e.message ?: "network error").toString() }
            catch (e2: Exception) { """{"ok":false,"status":0,"text":"network error"}""" }
        }
    }

    // ==================== 镟轮数据：拍照 / 相册 / 图片读取 ====================

    /**
     * 镟轮数据：拍照或相册选择一张照片。
     * requestJson: {"jobId","section","axle","source":"camera"|"gallery"}
     * 结果异步回调到网页 window.__xuanlunImagePicked({ok,path,dataUrl,...})
     */
    @JavascriptInterface
    fun xuanlunPickImage(requestJson: String) {
        onPickImage?.invoke(requestJson)
    }

    /**
     * 镟轮数据：识别轴照片（多模态模型；主模型失败自动回退备选模型）。
     * requestJson: {"jobId","section","axle","imagePath"}
     * 结果异步回调到网页 window.__xuanlunRecognized({ok,data,model,error})
     */
    @JavascriptInterface
    fun xuanlunRecognize(requestJson: String) {
        onRecognize?.invoke(requestJson)
    }

    /** 读取已保存的图片为 dataUrl（供编辑页预览）。 */
    @JavascriptInterface
    fun xuanlunImageData(path: String): String {
        return try {
            val f = java.io.File(path)
            if (!f.exists()) {
                JSONObject().put("ok", false).put("dataUrl", "").toString()
            } else {
                val b64 = android.util.Base64.encodeToString(f.readBytes(), android.util.Base64.NO_WRAP)
                JSONObject().put("ok", true).put("dataUrl", "data:image/jpeg;base64," + b64).toString()
            }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("dataUrl", "").put("error", e.message ?: "").toString()
        }
    }

    /** 读取空白 xlsx 模板（base64），供网页用 ExcelJS 填表。 */
    @JavascriptInterface
    fun xuanlunTemplate(): String {
        return try {
            val bytes = context.assets.open("xuanlun/template.xlsx").readBytes()
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    /** 保存导出 xlsx（base64 内容）到缓存目录，返回文件路径。 */
    @JavascriptInterface
    fun xuanlunSaveXlsx(base64: String, fileName: String): String {
        return try {
            val clean = base64.substringAfter(",", base64)
            val bytes = android.util.Base64.decode(clean, android.util.Base64.DEFAULT)
            val dir = java.io.File(context.cacheDir, "xuanlun_export")
            dir.mkdirs()
            val safe = (if (fileName.isBlank()) "xuanlun.xlsx" else fileName).replace(Regex("[\\\\/:*?\"<>|]"), "_")
            val f = java.io.File(dir, safe)
            f.writeBytes(bytes)
            JSONObject().put("ok", true).put("path", f.absolutePath).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "").toString()
        }
    }

    /** 通过系统分享/另存为打开导出的 xlsx。 */
    @JavascriptInterface
    fun xuanlunShareFile(path: String): String {
        return try {
            val f = java.io.File(path)
            if (!f.exists()) {
                JSONObject().put("ok", false).put("error", "文件不存在").toString()
            } else {
                val uri = androidx.core.content.FileProvider.getUriForFile(
                    context, context.packageName + ".fileprovider", f
                )
                val i = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    putExtra(android.content.Intent.EXTRA_STREAM, uri)
                    putExtra(android.content.Intent.EXTRA_SUBJECT, f.name)
                    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                context.startActivity(android.content.Intent.createChooser(i, "保存/分享 " + f.name))
                JSONObject().put("ok", true).toString()
            }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "").toString()
        }
    }

    /**
     * App 原生网络桥：用 Android 原生发 HTTP 请求，绕过浏览器 CORS 直连后端，
     * 供 WebView 版 autoexam.js 连接公网后端（如 https://www.ep2w.fun）使用。
     * 注：addJavascriptInterface 方法运行在非 UI 线程，可安全做网络阻塞调用。
     * @param url     完整请求地址（CFG.api + path）
     * @param method  GET / POST
     * @param body    请求体 JSON 字符串（可为空）
     * @param apiKey  后端 X-API-Key（可为空）
     * @return JSON 字符串 {"ok":bool,"status":int,"text":"响应文本"}
     */
    @JavascriptInterface
    fun nativeApi(url: String, method: String, body: String, apiKey: String): String {
        return try {
            val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn.requestMethod = if (method.isBlank()) "GET" else method.uppercase()
            conn.connectTimeout = 15000
            conn.readTimeout = 20000
            conn.instanceFollowRedirects = true   // http -> https 跟随 301/308
            conn.setRequestProperty("Accept", "application/json, text/plain, */*")
            if (!apiKey.isNullOrBlank()) conn.setRequestProperty("X-API-Key", apiKey)
            val payload = body ?: ""
            if (payload.isNotEmpty()) {
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.doOutput = true
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            conn.disconnect()
            JSONObject()
                .put("ok", code in 200..299)
                .put("status", code)
                .put("text", text)
                .toString()
        } catch (e: Exception) {
            try { JSONObject().put("ok", false).put("status", 0).put("text", e.message ?: "network error").toString() }
            catch (e2: Exception) { """{"ok":false,"status":0,"text":"network error"}""" }
        }
    }
}
