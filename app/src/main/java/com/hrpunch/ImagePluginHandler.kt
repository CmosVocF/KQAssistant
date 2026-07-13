package com.hrpunch

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ImagePluginHandler(
    private val activity: Activity,
    private val webView: WebView
) {
    companion object {
        const val REQUEST_CAMERA = 9001
        const val REQUEST_GALLERY = 9002
        const val REQUEST_CAMERA_PERMISSION = 9003
    }

    private var pendingCallbackID: String? = null
    private var pendingDestinationType: String = "file"
    private var pendingQuality: Int = 100
    private var pendingTargetWidth: Int = 500
    private var pendingTargetHeight: Int = 500
    private var pendingEncoding: Bitmap.CompressFormat = Bitmap.CompressFormat.JPEG
    private var pendingExifFlag: Boolean = false
    private var cameraOutputUri: Uri? = null

    fun launchPicker(argsJson: String?, callbackID: String) {
        pendingCallbackID = callbackID
        parseArgs(argsJson)
        Log.d("HRPunch", "launchPicker callbackID=$callbackID args=$argsJson")

        AlertDialog.Builder(activity)
            .setTitle("选择照片")
            .setItems(arrayOf("拍照", "从相册选择")) { _, which ->
                when (which) {
                    0 -> openCamera()
                    1 -> openGallery()
                }
            }
            .setCancelable(false)
            .show()
    }

    private fun parseArgs(argsJson: String?) {
        try {
            val args = JSONObject(argsJson ?: "{}")
            pendingDestinationType = args.optString("destinationType", "file")
            pendingQuality = args.optInt("quality", 100).coerceIn(1, 100)
            pendingTargetWidth = args.optInt("targetWidth", 500).coerceAtLeast(1)
            pendingTargetHeight = args.optInt("targetHeight", 500).coerceAtLeast(1)
            pendingExifFlag = args.optBoolean("exifFlag", false)
            // 网页 KK 路径对 data 返回取 imageData.substring(22)，期望 PNG 前缀
            pendingEncoding = when (args.optString("encodingType", "png").lowercase(Locale.ROOT)) {
                "jpeg", "jpg" -> Bitmap.CompressFormat.JPEG
                else -> Bitmap.CompressFormat.PNG
            }
        } catch (e: Exception) {
            Log.e("HRPunch", "解析图片参数失败", e)
        }
    }

    private fun openCamera() {
        val file = createOutputFile()
        val uri = FileProvider.getUriForFile(
            activity,
            "${activity.packageName}.fileprovider",
            file
        )
        cameraOutputUri = uri
        Log.d("HRPunch", "openCamera uri=$uri file=${file.absolutePath}")
        when (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA)) {
            PackageManager.PERMISSION_GRANTED -> startCameraIntent(uri)
            else -> {
                ActivityCompat.requestPermissions(
                    activity,
                    arrayOf(Manifest.permission.CAMERA),
                    REQUEST_CAMERA_PERMISSION
                )
            }
        }
    }

    private fun startCameraIntent(uri: Uri) {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        intent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        Log.d("HRPunch", "startCameraIntent uri=$uri")
        try {
            activity.startActivityForResult(intent, REQUEST_CAMERA)
        } catch (e: Exception) {
            Log.e("HRPunch", "启动相机失败", e)
            sendError("启动相机失败: ${e.message}")
        }
    }

    fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        Log.d("HRPunch", "onRequestPermissionsResult requestCode=$requestCode grantResults=${grantResults.joinToString()}")
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                cameraOutputUri?.let { startCameraIntent(it) } ?: sendError("相机 URI 丢失")
            } else {
                sendError("相机权限被拒绝")
            }
        }
    }

    private fun openGallery() {
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        Log.d("HRPunch", "openGallery")
        try {
            activity.startActivityForResult(intent, REQUEST_GALLERY)
        } catch (e: Exception) {
            Log.e("HRPunch", "启动相册失败", e)
            sendError("启动相册失败: ${e.message}")
        }
    }

    private fun createOutputFile(): File {
        val dir = File(activity.cacheDir, "pictures").apply { mkdirs() }
        val timeStamp = SimpleDateFormat("yyyyMMddHHmmss", Locale.getDefault()).format(Date())
        val suffix = if (pendingEncoding == Bitmap.CompressFormat.PNG) ".png" else ".jpg"
        return File(dir, "IMG_$timeStamp$suffix")
    }

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        Log.d("HRPunch", "handleActivityResult requestCode=$requestCode resultCode=$resultCode data=${data?.data}")
        if (resultCode != Activity.RESULT_OK) {
            sendError("用户取消")
            return
        }
        val uri = when (requestCode) {
            REQUEST_CAMERA -> cameraOutputUri
            REQUEST_GALLERY -> data?.data
            else -> null
        }
        if (uri == null) {
            Log.e("HRPunch", "无法获取图片 uri")
            sendError("无法获取图片")
            return
        }
        processImage(uri)
    }

    private fun processImage(uri: Uri) {
        Log.d("HRPunch", "processImage uri=$uri pendingCallbackID=$pendingCallbackID")
        Thread {
            try {
                val source = loadAndRotateBitmap(uri)
                val scaled = scaleBitmap(source, pendingTargetWidth, pendingTargetHeight)
                val timeStamp = SimpleDateFormat("yyyyMMddHHmmss", Locale.getDefault()).format(Date())
                val ext = if (pendingEncoding == Bitmap.CompressFormat.PNG) "png" else "jpg"
                val mime = if (pendingEncoding == Bitmap.CompressFormat.PNG) "image/png" else "image/jpeg"

                val outFile = File(activity.cacheDir, "pictures/IMG_${timeStamp}.$ext")
                outFile.parentFile?.mkdirs()
                FileOutputStream(outFile).use { out ->
                    scaled.compress(pendingEncoding, pendingQuality, out)
                }

                // EXIF GPS 需要读取 WebView 中的模拟坐标，必须在主线程异步读取
                Handler(Looper.getMainLooper()).post {
                    if (pendingExifFlag && pendingEncoding == Bitmap.CompressFormat.JPEG) {
                        injectExifAndFinish(scaled, outFile, source, mime, timeStamp)
                    } else {
                        finishSendResult(scaled, outFile, source, mime, timeStamp)
                    }
                }
            } catch (e: Exception) {
                Log.e("HRPunch", "处理图片失败", e)
                sendError(e.message ?: "处理失败")
            }
        }.start()
    }

    private fun injectExifAndFinish(scaled: Bitmap, outFile: File, source: Bitmap, mime: String, timeStamp: String) {
        webView.evaluateJavascript("(function(){ var c = window.__hr_fake_coords_wgs; return c ? c.lng + ',' + c.lat : ''; })();") { result ->
            try {
                val coordsStr = result?.trim('"') ?: ""
                if (coordsStr.isNotEmpty() && coordsStr != "null") {
                    val parts = coordsStr.split(',')
                    if (parts.size == 2) {
                        val lng = parts[0].toDoubleOrNull() ?: 0.0
                        val lat = parts[1].toDoubleOrNull() ?: 0.0
                        if (lng != 0.0 || lat != 0.0) {
                            writeExifGps(outFile.absolutePath, lat, lng)
                        } else {
                            Log.d("HRPunch", "未写入 EXIF GPS：坐标为 0")
                        }
                    }
                } else {
                    Log.d("HRPunch", "未写入 EXIF GPS：无模拟坐标")
                }
            } catch (e: Exception) {
                Log.e("HRPunch", "读取假坐标写入 EXIF 失败", e)
            }
            finishSendResult(scaled, outFile, source, mime, timeStamp)
        }
    }

    private fun finishSendResult(scaled: Bitmap, outFile: File, source: Bitmap, mime: String, timeStamp: String) {
        if (pendingDestinationType == "data") {
            val base64 = ByteArrayOutputStream().use { bos ->
                scaled.compress(pendingEncoding, pendingQuality, bos)
                Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
            }
            val result = JSONObject().apply {
                put("imageData", "data:$mime;base64,$base64")
                // 兼容旧版 KK SDK wrapper（它会读取 retDataStr 字段）
                put("retDataStr", base64)
            }
            Log.d("HRPunch", "processImage success data length=${base64.length}")
            sendSuccess(result)
        } else {
            val result = JSONObject().apply {
                put("imageURI", Uri.fromFile(outFile).toString())
                put("imageFileOSPath", outFile.absolutePath)
                put("imageTime", timeStamp)
            }
            sendSuccess(result)
        }
        if (scaled != source) scaled.recycle()
        source.recycle()
    }

    private fun loadAndRotateBitmap(uri: Uri): Bitmap {
        val bitmap = activity.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it)
        } ?: throw IllegalStateException("无法解码图片")
        val rotation = getRotation(uri)
        return if (rotation != 0) {
            val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                .also { if (it != bitmap) bitmap.recycle() }
        } else bitmap
    }

    private fun getRotation(uri: Uri): Int {
        return try {
            activity.contentResolver.openInputStream(uri)?.use { stream ->
                val exif = ExifInterface(stream)
                when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90
                    ExifInterface.ORIENTATION_ROTATE_180 -> 180
                    ExifInterface.ORIENTATION_ROTATE_270 -> 270
                    else -> 0
                }
            } ?: 0
        } catch (e: Exception) { 0 }
    }

    private fun scaleBitmap(bitmap: Bitmap, targetWidth: Int, targetHeight: Int): Bitmap {
        if (bitmap.width <= targetWidth && bitmap.height <= targetHeight) return bitmap
        val ratio = minOf(
            targetWidth.toFloat() / bitmap.width,
            targetHeight.toFloat() / bitmap.height
        )
        val newWidth = (bitmap.width * ratio).toInt()
        val newHeight = (bitmap.height * ratio).toInt()
        return Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
    }

    private fun writeExifGps(path: String, lat: Double, lng: Double) {
        try {
            val exif = ExifInterface(path)
            exif.setAttribute(ExifInterface.TAG_GPS_LATITUDE, convert(lat))
            exif.setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, if (lat >= 0) "N" else "S")
            exif.setAttribute(ExifInterface.TAG_GPS_LONGITUDE, convert(lng))
            exif.setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, if (lng >= 0) "E" else "W")
            exif.saveAttributes()
        } catch (e: Exception) {
            Log.e("HRPunch", "写入 EXIF GPS 失败", e)
        }
    }

    private fun convert(coord: Double): String {
        val abs = kotlin.math.abs(coord)
        val deg = abs.toInt()
        val min = ((abs - deg) * 60).toInt()
        val sec = (((abs - deg) * 60 - min) * 60 * 1000).toInt()
        return "$deg/1,$min/1,$sec/1000"
    }

    private fun sendSuccess(result: JSONObject) {
        Log.d("HRPunch", "sendSuccess callbackID=$pendingCallbackID")
        Handler(Looper.getMainLooper()).post {
            pendingCallbackID?.let { id ->
                webView.evaluateJavascript("Was.callbackResult('$id', ${result.toString()}, 0);", null)
            }
            reset()
        }
    }

    private fun sendError(msg: String) {
        Log.d("HRPunch", "sendError callbackID=$pendingCallbackID msg=$msg")
        Handler(Looper.getMainLooper()).post {
            pendingCallbackID?.let { id ->
                val escaped = msg.replace("'", "\\'")
                webView.evaluateJavascript("Was.callbackError('$id', -1, '$escaped');", null)
            }
            reset()
        }
    }

    private fun reset() {
        pendingCallbackID = null
        cameraOutputUri = null
    }
}
