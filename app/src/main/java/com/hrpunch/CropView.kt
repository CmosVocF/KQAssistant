package com.hrpunch

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * 四点透视校正视图：显示图片 + 四个可拖动角点 + 拖动时的放大镜。
 * 角点坐标使用图片原始像素坐标；初始四角从边缘内缩，避免触发系统返回手势。
 */
class CropView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private var bmp: Bitmap? = null
    private val corners = Array(4) { PointF() }   // 左上、右上、右下、左下
    private var dragIndex = -1
    private var scale = 1f
    private var offX = 0f
    private var offY = 0f
    private val density = context.resources.displayMetrics.density

    private val linePaint = Paint().apply {
        color = 0xFF35C7B6.toInt(); style = Paint.Style.STROKE; strokeWidth = 3f * density
    }
    private val overlayPaint = Paint().apply { color = 0x66000000 }
    private val handleFill = Paint().apply { color = Color.WHITE; style = Paint.Style.FILL }
    private val handleStroke = Paint().apply {
        color = 0xFF35C7B6.toInt(); style = Paint.Style.STROKE; strokeWidth = 4f * density
    }
    private val bmpPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val magRing = Paint().apply {
        color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 3f * density
    }
    private val magCross = Paint().apply {
        color = 0xFFFF4D4F.toInt(); style = Paint.Style.STROKE; strokeWidth = 1.5f * density
    }

    fun setBitmap(b: Bitmap) {
        bmp = b
        val c = defaultCorners(b.width, b.height)
        for (i in 0..3) { corners[i].x = c[i].x; corners[i].y = c[i].y }
        invalidate()
    }

    /** 返回图片坐标系的四个角点（TL, TR, BR, BL）。 */
    fun getQuad(): Array<PointF> = corners.map { PointF(it.x, it.y) }.toTypedArray()

    /** 初始四角：从图片边缘内缩 12%，避免贴屏幕边缘触发返回手势。 */
    private fun defaultCorners(w: Int, h: Int): Array<PointF> {
        val mx = w * 0.12f
        val my = h * 0.12f
        return arrayOf(
            PointF(mx, my), PointF(w - mx, my), PointF(w - mx, h - my), PointF(mx, h - my)
        )
    }

    private fun vx(i: Int) = offX + corners[i].x * scale
    private fun vy(i: Int) = offY + corners[i].y * scale

    override fun onDraw(canvas: Canvas) {
        val b = bmp ?: return
        scale = min(width.toFloat() / b.width, height.toFloat() / b.height)
        offX = (width - b.width * scale) / 2f
        offY = (height - b.height * scale) / 2f
        canvas.drawBitmap(b, null, RectF(offX, offY, offX + b.width * scale, offY + b.height * scale), bmpPaint)

        val whole = Path().apply { addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW) }
        val quad = Path().apply {
            moveTo(vx(0), vy(0)); lineTo(vx(1), vy(1)); lineTo(vx(2), vy(2)); lineTo(vx(3), vy(3)); close()
        }
        val outside = Path().apply { op(whole, quad, Path.Op.DIFFERENCE) }
        canvas.drawPath(outside, overlayPaint)
        canvas.drawPath(quad, linePaint)
        for (i in 0..3) {
            val r = 11f * density
            canvas.drawCircle(vx(i), vy(i), r, handleFill)
            canvas.drawCircle(vx(i), vy(i), r, handleStroke)
        }
        if (dragIndex in 0..3) drawMagnifier(canvas, b, dragIndex)
    }

    /** 拖动角点时，在左上角显示放大镜（避免手指遮挡）。 */
    private fun drawMagnifier(canvas: Canvas, b: Bitmap, index: Int) {
        val radius = 64f * density
        val cx = radius + 14f * density
        val cy = radius + 14f * density
        val zoom = 2.6f
        val s = scale * zoom
        val px = corners[index].x
        val py = corners[index].y

        val save = canvas.save()
        val clip = Path().apply { addCircle(cx, cy, radius, Path.Direction.CW) }
        canvas.clipPath(clip)
        canvas.drawColor(0xFF1B1F24.toInt())

        val m = Matrix()
        m.postTranslate(-px * s, -py * s)
        m.postTranslate(cx, cy)
        canvas.drawBitmap(b, m, bmpPaint)

        canvas.drawLine(cx - radius, cy, cx + radius, cy, magCross)
        canvas.drawLine(cx, cy - radius, cx, cy + radius, magCross)
        canvas.restoreToCount(save)
        canvas.drawCircle(cx, cy, radius, magRing)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragIndex = findCorner(event.x, event.y)
                if (dragIndex >= 0) invalidate()
                return dragIndex >= 0
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragIndex in 0..3) {
                    val b = bmp ?: return false
                    val nx = ((event.x - offX) / scale).coerceIn(0f, b.width.toFloat())
                    val ny = ((event.y - offY) / scale).coerceIn(0f, b.height.toFloat())
                    corners[dragIndex].x = nx
                    corners[dragIndex].y = ny
                    invalidate()
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragIndex >= 0) { dragIndex = -1; invalidate() }
            }
        }
        return true
    }

    private fun findCorner(x: Float, y: Float): Int {
        val r = 28f * density
        var best = -1
        var bestD = Float.MAX_VALUE
        for (i in 0..3) {
            val dx = x - vx(i)
            val dy = y - vy(i)
            val d = dx * dx + dy * dy
            if (d < r * r && d < bestD) { bestD = d; best = i }
        }
        return best
    }
}
