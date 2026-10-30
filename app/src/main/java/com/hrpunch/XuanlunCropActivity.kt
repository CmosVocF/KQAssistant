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
            val cm = ColorMatrix()
            cm.setSaturation(0f)
            val contrast = 1.22f
            val t = (1 - contrast) * 128f
            cm.postConcat(ColorMatrix(floatArrayOf(
                contrast, 0f, 0f, 0f, t,
                0f, contrast, 0f, 0f, t,
                0f, 0f, contrast, 0f, t,
                0f, 0f, 0f, 1f, 0f
            )))
            paint.colorFilter = ColorMatrixColorFilter(cm)
            canvas.drawBitmap(b, m, paint)

            val f = File(outPath)
            f.parentFile?.mkdirs()
            FileOutputStream(f).use { out.compress(Bitmap.CompressFormat.JPEG, 86, it) }
            out.recycle()
            setResult(RESULT_OK, Intent().putExtra("out", f.absolutePath))
            finish()
        } catch (e: Exception) {
            Toast.makeText(this, "校正失败：" + (e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }
}
