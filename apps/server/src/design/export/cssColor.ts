/**
 * CSS colors as PowerPoint colors: six hex digits plus a transparency
 * percentage. Covers what design tokens hold (hex, rgb, hsl, oklch, oklab and
 * the common names). Anything else (gradients, `var()`, `color-mix()`) is
 * `null`, and the export draws that part as an image instead.
 */
export interface PptxColor {
  /** `RRGGBB`, upper case, no `#`. */
  readonly hex: string;
  /** 0 opaque to 100 invisible. */
  readonly transparency: number;
}

const NAMED: Readonly<Record<string, string>> = {
  black: "000000",
  white: "ffffff",
  red: "ff0000",
  green: "008000",
  lime: "00ff00",
  blue: "0000ff",
  yellow: "ffff00",
  orange: "ffa500",
  purple: "800080",
  gray: "808080",
  grey: "808080",
  silver: "c0c0c0",
  maroon: "800000",
  navy: "000080",
  teal: "008080",
  olive: "808000",
  aqua: "00ffff",
  cyan: "00ffff",
  fuchsia: "ff00ff",
  magenta: "ff00ff",
  pink: "ffc0cb",
  brown: "a52a2a",
  gold: "ffd700",
  indigo: "4b0082",
  violet: "ee82ee",
  coral: "ff7f50",
  salmon: "fa8072",
  tomato: "ff6347",
  crimson: "dc143c",
  whitesmoke: "f5f5f5",
  gainsboro: "dcdcdc",
  lightgray: "d3d3d3",
  lightgrey: "d3d3d3",
  darkgray: "a9a9a9",
  darkgrey: "a9a9a9",
  dimgray: "696969",
  dimgrey: "696969",
  slategray: "708090",
  slategrey: "708090",
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const hex2 = (channel: number) =>
  Math.round(clamp(channel, 0, 255))
    .toString(16)
    .padStart(2, "0");

const color = (r: number, g: number, b: number, alpha: number): PptxColor => ({
  hex: `${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase(),
  transparency: Math.round((1 - clamp(alpha, 0, 1)) * 100),
});

/** A number, a percentage of `percentOf`, or `none` (0). */
const amount = (token: string, percentOf: number): number | null => {
  if (token === "none") return 0;
  const match = /^(-?\d*\.?\d+(?:e-?\d+)?)(%?)$/i.exec(token);
  if (match === null) return null;
  const value = Number(match[1]);
  return match[2] === "%" ? (value / 100) * percentOf : value;
};

const hue = (token: string): number | null => {
  if (token === "none") return 0;
  const match = /^(-?\d*\.?\d+)(deg|grad|rad|turn)?$/i.exec(token);
  if (match === null) return null;
  const value = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "grad":
      return (value * 360) / 400;
    case "rad":
      return (value * 180) / Math.PI;
    case "turn":
      return value * 360;
    default:
      return value;
  }
};

/** `fn(a b c / d)` or `fn(a, b, c, d)` as three channels and an optional alpha. */
const channels = (inner: string) => {
  const [main, slashAlpha] = inner.split("/").map((part) => part.trim());
  const parts = (main ?? "").split(/[\s,]+/).filter((part) => part !== "");
  const alpha = slashAlpha ?? parts[3];
  if (parts.length < 3 || parts.length > 4 || (parts.length === 4 && slashAlpha !== undefined)) {
    return null;
  }
  return { parts: parts.slice(0, 3) as [string, string, string], alpha };
};

const alphaOf = (token: string | undefined) => (token === undefined ? 1 : amount(token, 1));

const linearToSrgb = (value: number) =>
  255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055);

const oklabColor = (lightness: number, a: number, b: number, alpha: number) => {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return color(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  );
};

const hslColor = (h: number, s: number, l: number, alpha: number) => {
  const sat = clamp(s, 0, 1);
  const light = clamp(l, 0, 1);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    return 255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return color(f(0), f(8), f(4), alpha);
};

export function parseCssColor(input: string | undefined): PptxColor | null {
  if (input === undefined) return null;
  const value = input.trim().toLowerCase();
  if (value === "transparent") return { hex: "000000", transparency: 100 };
  const named = NAMED[value];
  if (named !== undefined) return color(...hexChannels(named), 1);
  if (value.startsWith("#")) {
    const digits = value.slice(1);
    if (!/^[0-9a-f]+$/.test(digits) || ![3, 4, 6, 8].includes(digits.length)) return null;
    const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
    const [r, g, b] = hexChannels(full);
    const alpha = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return color(r, g, b, alpha);
  }
  const call = /^([a-z]+)\((.*)\)$/.exec(value);
  if (call === null) return null;
  const parsed = channels(call[2]!);
  if (parsed === null) return null;
  const alpha = alphaOf(parsed.alpha);
  if (alpha === null) return null;
  const [first, second, third] = parsed.parts;
  switch (call[1]) {
    case "rgb":
    case "rgba": {
      const [r, g, b] = [first, second, third].map((token) => amount(token, 255));
      if (r == null || g == null || b == null) return null;
      return color(r, g, b, alpha);
    }
    case "hsl":
    case "hsla": {
      const h = hue(first);
      const s = amount(second.endsWith("%") ? second : `${second}%`, 1);
      const l = amount(third.endsWith("%") ? third : `${third}%`, 1);
      if (h === null || s === null || l === null) return null;
      return hslColor(((h % 360) + 360) % 360, s, l, alpha);
    }
    case "oklch": {
      const l = amount(first, 1);
      const c = amount(second, 0.4);
      const h = hue(third);
      if (l === null || c === null || h === null) return null;
      const radians = (h * Math.PI) / 180;
      return oklabColor(l, c * Math.cos(radians), c * Math.sin(radians), alpha);
    }
    case "oklab": {
      const l = amount(first, 1);
      const a = amount(second, 0.4);
      const b = amount(third, 0.4);
      if (l === null || a === null || b === null) return null;
      return oklabColor(l, a, b, alpha);
    }
    default:
      return null;
  }
}

function hexChannels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}
