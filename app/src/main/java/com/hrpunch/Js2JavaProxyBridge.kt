package com.hrpunch

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.lang.ref.WeakReference

class Js2JavaProxyBridge(
    webView: WebView,
    private val imagePluginHandler: ImagePluginHandler
) {

    private val webViewRef = WeakReference(webView)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val fakeAccuracy = 10

    @JavascriptInterface
    fun execPlugin(plugin: String, method: String, args: String, callbackID: String, ability: String) {
        if (plugin == "gps" && (method == "getLocation" || method == "getCurrentPosition")) {
            mainHandler.post {
                webViewRef.get()?.let { wv ->
                    val js = buildGpsCallbackJs(callbackID)
                    wv.evaluateJavascript(js, null)
                }
            }
            return
        }
        if (plugin == "image" && method == "getPicture") {
            mainHandler.post {
                imagePluginHandler.launchPicker(args, callbackID)
            }
            return
        }
    }

    @JavascriptInterface
    fun notifyEventResult(id: String, result: Boolean) {
        // No-op stub
    }

    private fun buildGpsCallbackJs(callbackID: String): String {
        // 递归所有 frame，找到注册了 callback 的 Was 对象并触发回调
        // 如果某 frame 没有 Was，则创建一个最小桩（不覆盖已有定义）
        return """
            (function() {
                function ensureWas(win) {
                    if (typeof win.Was === 'undefined') {
                        win.Was = {
                            callbackID: 0,
                            callbacks: {},
                            exec: function(p, m, a, s, f) { win.Was.execA(p, m, a, s, f, ''); },
                            execA: function(p, m, a, s, f, ab) {
                                var id = p + win.Was.callbackID++;
                                if (s || f) win.Was.callbacks[id] = {success: s, fail: f};
                                if (typeof win.__js2java_proxy !== 'undefined') {
                                    win.__js2java_proxy.execPlugin(p, m, a, id, ab);
                                }
                            },
                            callbackResult: function(id, args, keep) {
                                var cb = win.Was.callbacks[id];
                                if (cb) {
                                    if (!(keep && keep == 1)) delete win.Was.callbacks[id];
                                    if (cb.success) cb.success(args);
                                }
                            },
                            callbackError: function(id, c, msg) {
                                var cb = win.Was.callbacks[id];
                                if (cb) { delete win.Was.callbacks[id]; if (cb.fail) cb.fail(c, msg); }
                            }
                        };
                    }
                }
                function deliver(win, id, pos) {
                    try {
                        ensureWas(win);
                        if (win.Was.callbacks[id]) {
                            win.Was.callbackResult(id, pos, 0);
                            return true;
                        }
                    } catch(e) {}
                    for (var i = 0; i < win.frames.length; i++) {
                        if (deliver(win.frames[i], id, pos)) return true;
                    }
                    return false;
                }
                var useFake = window.__hr_use_fake;
                var coords = null;
                if (useFake) {
                    coords = window.__hr_fake_coords_bd09;
                } else {
                    var real = window.__hr_real_coords_wgs;
                    if (real && typeof wgs84ToBd09 === 'function') {
                        coords = wgs84ToBd09(real.lng, real.lat);
                    }
                }
                if (!coords) {
                    // 没有有效坐标时返回错误，不再回退到硬编码坐标
                    ensureWas(window);
                    var cb = window.Was.callbacks['$callbackID'];
                    if (cb && cb.fail) cb.fail(-1, 'no valid location');
                    return;
                }
                var delivered = deliver(window, '$callbackID', {longitude: coords.lng, latitude: coords.lat, accuracy: $fakeAccuracy});
                if (!delivered) {
                    // 兜底：在顶层创建 Was 并调用 callbackResult（即使 callback 未注册也尝试）
                    ensureWas(window);
                    window.Was.callbackResult('$callbackID', {longitude: coords.lng, latitude: coords.lat, accuracy: $fakeAccuracy}, 0);
                }
            })();
        """.trimIndent()
    }
}
