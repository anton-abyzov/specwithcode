import { parseColor } from "./designSystemOps.ts";

/** sRGB channels from 0 to 1 plus alpha from 0 to 1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** WCAG AA for body text. */
export const MIN_TEXT_CONTRAST = 4.5;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const toGamma = (linear: number) =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

function oklchToRgb(base: string): [number, number, number] | null {
  const match = /^oklch\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)$/i.exec(base);
  if (match === null) return null;
  const read = (text: string, percentScale: number) => {
    const percent = text.endsWith("%");
    const value = Number(percent ? text.slice(0, -1) : text);
    return Number.isFinite(value) ? (percent ? (value / 100) * percentScale : value) : null;
  };
  const lightness = read(match[1]!, 1);
  const chroma = read(match[2]!, 0.4);
  const hue = Number(match[3]!.replace(/deg$/i, ""));
  if (lightness === null || chroma === null || !Number.isFinite(hue)) return null;
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** A CSS color as sRGB, or null when it cannot be read (references, `color-mix()`). */
export function cssColorToRgba(value: string | null | undefined): Rgba | null {
  if (value === null || value === undefined) return null;
  const parsed = parseColor(value);
  if (parsed === null) return null;
  const a = parsed.alpha / 100;
  if (parsed.hex !== null) {
    const channel = (offset: number) => parseInt(parsed.hex!.slice(offset, offset + 2), 16) / 255;
    return { r: channel(1), g: channel(3), b: channel(5), a };
  }
  const rgb = oklchToRgb(parsed.base);
  return rgb === null ? null : { r: rgb[0], g: rgb[1], b: rgb[2], a };
}

/** `top` painted over an opaque `bottom`, at `top`'s alpha times `opacity`. */
export function compositeColor(top: Rgba, bottom: Rgba, opacity = 1): Rgba {
  const alpha = clamp01(top.a * opacity);
  const mix = (over: number, under: number) => over * alpha + under * (1 - alpha);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export function relativeLuminance(color: Rgba): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** WCAG contrast ratio between two opaque colors, from 1 to 21. */
export function contrastRatio(first: Rgba, second: Rgba): number {
  const one = relativeLuminance(first);
  const two = relativeLuminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}
