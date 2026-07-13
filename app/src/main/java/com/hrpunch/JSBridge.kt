package com.hrpunch

import android.content.Context
import android.content.SharedPreferences
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

class JSBridge(
    private val context: Context,
    private val locationHelper: LocationHelper? = null,
    private val onUaChanged: ((String) -> Unit)? = null
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
}
