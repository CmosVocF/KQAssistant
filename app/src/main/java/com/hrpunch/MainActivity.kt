package com.hrpunch

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var imagePluginHandler: ImagePluginHandler
    private lateinit var locationHelper: LocationHelper

    // ============ 本地引导页 + 双系统（同一个 WebView、同一套 SSO Cookie） ============
    private val LAUNCHER_URL = "file:///android_asset/launcher.html"

    // 人力资源系统(KK 人力门户) -> 注入 assets/inject.js
    private val HR_HOST = "hr-mobile.hncsmtr.com"
    private val HR_URL =
        "https://hr-mobile.hncsmtr.com:7443/login?sso=customer_sso&next=/&j_lang=zh-CN"
    // 员工培训系统(wethink) -> 注入 assets/autoexam.js（需 PC 上跑 Autoexam 的 Python 后端）
    // 两个系统都走 SSO 登录，共用同一套 Cookie。
    private val EXAM_HOST = "hrt-mobile.hncsmtr.com"
    private val EXAM_URL = "https://hrt-mobile.hncsmtr.com:8085/mobile/ssoLogin?j_lang=zh-CN"

    // 镟轮数据：本地页面（作业管理 / 模型设置）
    private val XUANLUN_URL = "file:///android_asset/xuanlun.html"
    private val XUANLUN_SETTINGS_URL = "file:///android_asset/xuanlun-settings.html"
    // 镟轮数据：拍照 / 相册请求
    private val REQ_XL_PICK = 1001
    private val REQ_XL_CAMERA = 1002
    private val REQ_XL_CROP = 1003
    private val REQ_XL_CAM_PERM = 1004
    private var xlPickRequest: String? = null
    private var xlCameraUri: android.net.Uri? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 开启 WebView 远程调试，方便 Chrome DevTools 检查控制台和网络
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        progressBar = findViewById(R.id.progressBar)
        prefs = getSharedPreferences("hrpunch_config", Context.MODE_PRIVATE)

        // 先创建 locationHelper，setupWebView 需要把它注册给 JSBridge
        locationHelper = LocationHelper(this, webView)
        locationHelper.bindActivity(this)

        setupWebView()

        // 接受并持久化 Cookie：两个系统共用同一套 SSO 登录 Cookie，
        // 退出 App 再进入时尽量保持登录态。
        CookieManager.getInstance().setAcceptCookie(true)

        // 启动真实定位（请求权限 + 每 5 秒刷新）
        locationHelper.start(this)

        // 首次进入本地引导页，由用户选择进入哪个系统
        webView.loadUrl(LAUNCHER_URL)
    }

    private fun generateUA(): String {
        val androidVersion = android.os.Build.VERSION.RELEASE
        val model = android.os.Build.MODEL
        val buildId = android.os.Build.ID
        val sdkInt = android.os.Build.VERSION.SDK_INT
        val chromeMajor = when {
            sdkInt >= 34 -> (116..126).random()  // Android 14
            sdkInt >= 33 -> (106..116).random()  // Android 13
            sdkInt >= 32 -> (96..106).random()   // Android 12
            sdkInt >= 31 -> (90..100).random()   // Android 12L
            sdkInt >= 30 -> (80..90).random()    // Android 11
            sdkInt >= 29 -> (74..84).random()    // Android 10
            else -> (70..80).random()            // Android 9 及以下
        }
        val chromeMinor = (0..9).random()
        val chromePatch = (1000..5000).random()
        return "Mozilla/5.0 (Linux; Android $androidVersion; $model Build/$buildId; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/$chromeMajor.$chromeMinor.$chromePatch.0 Mobile Safari/537.36 kkPlus/v7.0.7.R.20220701,0 ekp-i-android-kk5"
    }

    private fun getSavedUA(): String {
        val saved = prefs.getString("web_ua", null)
        if (saved != null && saved.isNotEmpty()) return saved
        val generated = generateUA()
        prefs.edit().putString("web_ua", generated).apply()
        return generated
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            allowFileAccess = true   // 本地页面需要加载同目录的 css/js 与模板资源
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            // 说明: 打卡门户与考试门户都是 https, 但考试门户的 autoexam.js 需要
            //       fetch() 连 PC 上的后端 http://<局域网IP>:8765 (https 页面 -> http 请求为混合内容),
            //       因此这里放行混合内容; 后端明文流量由 network_security_config 放行。
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportZoom(true)
            userAgentString = getSavedUA()
        }

        webView.addJavascriptInterface(JSBridge(
            context = this,
            locationHelper = locationHelper,
            onUaChanged = { newUa ->
                runOnUiThread {
                    webView.settings.userAgentString = newUa
                    webView.loadUrl(webView.url ?: HR_URL)
                }
            },
            onOpenSite = { site -> runOnUiThread { openSite(site) } },
            onPickImage = { req -> runOnUiThread { startXuanlunPick(req) } },
            onRecognize = { req -> xuanlunRecognizeAsync(req) }
        ), "HRBridge")

        // 注册 KK 原生桥接 __js2java_proxy，处理 gps 定位插件和图片插件
        imagePluginHandler = ImagePluginHandler(this, webView)
        webView.addJavascriptInterface(Js2JavaProxyBridge(webView, imagePluginHandler), "__js2java_proxy")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                injectScript(url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectScript(url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    progressBar.visibility = android.view.View.VISIBLE
                    progressBar.progress = newProgress
                } else {
                    progressBar.visibility = android.view.View.GONE
                }
            }
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: android.webkit.GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }
        }
    }

    /**
     * 按当前页面 host 选择注入哪份 JS（两份脚本保持独立，互不合并）：
     *  - 打卡门户 (hr-mobile.hncsmtr.com)  -> assets/inject.js   (HR 打卡助手)
     *  - 考试门户 (hrt-mobile.hncsmtr.com) -> assets/autoexam.js (自动答题助手)
     *  - 其它页面                            不注入(例如地图外链等)
     */
    private fun injectScript(url: String?) {
        val host = try {
            android.net.Uri.parse(url ?: webView.url ?: "").host ?: ""
        } catch (e: Exception) {
            ""
        }
        val scriptName = when (host) {
            EXAM_HOST -> "autoexam.js"   // 考试门户: 答题助手
            HR_HOST -> "inject.js"       // 打卡门户: HR 打卡助手
            else -> return               // 其它页面不注入
        }
        try {
            val script = assets.open(scriptName)
                .bufferedReader()
                .use { it.readText() }
            webView.evaluateJavascript(script, null)
        } catch (e: Exception) {
            android.util.Log.e("HRPunch", "注入脚本$scriptName 失败", e)
        }
    }

    override fun onBackPressed() {
        val url = webView.url ?: ""
        // 引导页 -> 直接退出应用
        if (url.startsWith("file://")) {
            super.onBackPressed()
            return
        }
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            // 系统首页没有历史记录时，返回本地引导页
            webView.loadUrl(LAUNCHER_URL)
        }
    }

    /** 引导页桥接：切换到指定系统。 */
    private fun openSite(site: String) {
        when (site) {
            "hr" -> webView.loadUrl(HR_URL)
            "exam" -> webView.loadUrl(EXAM_URL)
            "xuanlun" -> webView.loadUrl(XUANLUN_URL)
            "xuanlun-settings" -> webView.loadUrl(XUANLUN_SETTINGS_URL)
            "home" -> webView.loadUrl(LAUNCHER_URL)
        }
    }

    /** 把当前 Cookie 强制写盘，避免进程被杀时登录态丢失。 */
    private fun flushCookies() {
        try {
            CookieManager.getInstance().flush()
        } catch (e: Exception) {
            android.util.Log.w("HRPunch", "Cookie flush 失败", e)
        }
    }

    override fun onPause() {
        super.onPause()
        flushCookies()
    }

    override fun onStop() {
        super.onStop()
        flushCookies()
    }

    override fun onDestroy() {
        flushCookies()
        super.onDestroy()
    }

    // ==================== 镟轮数据：拍照 / 相册 ====================

    private val XUANLUN_PROMPT = """
你是轨道交通轮对镟修数据识别助手。请仔细阅读这张轮对镟修测量报告照片（HEGENSCHEIDT 等设备打印），提取数据。
只输出一个 JSON 对象，不要输出解释、不要用代码块。

JSON 格式：
{
  "轮对ID": "如 04B047-4",
  "车辆ID": "如 047048",
  "车辆方向": "0 或 1（0=A-B，1=B-A）",
  "加工日期": "YYYY-MM-DD 或 null",
  "加工前": {
    "左轮": {"轮缘高度": 数值或null, "轮缘厚度": 数值或null, "直径": 数值或null, "径向跳动量": 数值或null},
    "右轮": {"轮缘高度": 数值或null, "轮缘厚度": 数值或null, "直径": 数值或null, "径向跳动量": 数值或null}
  },
  "加工后": {
    "左轮": {"轮缘高度": 数值或null, "轮缘厚度": 数值或null, "直径": 数值或null, "径向跳动量": 数值或null},
    "右轮": {"轮缘高度": 数值或null, "轮缘厚度": 数值或null, "直径": 数值或null, "径向跳动量": 数值或null}
  }
}

要求：
1. 数值保留照片上的小数位数（如 29.85），不要四舍五入；
2. 照片里有"加工前测量值"和"加工后测量值"两组，分别填入"加工前"/"加工后"；
3. "左轮"/"右轮"按照片上的左、右列读取；
4. 找不到的字段填 null；
5. 只输出 JSON。
""".trimIndent()

    private fun xuanlunRecognizeAsync(requestJson: String) {
        Thread {
            val out = org.json.JSONObject()
            try {
                val req = org.json.JSONObject(requestJson)
                val imagePath = req.optString("imagePath")
                out.put("axle", req.optString("axle"))
                out.put("section", req.optString("section"))
                out.put("jobId", req.optString("jobId"))

                val cfg = try {
                    org.json.JSONObject(prefs.getString("xuanlun_models", "{}"))
                } catch (e: Exception) { org.json.JSONObject() }
                val candidates = buildXlCandidates(cfg)
                if (candidates.isEmpty()) throw IllegalStateException("未配置模型：请先在启动页 ⚙ 中添加服务商与可用模型")

                val file = java.io.File(imagePath)
                if (!file.exists()) throw IllegalStateException("图片不存在：" + imagePath)
                val b64 = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
                val dataUrl = "data:image/jpeg;base64,$b64"

                var lastError = ""
                for (c in candidates) {
                    val reasoning = c.optString("reasoning")
                    val attempts = if (reasoning.isNotEmpty()) listOf(reasoning, "") else listOf("")
                    for (r in attempts) {
                        try {
                            val parsed = xlChatOnce(c, dataUrl, r)
                            out.put("ok", true).put("data", parsed).put("model", c.optString("model"))
                            deliverXuanlunRecognized(out)
                            return@Thread
                        } catch (e: Exception) {
                            lastError = "[" + c.optString("model") + "] " + (e.message ?: "识别失败")
                        }
                    }
                }
                out.put("ok", false).put("error", lastError)
            } catch (e: Exception) {
                out.put("ok", false).put("error", e.message ?: "识别异常")
            }
            deliverXuanlunRecognized(out)
        }.start()
    }

    private fun xlChatOnce(c: org.json.JSONObject, dataUrl: String, reasoning: String): org.json.JSONObject {
        val body = org.json.JSONObject()
        body.put("model", c.optString("model"))
        val content = org.json.JSONArray()
        content.put(org.json.JSONObject().put("type", "text").put("text", XUANLUN_PROMPT))
        content.put(org.json.JSONObject().put("type", "image_url")
            .put("image_url", org.json.JSONObject().put("url", dataUrl)))
        body.put("messages", org.json.JSONArray().put(
            org.json.JSONObject().put("role", "user").put("content", content)))
        body.put("max_tokens", 2048)
        body.put("temperature", 0.1)
        if (reasoning.isNotEmpty()) body.put("reasoning_effort", reasoning)
        val resp = xlPostJson(c.optString("base") + "/chat/completions", body.toString(), c.optString("key"))
        val txt = resp.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
            ?.optString("content") ?: ""
        if (txt.isBlank()) throw IllegalStateException("模型返回空内容")
        return parseJsonLoose(txt)
    }

    private fun buildXlCandidates(cfg: org.json.JSONObject): List<org.json.JSONObject> {
        val lib = cfg.optJSONArray("library") ?: return emptyList()
        val provs = cfg.optJSONArray("providers") ?: return emptyList()
        fun findById(arr: org.json.JSONArray, id: String?): org.json.JSONObject? {
            if (id.isNullOrEmpty()) return null
            for (k in 0 until arr.length()) {
                val o = arr.optJSONObject(k) ?: continue
                if (o.optString("id") == id) return o
            }
            return null
        }
        val out = ArrayList<org.json.JSONObject>()
        for (id in listOf(cfg.optString("current"), cfg.optString("fallback"))) {
            val l = findById(lib, id) ?: continue
            val p = findById(provs, l.optString("providerId")) ?: continue
            out.add(org.json.JSONObject()
                .put("model", l.optString("modelId"))
                .put("base", p.optString("baseUrl").trimEnd('/'))
                .put("key", p.optString("apiKey"))
                .put("reasoning", l.optString("reasoning")))
        }
        return out
    }

    private fun xlPostJson(url: String, body: String, apiKey: String): org.json.JSONObject {
        val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 20000
        conn.readTimeout = 150000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        conn.setRequestProperty("Accept", "application/json")
        if (apiKey.isNotBlank()) conn.setRequestProperty("Authorization", "Bearer " + apiKey.trim())
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        conn.disconnect()
        if (code !in 200..299) throw IllegalStateException("HTTP " + code + "：" + text.take(300))
        return org.json.JSONObject(text)
    }

    private fun parseJsonLoose(text: String): org.json.JSONObject {
        var s = text.trim()
        if (s.startsWith("```")) {
            s = s.removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
        }
        val i = s.indexOf('{')
        val j = s.lastIndexOf('}')
        if (i >= 0 && j > i) s = s.substring(i, j + 1)
        return org.json.JSONObject(s)
    }

    private fun deliverXuanlunRecognized(json: org.json.JSONObject) {
        runOnUiThread {
            webView.evaluateJavascript("window.__xuanlunRecognized(" + json.toString() + ")", null)
        }
    }

    private fun startXuanlunPick(requestJson: String) {
        xlPickRequest = requestJson
        android.app.AlertDialog.Builder(this)
            .setTitle("选择照片")
            .setItems(arrayOf("拍照", "从相册选择")) { _, which ->
                when (which) {
                    0 -> openXuanlunCamera()
                    1 -> openXuanlunGallery()
                }
            }
            .show()
    }

    private fun openXuanlunCamera() {
        val dir = java.io.File(cacheDir, "pictures")
        dir.mkdirs()
        val f = java.io.File(dir, "cap_" + System.currentTimeMillis() + ".jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        xlCameraUri = uri
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            this, android.Manifest.permission.CAMERA
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) startXuanlunCameraIntent(uri) else requestXuanlunCameraPermission()
    }

    private fun startXuanlunCameraIntent(uri: android.net.Uri) {
        val i = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        try {
            startActivityForResult(i, REQ_XL_CAMERA)
        } catch (e: Exception) {
            deliverXuanlunImage(null, "无法打开相机：" + (e.message ?: ""))
        }
    }

    private fun requestXuanlunCameraPermission() {
        androidx.core.app.ActivityCompat.requestPermissions(
            this, arrayOf(android.Manifest.permission.CAMERA), REQ_XL_CAM_PERM
        )
    }

    private fun openXuanlunGallery() {
        val i = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        try {
            startActivityForResult(i, REQ_XL_PICK)
        } catch (e: Exception) {
            deliverXuanlunImage(null, "无法打开相册：" + (e.message ?: ""))
        }
    }

    private fun decodeSampled(uri: android.net.Uri, maxSize: Int): Bitmap {
        val opts = android.graphics.BitmapFactory.Options()
        opts.inJustDecodeBounds = true
        contentResolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, opts) }
        var sample = 1
        while (opts.outWidth / sample > maxSize || opts.outHeight / sample > maxSize) sample *= 2
        val o2 = android.graphics.BitmapFactory.Options()
        o2.inSampleSize = sample
        return contentResolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, o2) }
            ?: throw IllegalStateException("无法解码图片")
    }

    private fun xuanlunHandleResult(uri: android.net.Uri?) {
        if (uri == null) { deliverXuanlunImage(null, "未获取到照片"); return }
        try {
            val req = try { org.json.JSONObject(xlPickRequest ?: "{}") } catch (e: Exception) { org.json.JSONObject() }
            val jobId = req.optString("jobId")
            val section = req.optString("section")
            val axle = req.optString("axle")
            val bmp = decodeSampled(uri, 1600)
            val dir = java.io.File(filesDir, "xuanlun/$jobId/$section")
            dir.mkdirs()
            val orig = java.io.File(dir, "${axle}_orig.jpg")
            java.io.FileOutputStream(orig).use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            bmp.recycle()
            val out = java.io.File(dir, "$axle.jpg")
            // 进入透视校正页（拖动四角确认）
            val i = Intent(this, XuanlunCropActivity::class.java)
            i.putExtra(XuanlunCropActivity.EXTRA_IN, orig.absolutePath)
            i.putExtra(XuanlunCropActivity.EXTRA_OUT, out.absolutePath)
            startActivityForResult(i, REQ_XL_CROP)
        } catch (e: Exception) {
            deliverXuanlunImage(null, "处理图片失败：" + (e.message ?: ""))
        }
    }

    private fun deliverXuanlunImage(path: String?, error: String?, dataUrl: String? = null, origPath: String? = null) {
        val json = org.json.JSONObject()
        json.put("ok", path != null)
        if (path != null) json.put("path", path)
        if (origPath != null) json.put("origPath", origPath)
        if (dataUrl != null) json.put("dataUrl", dataUrl)
        if (error != null) json.put("error", error)
        try { json.put("request", org.json.JSONObject(xlPickRequest ?: "{}")) } catch (e: Exception) { }
        runOnUiThread {
            webView.evaluateJavascript("window.__xuanlunImagePicked(" + json.toString() + ")", null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_XL_CROP) {
            if (resultCode != RESULT_OK) { deliverXuanlunImage(null, "已取消校正"); return }
            val p = data?.getStringExtra("out") ?: ""
            val f = java.io.File(p)
            if (!f.exists()) { deliverXuanlunImage(null, "校正结果不存在"); return }
            try {
                val b64 = android.util.Base64.encodeToString(f.readBytes(), android.util.Base64.NO_WRAP)
                val req = try { org.json.JSONObject(xlPickRequest ?: "{}") } catch (e: Exception) { org.json.JSONObject() }
                val orig = java.io.File(
                    java.io.File(filesDir, "xuanlun/${req.optString("jobId")}/${req.optString("section")}"),
                    req.optString("axle") + "_orig.jpg"
                )
                deliverXuanlunImage(f.absolutePath, null, "data:image/jpeg;base64,$b64", orig.absolutePath)
            } catch (e: Exception) {
                deliverXuanlunImage(null, "读取校正结果失败：" + (e.message ?: ""))
            }
            return
        }
        if (requestCode == REQ_XL_PICK || requestCode == REQ_XL_CAMERA) {
            if (resultCode != RESULT_OK) {
                xlCameraUri = null
                deliverXuanlunImage(null, "已取消")
                return
            }
            val uri = if (requestCode == REQ_XL_CAMERA) xlCameraUri else data?.data
            xlCameraUri = null
            xuanlunHandleResult(uri)
            return
        }
        if (::imagePluginHandler.isInitialized) {
            imagePluginHandler.handleActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_XL_CAM_PERM) {
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (granted) {
                xlCameraUri?.let { startXuanlunCameraIntent(it) } ?: deliverXuanlunImage(null, "相机地址丢失")
            } else {
                android.widget.Toast.makeText(this, "未授予相机权限，请从相册选择", android.widget.Toast.LENGTH_SHORT).show()
            }
            return
        }
        if (::imagePluginHandler.isInitialized) {
            imagePluginHandler.onRequestPermissionsResult(requestCode, permissions, grantResults)
        }
        if (::locationHelper.isInitialized) {
            locationHelper.onRequestPermissionsResult(requestCode, grantResults)
        }
    }
}
