package com.hrpunch

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

class LocationHelper(
    private val context: Context,
    private val webView: WebView
) {
    companion object {
        const val REQUEST_LOCATION_PERMISSION = 9004
    }

    private val locationManager: LocationManager? =
        context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    private var activityRef: WeakReference<Activity>? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun bindActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    /** 请求权限，成功后取一次位置（先推缓存、再拉一次最新），不再持续轮询 */
    fun start(activity: Activity? = null) {
        val act = activity ?: activityRef?.get() ?: return
        activityRef = WeakReference(act)

        if (ContextCompat.checkSelfPermission(act, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                act,
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                REQUEST_LOCATION_PERMISSION
            )
            return
        }
        acquireOnce()
    }

    /** 权限已被允许时直接取一次位置 */
    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQUEST_LOCATION_PERMISSION) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            acquireOnce()
        } else {
            toast("获取当前定位失败：位置权限被拒绝")
        }
    }

    fun stop() {
        // 单次定位模式下，不需要手动停止；保留此方法供 JS 调用兼容
    }

    @SuppressLint("MissingPermission")
    private fun acquireOnce() {
        // 1. 先推送最后一次已知位置，让页面尽快有坐标
        pushLastKnown()

        // 2. 注册一次监听：取到第一个有效坐标后立即停止，超时 15 秒自动释放
        val providers = locationManager?.getProviders(true) ?: emptyList()
        if (providers.isEmpty()) {
            toast("没有可用的定位方式，请打开 GPS 或网络定位")
            return
        }

        var obtained = false
        val oneShotListener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (!obtained) {
                    obtained = true
                    pushLocation(location.latitude, location.longitude, location.accuracy.toDouble())
                    try { locationManager?.removeUpdates(this) } catch (_: Exception) {}
                }
            }
            @Suppress("DEPRECATION")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
        }

        // 超时保护：15 秒后还没拿到就释放
        mainHandler.postDelayed({
            if (!obtained) {
                try { locationManager?.removeUpdates(oneShotListener) } catch (_: Exception) {}
            }
        }, 15000)

        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (provider in providers) {
                try {
                    locationManager?.requestLocationUpdates(provider, 0L, 0f, oneShotListener, mainHandler.looper)
                } catch (_: Exception) {
                    // 跳过不可用的 provider
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun pushLastKnown() {
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .forEach { provider ->
                locationManager?.getLastKnownLocation(provider)?.let {
                    pushLocation(it.latitude, it.longitude, it.accuracy.toDouble())
                }
            }
    }

    private fun pushLocation(lat: Double, lng: Double, accuracy: Double) {
        mainHandler.post {
            try {
                webView.evaluateJavascript(
                    "window.__hr_on_real_location($lat, $lng, $accuracy);",
                    null
                )
            } catch (e: Exception) {
                // ignore
            }
        }
    }

    private fun toast(msg: String) {
        mainHandler.post {
            android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_SHORT).show()
        }
    }
}
