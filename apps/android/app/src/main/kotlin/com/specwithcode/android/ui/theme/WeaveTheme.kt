package com.specwithcode.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.specwithcode.sync.AppearancePreference

/** Every Weave color role as Compose colors for one appearance. */
@Immutable
data class WeaveColors(
    val canvas: Color,
    val panel: Color,
    val sunken: Color,
    val ink: Color,
    val muted: Color,
    val line: Color,
    val control: Color,
    val iris: Color,
    val irisStrong: Color,
    val irisTint: Color,
    val onIris: Color,
    val pass: Color,
    val passTint: Color,
    val warn: Color,
    val warnTint: Color,
    val fail: Color,
    val failTint: Color,
    val bubble: Color,
    val isDark: Boolean,
) {
    /** A project tint by name or hex; iris when unknown. */
    fun tint(nameOrHex: String?): Color = WeaveTint.resolve(nameOrHex, isDark)?.let { Color(it) } ?: iris

    companion object {
        fun of(dark: Boolean): WeaveColors {
            fun c(token: WeaveToken) = Color(token.argb(dark))
            return WeaveColors(
                canvas = c(WeaveToken.Canvas), panel = c(WeaveToken.Panel), sunken = c(WeaveToken.Sunken),
                ink = c(WeaveToken.Ink), muted = c(WeaveToken.Muted), line = c(WeaveToken.Line), control = c(WeaveToken.Control),
                iris = c(WeaveToken.Iris), irisStrong = c(WeaveToken.IrisStrong), irisTint = c(WeaveToken.IrisTint),
                onIris = c(WeaveToken.OnIris), pass = c(WeaveToken.Pass), passTint = c(WeaveToken.PassTint),
                warn = c(WeaveToken.Warn), warnTint = c(WeaveToken.WarnTint), fail = c(WeaveToken.Fail),
                failTint = c(WeaveToken.FailTint), bubble = c(WeaveToken.Bubble), isDark = dark,
            )
        }

        val Light = of(false)
        val Dark = of(true)
    }
}

/** Spacing steps (wv-space-1 is 4 dp). */
object WeaveSpacing {
    val s1 = 4.dp
    val s2 = 8.dp
    val s3 = 12.dp
    val s4 = 16.dp
    val s6 = 24.dp
    val s8 = 32.dp
    val gutter = 16.dp
}

object WeaveRadius {
    val xs = 4.dp
    val sm = 6.dp
    val md = 10.dp
    val lg = 14.dp
    val tile = 8.dp
    val bubble = 20.dp
    val card = 20.dp
}

object WeaveSize {
    /** Minimum hit area for anything tappable. */
    val minTap = 48.dp
    val innerControl = 40.dp
    val readableColumn = 720.dp
}

val LocalWeaveColors = staticCompositionLocalOf { WeaveColors.Light }

object Weave {
    val colors: WeaveColors
        @Composable @ReadOnlyComposable get() = LocalWeaveColors.current
}

/** Monospace text for commands, paths and code. */
val WeaveMono = FontFamily.Monospace

private val WeaveTypography = Typography().let { base ->
    base.copy(
        headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 32.sp),
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 22.sp),
        titleSmall = base.titleSmall.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 0.4.sp),
        bodyLarge = base.bodyLarge.copy(fontSize = 16.sp, lineHeight = 23.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 15.sp, lineHeight = 21.sp),
        bodySmall = base.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold, fontSize = 15.sp),
    )
}

/** Code blocks and inline code. */
val WeaveCodeStyle = TextStyle(fontFamily = WeaveMono, fontSize = 13.sp, lineHeight = 19.sp)

private val WeaveShapes = Shapes(
    extraSmall = RoundedCornerShape(WeaveRadius.sm),
    small = RoundedCornerShape(WeaveRadius.md),
    medium = RoundedCornerShape(WeaveRadius.lg),
    large = RoundedCornerShape(WeaveRadius.card),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Material roles filled from Weave tokens, so stock components already look like Weave. */
fun weaveColorScheme(c: WeaveColors): ColorScheme {
    val base = if (c.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.iris, onPrimary = c.onIris, primaryContainer = c.irisTint, onPrimaryContainer = c.irisStrong,
        inversePrimary = c.irisStrong,
        secondary = c.irisStrong, onSecondary = c.onIris, secondaryContainer = c.irisTint, onSecondaryContainer = c.irisStrong,
        tertiary = c.pass, onTertiary = c.panel, tertiaryContainer = c.passTint, onTertiaryContainer = c.pass,
        background = c.canvas, onBackground = c.ink, surface = c.canvas, onSurface = c.ink,
        surfaceVariant = c.sunken, onSurfaceVariant = c.muted, surfaceTint = c.iris,
        surfaceContainerLowest = c.panel, surfaceContainerLow = c.panel, surfaceContainer = c.panel,
        surfaceContainerHigh = c.panel, surfaceContainerHighest = c.sunken, surfaceBright = c.panel, surfaceDim = c.sunken,
        outline = c.control, outlineVariant = c.line,
        error = c.fail, onError = c.panel, errorContainer = c.failTint, onErrorContainer = c.fail,
    )
}

/** Whether [appearance] resolves to dark right now. */
@Composable
fun AppearancePreference.isDark(): Boolean = when (this) {
    AppearancePreference.System -> isSystemInDarkTheme()
    AppearancePreference.Light -> false
    AppearancePreference.Dark -> true
}

/**
 * The Weave look on Material 3. Dynamic (wallpaper) color is off by default; when the person
 * turns it on (Android 12+), only the Material roles follow the wallpaper. Weave's own status
 * colors stay as designed.
 */
@Composable
fun WeaveTheme(
    appearance: AppearancePreference = AppearancePreference.System,
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val dark = appearance.isDark()
    val weave = if (dark) WeaveColors.Dark else WeaveColors.Light
    val scheme = if (dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val context = LocalContext.current
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else {
        weaveColorScheme(weave)
    }
    CompositionLocalProvider(LocalWeaveColors provides weave) {
        MaterialTheme(colorScheme = scheme, typography = WeaveTypography, shapes = WeaveShapes, content = content)
    }
}
