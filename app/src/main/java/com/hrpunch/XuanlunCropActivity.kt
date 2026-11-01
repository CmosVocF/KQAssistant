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

/** 镟轮照片校正页：拖动四角 → 透视校正 + 灰度增强 → 保存。 */
class XuanlunCropActivity : Activity() {

    companion object {
        const val EXTRA_IN = "in"
        const val EXTRA_OUT = "out"
    }

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
        cropView.setBitmap(b)
        findViewById<Button>(R.id.btnCancel).setOnClickListener {
            setResult(RESULT_CANCELED)
            finish()
        }
        findViewById<Button>(R.id.btnOk).setOnClickListener { doCrop() }
    }

    private fun dist(a: PointF, b: PointF): Float {
        val dx = a.x - b.x; val dy = a.y - b.y
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }

    private fun doCrop() {
        val b = bmp ?: return
        try {
            val q = cropView.getQuad()
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
