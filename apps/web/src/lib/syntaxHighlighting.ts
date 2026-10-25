import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type HighlighterTypes,
  type SupportedLanguages,
} from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

/**
 * Always highlight with the Oniguruma WASM engine — the JS regex engine can
 * backtrack catastrophically and hang the tokenizing thread. The shared
 * highlighter is a first-caller-wins singleton, so every creation site must
 * pass this value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(language);
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw error;
    }
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

const readableColors = new Map<string, string>();
/** Keep Pierre's hues, strengthening low-contrast tokens for the app's code
 * surfaces. The conservative surface bounds cover the default panel tints. */
export function readableSyntaxColor(color: string, theme: "light" | "dark"): string {
  const key = `${theme}:${color}`;
  const cached = readableColors.get(key);
  if (cached) return cached;
  if (!/^#[\da-f]{6}$/iu.test(color)) return color;
  let channels = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  const luminance = (rgb: number[]) =>
    rgb
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const background = luminance(theme === "light" ? [237, 237, 237] : [48, 48, 48]);
  for (let step = 0; step < 40; step++) {
    const foreground = luminance(channels);
    if (
      (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) >=
      4.5
    )
      break;
    channels = channels.map((channel) =>
      theme === "light" ? Math.floor(channel * 0.94) : Math.ceil(channel + (255 - channel) * 0.06),
    );
  }
  const result = "#" + channels.map((channel) => channel.toString(16).padStart(2, "0")).join("");
  readableColors.set(key, result);
  return result;
}
