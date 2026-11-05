package com.specwithcode.android.ui.theme

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Weave color values as plain ARGB data, free of Compose so the contrast math runs in plain
 * unit tests. Ported from the iOS `WeavePalette`, with the accent moved to the iris/indigo
 * family around #5B6CFF that the Android launcher icon uses.
 */
enum class WeaveToken(val light: Long, val dark: Long) {
    Canvas(0xFFF8F7FA, 0xFF14131C),
    Panel(0xFFFFFFFF, 0xFF1E1D29),
    Sunken(0xFFEFEEF3, 0xFF0E0E15),
    Ink(0xFF1C1A29, 0xFFF1F0F8),
    Muted(0xFF5F5C6E, 0xFFA7A5B7),
    Line(0xFFDEDCE6, 0xFF302E3F),
    Control(0xFF858296, 0xFF7B798F),
    Iris(0xFF4A56E2, 0xFF8F9BFF),
    IrisStrong(0xFF323DB0, 0xFFC4CAFF),
    IrisTint(0xFFE8EAFF, 0xFF262A4D),
    OnIris(0xFFFFFFFF, 0xFF10132E),
    Pass(0xFF1D7348, 0xFF5CC68D),
    PassTint(0xFFE3F2E9, 0xFF15301F),
    Warn(0xFF8F5400, 0xFFE8AB3E),
    WarnTint(0xFFF7ECD9, 0xFF33270F),
    Fail(0xFFB4232C, 0xFFFF8080),
    FailTint(0xFFF9E3E4, 0xFF3A1A1D),

    /** Fill of the user's message bubble: iris tint in light, panel in dark. */
    Bubble(0xFFE8EAFF, 0xFF262A4D),
    ;

    fun argb(dark: Boolean): Long = if (dark) this.dark else light

    companion object {
        /** The brand color of the launcher icon. */
        const val BRAND: Long = 0xFF5B6CFF
    }
}

/** Project icon tints (Tailwind 600 in light, 400 in dark), matching desktop and iOS. */
enum class WeaveTint(val light: Long, val dark: Long) {
    Gray(0xFF4B5563, 0xFF9CA3AF),
    Red(0xFFDC2626, 0xFFF87171),
    Orange(0xFFEA580C, 0xFFFB923C),
    Amber(0xFFD97706, 0xFFFBBF24),
    Yellow(0xFFCA8A04, 0xFFFACC15),
    Lime(0xFF65A30D, 0xFFA3E635),
    Green(0xFF16A34A, 0xFF4ADE80),
    Emerald(0xFF059669, 0xFF34D399),
    Teal(0xFF0D9488, 0xFF2DD4BF),
    Cyan(0xFF0891B2, 0xFF22D3EE),
    Sky(0xFF0284C7, 0xFF38BDF8),
    Blue(0xFF2563EB, 0xFF60A5FA),
    Indigo(0xFF4F46E5, 0xFF818CF8),
    Violet(0xFF7C3AED, 0xFFA78BFA),
    Purple(0xFF9333EA, 0xFFC084FC),
    Fuchsia(0xFFC026D3, 0xFFE879F9),
    Pink(0xFFDB2777, 0xFFF472B6),
    Rose(0xFFE11D48, 0xFFFB7185),
    ;

    companion object {
        /** A tint by name ("violet") or hex ("#7c3aed"); null when neither. */
        fun resolve(nameOrHex: String?, dark: Boolean): Long? {
            val raw = nameOrHex?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            entries.firstOrNull { it.name.lowercase() == raw }?.let { return if (dark) it.dark else it.light }
            return parseHex(raw)
        }

        /** Parses "#rrggbb", "rrggbb" or "#rgb" to opaque ARGB. */
        fun parseHex(hex: String): Long? {
            var s = hex.trim().removePrefix("#")
            if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
            if (s.length != 6) return null
            val value = s.toLongOrNull(16) ?: return null
            return 0xFF000000 or value
        }
    }
}

/** WCAG contrast checks for the pairs the app relies on. */
object WeaveContrast {
    fun luminance(argb: Long): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF) / 255.0
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    fun ratio(a: Long, b: Long): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /** Text pairs need 4.5:1; control borders need 3:1. */
    val requiredPairs: List<Triple<WeaveToken, WeaveToken, Double>> = listOf(
        Triple(WeaveToken.Ink, WeaveToken.Canvas, 4.5), Triple(WeaveToken.Ink, WeaveToken.Panel, 4.5),
        Triple(WeaveToken.Ink, WeaveToken.Sunken, 4.5), Triple(WeaveToken.Ink, WeaveToken.Bubble, 4.5),
        Triple(WeaveToken.Ink, WeaveToken.IrisTint, 4.5),
        Triple(WeaveToken.Muted, WeaveToken.Canvas, 4.5), Triple(WeaveToken.Muted, WeaveToken.Panel, 4.5),
        Triple(WeaveToken.Muted, WeaveToken.Sunken, 4.5), Triple(WeaveToken.Muted, WeaveToken.Bubble, 4.5),
        Triple(WeaveToken.Iris, WeaveToken.Canvas, 4.5), Triple(WeaveToken.Iris, WeaveToken.Panel, 4.5),
        Triple(WeaveToken.IrisStrong, WeaveToken.IrisTint, 4.5), Triple(WeaveToken.OnIris, WeaveToken.Iris, 4.5),
        Triple(WeaveToken.Pass, WeaveToken.PassTint, 4.5), Triple(WeaveToken.Warn, WeaveToken.WarnTint, 4.5),
        Triple(WeaveToken.Fail, WeaveToken.FailTint, 4.5), Triple(WeaveToken.Pass, WeaveToken.Panel, 4.5),
        Triple(WeaveToken.Warn, WeaveToken.Panel, 4.5), Triple(WeaveToken.Fail, WeaveToken.Panel, 4.5),
        Triple(WeaveToken.Control, WeaveToken.Canvas, 3.0), Triple(WeaveToken.Control, WeaveToken.Panel, 3.0),
    )

    data class Failure(val foreground: WeaveToken, val background: WeaveToken, val dark: Boolean, val ratio: Double, val minimum: Double)

    fun failures(): List<Failure> = buildList {
        for (dark in listOf(false, true)) {
            for ((fg, bg, minimum) in requiredPairs) {
                val r = ratio(fg.argb(dark), bg.argb(dark))
                if (r < minimum) add(Failure(fg, bg, dark, r, minimum))
            }
        }
    }
}
