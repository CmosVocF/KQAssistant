package com.hrpunch

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PointF
import android.os.Bundle
import android.widget.Button
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc

/** 镟轮照片校正页：拖动四角 → 透视校正 + 灰度增强 → 保存。 */
class XuanlunCropActivity : Activity() {

    companion object {
        const val EXTRA_IN = "in"
        const val EXTRA_OUT = "out"
    }

    private var cvReady = false
    private lateinit var cropView: CropView
    private var bmp: Bitmap? = null
    private var outPath: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_xuanlun_crop)
        cropView = findViewById(R.id.cropView)
        outPath = intent.getStringExtra(EXTRA_OUT) ?: ""
        val inPath = intent.getStringExtra(EXTRA_IN) ?: ""
        bmp = try { BitmapFactory.decodeFile(inPath) } catch (e: Exception) { null }
        val b = bmp
        if (b == null || outPath.isEmpty()) {
            Toast.makeText(this, "无法读取图片", Toast.LENGTH_SHORT).show()
            setResult(RESULT_CANCELED)
            finish()
            return
        }
        val auto = detectPaperQuad(b)
        val initial = auto ?: loadLastQuad(b)
        cropView.setBitmap(b, initial)
        Toast.makeText(
            this,
            when {
                auto != null -> "已自动识别纸张边缘，可直接确认或微调"
                initial != null -> "已套用上次框选位置，可拖动微调"
                else -> "未能自动识别，请拖动四角"
            },
            Toast.LENGTH_SHORT
        ).show()
        findViewById<Button>(R.id.btnCancel).setOnClickListener {
            setResult(RESULT_CANCELED)
            finish()
        }
        findViewById<Button>(R.id.btnOk).setOnClickListener { doCrop() }
    }

    private fun ensureOpenCv(): Boolean {
        if (cvReady) return true
        try {
            if (OpenCVLoader.initLocal()) {
                cvReady = true
                return true
            }
        } catch (e: Throwable) {
            /* try loadLibrary below */
        }
        return try {
            System.loadLibrary("opencv_java4")
            cvReady = true
            true
        } catch (e: Throwable) {
            cvReady = false
            false
        }
    }

    /**
     * 用 OpenCV 找纸张四角：CLAHE 增强 + bilateral 去噪 + Canny 边缘 + 轮廓 + 四边形拟合。
     * 参数已在样例图（IMG_20261013_170040 / 170049）上离线验证通过。
     */
    private fun detectPaperQuad(b: Bitmap): Array<PointF>? {
        if (!ensureOpenCv()) return null
        val w = b.width
        val h = b.height
        val maxSide = max(w, h)
        if (maxSide <= 200) return null
        val scale = 700f / maxSide
        if (scale >= 1f) return null
        val sw = (w * scale).toInt().coerceAtLeast(1)
        val sh = (h * scale).toInt().coerceAtLeast(1)
        var src: Mat? = null
        var gray: Mat? = null
        var enhanced: Mat? = null
        var filtered: Mat? = null
        var kernel: Mat? = null
        return try {
            src = Mat(); Utils.bitmapToMat(b, src!!)
            gray = Mat(); Imgproc.cvtColor(src, gray!!, Imgproc.COLOR_RGBA2GRAY)
            val small = Mat()
            Imgproc.resize(gray, small, Size(sw.toDouble(), sh.toDouble()))
            val clahe = Imgproc.createCLAHE(2.0, Size(8.0, 8.0))
            enhanced = Mat(); clahe.apply(small, enhanced!!)
            small.release()
            filtered = Mat(); Imgproc.bilateralFilter(enhanced, filtered!!, 7, 50.0, 50.0)
            kernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(5.0, 5.0))
            val areaMin = sw.toDouble() * sh * 0.10
            val areaMax = sw.toDouble() * sh * 0.90
            var best: Array<Point>? = null
            var bestArea = 0.0
            val pairs = arrayOf(intArrayOf(15, 45), intArrayOf(20, 60), intArrayOf(30, 90), intArrayOf(50, 150))
            for (pair in pairs) {
                val edges = Mat()
                Imgproc.Canny(filtered, edges, pair[0].toDouble(), pair[1].toDouble())
                Imgproc.dilate(edges, edges, kernel)
                val contours = ArrayList<MatOfPoint>()
                Imgproc.findContours(edges, contours, Mat(), Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
                for (c in contours) {
                    val a = Imgproc.contourArea(c)
                    if (a < areaMin || a > areaMax) continue
                    val r = Imgproc.boundingRect(c)
                    // 排除贴着图像边界的轮廓（通常是画面边框，不是纸张）
                    if (r.x <= 2 || r.y <= 2 || r.x + r.width >= sw - 2 || r.y + r.height >= sh - 2) continue
                    val c2f = MatOfPoint2f(*c.toArray())
                    val peri = Imgproc.arcLength(c2f, true)
                    var found: Array<Point>? = null
                    for (eps in doubleArrayOf(0.01, 0.02, 0.03, 0.05, 0.08)) {
                        val approx = MatOfPoint2f()
                        Imgproc.approxPolyDP(c2f, approx, eps * peri, true)
                        if (approx.total() == 4L) {
                            val mp = MatOfPoint(*approx.toArray())
                            val convex = Imgproc.isContourConvex(mp)
                            mp.release()
                            if (convex) {
                                found = approx.toArray()
                                approx.release()
                                break
                            }
                        }
                        approx.release()
                    }
                    c2f.release()
                    if (found != null && a > bestArea) {
                        bestArea = a
                        best = found
                    }
                }
                edges.release()
            }
            if (best == null) return null
            val inv = 1f / scale
            val pts = best!!.map { PointF(it.x.toFloat() * inv, it.y.toFloat() * inv) }.toTypedArray()
            orderQuad(pts)
        } catch (e: Throwable) {
            null
        } finally {
            src?.release(); gray?.release(); enhanced?.release(); filtered?.release(); kernel?.release()
        }
    }

    /** 排序为左上、右上、右下、左下。 */
    private fun orderQuad(src: Array<PointF>): Array<PointF>? {
        if (src.size != 4) return null
        var cx = 0f
        var cy = 0f
        for (p in src) { cx += p.x; cy += p.y }
        cx /= 4f; cy /= 4f
        val sorted = src.sortedBy {
            kotlin.math.atan2((it.y - cy).toDouble(), (it.x - cx).toDouble())
        }.toMutableList()
        var start = 0
        var min = Float.MAX_VALUE
        for (i in 0..3) {
            val s = sorted[i].x + sorted[i].y
            if (s < min) { min = s; start = i }
        }
        val out = ArrayList<PointF>(4)
        for (i in 0..3) out.add(sorted[(start + i) % 4])
        val cross = (out[1].x - out[0].x) * (out[2].y - out[1].y) -
            (out[1].y - out[0].y) * (out[2].x - out[1].x)
        if (cross < 0f) {
            val t = out[1]
            out[1] = out[3]
            out[3] = t
        }
        return out.toTypedArray()
    }

    /** 上次用户确认过的四角（归一化 0..1），用于下一张自动套用。 */
    private fun loadLastQuad(b: Bitmap): Array<PointF>? {
        return try {
            val s = getSharedPreferences("hrpunch_config", MODE_PRIVATE).getString("xuanlun_last_quad", null)
                ?: return null
            val arr = org.json.JSONArray(s)
            if (arr.length() != 4) return null
            Array(4) { i ->
                val o = arr.getJSONObject(i)
                PointF((o.getDouble("x").toFloat() * b.width), (o.getDouble("y").toFloat() * b.height))
            }
        } catch (e: Exception) { null }
    }

    private fun saveLastQuad(q: Array<PointF>, w: Int, h: Int) {
        try {
            val arr = org.json.JSONArray()
            for (p in q) {
                arr.put(org.json.JSONObject().put("x", (p.x / w).toDouble()).put("y", (p.y / h).toDouble()))
            }
            getSharedPreferences("hrpunch_config", MODE_PRIVATE).edit()
                .putString("xuanlun_last_quad", arr.toString()).apply()
        } catch (e: Exception) { /* ignore */ }
    }

    private fun dist(a: PointF, b: PointF): Float {
        val dx = a.x - b.x; val dy = a.y - b.y
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }

    private fun doCrop() {
        val b = bmp ?: return
        try {
            val q = cropView.getQuad()
            saveLastQuad(q, b.width, b.height)
            val src = floatArrayOf(
                q[0].x, q[0].y, q[1].x, q[1].y,
                q[2].x, q[2].y, q[3].x, q[3].y
            )
            val outW = max(dist(q[0], q[1]), dist(q[3], q[2])).roundToInt().coerceIn(200, 3200)
            val outH = max(dist(q[0], q[3]), dist(q[1], q[2])).roundToInt().coerceIn(200, 4200)
            val dst = floatArrayOf(0f, 0f, outW.toFloat(), 0f, outW.toFloat(), outH.toFloat(), 0f, outH.toFloat())
            val m = Matrix()
            if (!m.setPolyToPoly(src, 0, dst, 0, 4)) {
                Toast.makeText(this, "角点无效，请重新调整", Toast.LENGTH_SHORT).show()
                return
            }
            val out = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            // 保留彩色（大模型对彩色原图识别更准），仅做轻微对比度增强
            val cm = ColorMatrix()
            val contrast = 1.12f
            val t = (1 - contrast) * 128f
            cm.postConcat(ColorMatrix(floatArrayOf(
                contrast, 0f, 0f, 0f, t,
                0f, contrast, 0f, 0f, t,
                0f, 0f, contrast, 0f, t,
                0f, 0f, 0f, 1f, 0f
            )))
            paint.colorFilter = ColorMatrixColorFilter(cm)
            canvas.drawBitmap(b, m, paint)

            // 自动识别纸张上的黑色表格外框，紧裁到表格区域（去掉四周空白，提高有效像素占比）
            val frameRect = detectTableRect(out)
            val contentRect = if (frameRect == null) detectContentRect(out) else null
            val useRect = frameRect ?: contentRect
            val finalBmp: Bitmap
            if (useRect != null) {
                finalBmp = Bitmap.createBitmap(out, useRect.left, useRect.top, useRect.width(), useRect.height())
                if (finalBmp !== out) out.recycle()
                Toast.makeText(
                    this,
                    if (frameRect != null) "已自动裁切到表格边框" else "已自动裁切到内容区域",
                    Toast.LENGTH_SHORT
                ).show()
            } else {
                finalBmp = out
            }

            val f = File(outPath)
            f.parentFile?.mkdirs()
            FileOutputStream(f).use { finalBmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            finalBmp.recycle()
            setResult(RESULT_OK, Intent().putExtra("out", f.absolutePath))
            finish()
        } catch (e: Exception) {
            Toast.makeText(this, "校正失败：" + (e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 在透视校正后的图片里找"黑色表格外框"：
     * 统计每一行/列的暗像素数量，接近整幅宽/高的行/列视为表格线，取最外侧四条线作为外框。
     * 找不到或面积过小则返回 null（后续改用内容包围盒）。
     */
    private fun detectTableRect(bmp: Bitmap): android.graphics.Rect? {
        val w = bmp.width
        val h = bmp.height
        if (w < 120 || h < 120) return null
        val pixels = IntArray(w * h)
        bmp.getPixels(pixels, 0, w, 0, 0, w, h)
        val rowCount = IntArray(h)
        val colCount = IntArray(w)
        for (y in 0 until h) {
            val base = y * w
            var c = 0
            for (x in 0 until w) {
                val p = pixels[base + x]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val bl = p and 0xFF
                val lum = (299 * r + 587 * g + 114 * bl) / 1000
                if (lum < 150) { c++; colCount[x]++ }
            }
            rowCount[y] = c
        }
        val rowThreshold = (w * 0.30f).toInt()
        val colThreshold = (h * 0.25f).toInt()
        var top = -1
        var bottom = -1
        for (y in 0 until h) {
            if (rowCount[y] >= rowThreshold) {
                if (top < 0) top = y
                bottom = y
            }
        }
        var left = -1
        var right = -1
        for (x in 0 until w) {
            if (colCount[x] >= colThreshold) {
                if (left < 0) left = x
                right = x
            }
        }
        if (top < 0 || bottom <= top || left < 0 || right <= left) return null
        val rw = right - left
        val rh = bottom - top
        if (rw < w * 0.45f || rh < h * 0.45f) return null   // 面积过小，可能误检
        val mx = (rw * 0.012f).toInt().coerceAtLeast(2)
        val my = (rh * 0.012f).toInt().coerceAtLeast(2)
        val l = (left - mx).coerceAtLeast(0)
        val t = (top - my).coerceAtLeast(0)
        val r = (right + mx).coerceAtMost(w - 1)
        val b = (bottom + my).coerceAtMost(h - 1)
        return android.graphics.Rect(l, t, r, b)
    }

    /** 兜底：找"有内容（暗像素）"的包围盒，去掉四周白边。 */
    private fun detectContentRect(bmp: Bitmap): android.graphics.Rect? {
        val w = bmp.width
        val h = bmp.height
        if (w < 120 || h < 120) return null
        val pixels = IntArray(w * h)
        bmp.getPixels(pixels, 0, w, 0, 0, w, h)
        var minX = w
        var minY = h
        var maxX = -1
        var maxY = -1
        var n = 0
        for (y in 0 until h) {
            val base = y * w
            for (x in 0 until w) {
                val p = pixels[base + x]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val bl = p and 0xFF
                val lum = (299 * r + 587 * g + 114 * bl) / 1000
                if (lum < 160) {
                    n++
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                    if (y < minY) minY = y
                    if (y > maxY) maxY = y
                }
            }
        }
        if (n < w * h * 0.005f || maxX <= minX || maxY <= minY) return null
        val rw = maxX - minX
        val rh = maxY - minY
        if (rw < w * 0.35f || rh < h * 0.35f) return null
        val mx = (rw * 0.015f).toInt().coerceAtLeast(3)
        val my = (rh * 0.015f).toInt().coerceAtLeast(3)
        val l = (minX - mx).coerceAtLeast(0)
        val t = (minY - my).coerceAtLeast(0)
        val r = (maxX + mx).coerceAtMost(w - 1)
        val b = (maxY + my).coerceAtMost(h - 1)
        return android.graphics.Rect(l, t, r, b)
    }
}
