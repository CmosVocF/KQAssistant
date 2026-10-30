package com.hrpunch

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
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
 * 四点透视校正视图：显示图片 + 四个可拖动角点。
 * 角点坐标使用图片原始像素坐标；自动预检白纸区域给出初始四角。
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

    private val linePaint = Paint().apply {
        color = 0xFF4A6CF7.toInt(); style = Paint.Style.STROKE; strokeWidth = 5f
    }
    private val overlayPaint = Paint().apply { color = 0x99000000.toInt() }
    private val handleFill = Paint().apply { color = Color.WHITE; style = Paint.Style.FILL }
    private val handleStroke = Paint().apply {
        color = 0xFF4A6CF7.toInt(); style = Paint.Style.STROKE; strokeWidth = 5f
    }
    private val bmpPaint = Paint(Paint.FILTER_BITMAP_FLAG)

    fun setBitmap(b: Bitmap) {
        bmp = b
        val c = autoCorners(b)
        for (i in 0..3) { corners[i].x = c[i].x; corners[i].y = c[i].y }
        invalidate()
    }

    /** 返回图片坐标系的四个角点（TL, TR, BR, BL）。 */
    fun getQuad(): Array<PointF> = corners.map { PointF(it.x, it.y) }.toTypedArray()

    private fun defaultCorners(w: Int, h: Int): Array<PointF> {
        val mx = w * 0.04f; val my = h * 0.04f
        return arrayOf(
            PointF(mx, my), PointF(w - mx, my), PointF(w - mx, h - my), PointF(mx, h - my)
        )
    }

    /** 简单自动预检：缩放后按亮度找白纸区域包围盒；失败则用 4% 边距。 */
    private fun autoCorners(b: Bitmap): Array<PointF> {
        val w = b.width; val h = b.height
        val maxSide = max(w, h)
        if (maxSide <= 400) return defaultCorners(w, h)
        val k = 240f / maxSide
        val bw = max(1, (w * k).toInt()); val bh = max(1, (h * k).toInt())
        val small = try { Bitmap.createScaledBitmap(b, bw, bh, false) } catch (e: Exception) { return defaultCorners(w, h) }
        var minX = bw; var minY = bh; var maxX = -1; var maxY = -1; var found = 0
        for (y in 0 until bh) {
            for (x in 0 until bw) {
                val p = small.getPixel(x, y)
                val lum = 0.299f * Color.red(p) + 0.587f * Color.green(p) + 0.114f * Color.blue(p)
                if (lum > 190f) {
                    found++
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                    if (y < minY) minY = y
                    if (y > maxY) maxY = y
                }
            }
        }
        small.recycle()
        if (found < bw * bh * 0.04f || maxX <= minX || maxY <= minY) return defaultCorners(w, h)
        val kx = w.toFloat() / bw; val ky = h.toFloat() / bh
        val L = minX * kx; val T = minY * ky; val R = (maxX + 1) * kx; val B = (maxY + 1) * ky
        // 向内收 0.5%，避免带入背景
        val ix = (R - L) * 0.005f; val iy = (B - T) * 0.005f
        return arrayOf(
            PointF(L + ix, T + iy), PointF(R - ix, T + iy),
            PointF(R - ix, B - iy), PointF(L + ix, B - iy)
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
            canvas.drawCircle(vx(i), vy(i), 16f, handleFill)
            canvas.drawCircle(vx(i), vy(i), 16f, handleStroke)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragIndex = findCorner(event.x, event.y)
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
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> dragIndex = -1
        }
        return true
    }

    private fun findCorner(x: Float, y: Float): Int {
        val r = 56f
        var best = -1; var bestD = Float.MAX_VALUE
        for (i in 0..3) {
            val dx = x - vx(i); val dy = y - vy(i)
            val d = dx * dx + dy * dy
            if (d < r * r && d < bestD) { bestD = d; best = i }
        }
        return best
    }
}
