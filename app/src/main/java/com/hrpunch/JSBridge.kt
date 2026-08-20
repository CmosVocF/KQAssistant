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
    private val onOpenSite: ((String) -> Unit)? = null
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

    /** 本地引导页调用：切换到 'hr' / 'exam' / 'home'。 */
    @JavascriptInterface
    fun openSite(site: String) {
        onOpenSite?.invoke(site)
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
