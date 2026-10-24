import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@specweave-studio/shared/htmlRender";
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

/** The palette `applyTheme` paints for a preference, or the stock look when no theme applies. */
function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

/** The app's active theme and fonts, as handed to agent HTML renders. Stable until one changes. */
export function useHtmlRenderTheme() {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(theme, themeHalves, resolvedTheme),
    () => getStandardThemeColors(resolvedTheme),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  const palette = useMemo(
    () =>
      htmlRenderTheme(colors, resolvedTheme, {
        sans: appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
        mono: appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
      }),
    [colors, resolvedTheme, sans, mono],
  );
  const [rendered, setRendered] = useState(() => readRenderedHtmlTheme(palette));
  useLayoutEffect(() => {
    const update = () => {
      const next = readRenderedHtmlTheme(palette);
      setRendered((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme-id"],
    });
    return () => observer.disconnect();
  }, [palette]);
  return rendered;
}

/** Shell CSS refines the base palette. Pass its painted colors to the document. */
export function readRenderedHtmlTheme(palette: ReturnType<typeof htmlRenderTheme>) {
  if (typeof document === "undefined") return palette;
  const style = getComputedStyle(document.documentElement);
  const variables = { ...palette.variables };
  for (const name of Object.keys(variables)) {
    if (name.startsWith("--font-") || name.startsWith("--chart-")) continue;
    const cssName =
      name === "--accent"
        ? "--message-action"
        : name === "--accent-foreground"
          ? "--message-action-foreground"
          : name;
    const value = style.getPropertyValue(cssName).trim();
    if (value) variables[name] = value;
  }
  return { ...palette, variables };
}
