package com.hrpunch

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var imagePluginHandler: ImagePluginHandler
    private lateinit var locationHelper: LocationHelper

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

        // 启动真实定位（请求权限 + 每 5 秒刷新）
        locationHelper.start(this)

        webView.loadUrl("https://hr-mobile.hncsmtr.com:7443/login?sso=customer_sso&next=/&j_lang=zh-CN")
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
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportZoom(true)
            userAgentString = getSavedUA()
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, true)
        }

        webView.addJavascriptInterface(JSBridge(this, locationHelper) { newUa ->
            runOnUiThread {
                webView.settings.userAgentString = newUa
                webView.loadUrl(webView.url ?: "https://hr-mobile.hncsmtr.com:7443/login?sso=customer_sso&next=/&j_lang=zh-CN")
            }
        }, "HRBridge")

        // 注册 KK 原生桥接 __js2java_proxy，处理 gps 定位插件和图片插件
        imagePluginHandler = ImagePluginHandler(this, webView)
        webView.addJavascriptInterface(Js2JavaProxyBridge(webView, imagePluginHandler), "__js2java_proxy")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                injectScript()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectScript()
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

    private fun injectScript() {
        try {
            val script = assets.open("inject.js")
                .bufferedReader()
                .use { it.readText() }
            webView.evaluateJavascript(script, null)
        } catch (e: Exception) {
            android.util.Log.e("HRPunch", "注入脚本失败", e)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
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
