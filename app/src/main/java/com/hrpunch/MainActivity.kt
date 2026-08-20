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
            allowFileAccess = false
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
            onOpenSite = { site -> runOnUiThread { openSite(site) } }
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

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
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
        if (::imagePluginHandler.isInitialized) {
            imagePluginHandler.onRequestPermissionsResult(requestCode, permissions, grantResults)
        }
        if (::locationHelper.isInitialized) {
            locationHelper.onRequestPermissionsResult(requestCode, grantResults)
        }
    }
}
