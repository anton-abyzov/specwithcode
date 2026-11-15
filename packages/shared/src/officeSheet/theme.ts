/**
 * One theme for every Office artifact. A sheet, its charts, and later a
 * dashboard or a deck read the same named roles, so a project that names a
 * design system gets one look across all of them, and another project reuses
 * that system by id.
 */

export type OfficeThemeMode = "light" | "dark";

export interface OfficeTheme {
  readonly surface: string | null;
  readonly text: string | null;
  readonly muted: string | null;
  readonly line: string | null;
  readonly accent: string | null;
  /** Chart series colours, in order. Empty means the app's own palette. */
  readonly series: ReadonlyArray<string>;
  readonly fontFamily: string | null;
}

/** The part of a design system this resolver reads; any wider object fits. */
export interface OfficeThemeSource {
  readonly modes?: ReadonlyArray<string>;
  readonly tokens: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly group?: string | null | undefined;
    readonly values: Readonly<
      Record<string, { readonly resolved?: unknown; readonly raw?: unknown }>
    >;
  }>;
}

export const EMPTY_OFFICE_THEME: OfficeTheme = {
  surface: null,
  text: null,
  muted: null,
  line: null,
  accent: null,
  series: [],
  fontFamily: null,
};

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([0-9a-zA-Z.,%/\s+-]{1,80}\)$/;
const FONT = /^[A-Za-z0-9 ,'"_-]{1,200}$/;

/** A colour a file may supply: hex or a plain colour function. Nothing with url() or var(). */
export function safeCssColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (HEX.test(trimmed)) return trimmed;
  if (FUNCTIONAL.test(trimmed) && !/url|var|expression|image/i.test(trimmed)) return trimmed;
  return null;
}

export function safeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return FONT.test(trimmed) ? trimmed : null;
}

const ROLE_NAMES: Record<
  "surface" | "text" | "muted" | "line" | "accent",
  ReadonlyArray<RegExp>
> = {
  surface: [/(^|[./_-])(background|surface|bg|canvas)$/i, /(background|surface)/i],
  text: [
    /(^|[./_-])(foreground|text|ink|on-?surface)$/i,
    /(foreground|text[./_-]?(primary|default))/i,
  ],
  muted: [/(muted[./_-]?foreground|text[./_-]?(muted|secondary)|subtle)/i],
  line: [/(^|[./_-])(border|line|divider|outline|stroke)$/i, /(border|divider)/i],
  accent: [/(^|[./_-])(primary|accent|brand)$/i, /(primary|accent|brand)/i],
};

const SERIES_NAMES = /(chart|series|data|categorical|viz)/i;

/**
 * Read the Office roles from a design system. A role the system does not name
 * stays null, and the renderer falls back to the app theme for it.
 */
export function resolveOfficeTheme(
  source: OfficeThemeSource | null | undefined,
  mode: OfficeThemeMode,
): OfficeTheme {
  if (!source || !Array.isArray(source.tokens)) return EMPTY_OFFICE_THEME;
  const modeKey = pickMode(source, mode);
  const valueOf = (token: OfficeThemeSource["tokens"][number]): unknown => {
    const entry = token.values[modeKey] ?? Object.values(token.values)[0];
    return entry?.resolved ?? entry?.raw;
  };
  const colors = source.tokens
    .filter((token) => token.type === "color")
    .map((token) => ({
      name: token.name,
      group: token.group ?? "",
      color: safeCssColor(valueOf(token)),
    }))
    .filter(
      (token): token is { name: string; group: string; color: string } => token.color !== null,
    );

  const role = (patterns: ReadonlyArray<RegExp>): string | null => {
    for (const pattern of patterns) {
      const found = colors.find((token) => pattern.test(token.name));
      if (found) return found.color;
    }
    return null;
  };

  const series: string[] = [];
  for (const token of colors) {
    if (
      (SERIES_NAMES.test(token.name) || SERIES_NAMES.test(token.group)) &&
      !series.includes(token.color)
    ) {
      series.push(token.color);
    }
    if (series.length >= 8) break;
  }
  const accent = role(ROLE_NAMES.accent);
  if (series.length === 0 && accent) series.push(accent);

  const fontToken =
    source.tokens.find(
      (token) => token.type === "fontFamily" && /(sans|body|base|text|ui)/i.test(token.name),
    ) ?? source.tokens.find((token) => token.type === "fontFamily");

  return {
    surface: role(ROLE_NAMES.surface),
    text: role(ROLE_NAMES.text),
    muted: role(ROLE_NAMES.muted),
    line: role(ROLE_NAMES.line),
    accent,
    series,
    fontFamily: fontToken ? safeFontFamily(valueOf(fontToken)) : null,
  };
}

function pickMode(source: OfficeThemeSource, mode: OfficeThemeMode): string {
  const modes = source.modes ?? [];
  const exact = modes.find((name) => name.toLowerCase() === mode);
  if (exact) return exact;
  const close = modes.find((name) => name.toLowerCase().includes(mode));
  return close ?? modes[0] ?? mode;
}

/** CSS custom properties for a themed Office surface; only the roles that resolved. */
export function officeThemeVariables(theme: OfficeTheme): Record<string, string> {
  const variables: Record<string, string> = {};
  if (theme.surface) variables["--office-surface"] = theme.surface;
  if (theme.text) variables["--office-text"] = theme.text;
  if (theme.muted) variables["--office-muted"] = theme.muted;
  if (theme.line) variables["--office-line"] = theme.line;
  if (theme.accent) variables["--office-accent"] = theme.accent;
  if (theme.fontFamily) variables["--office-font"] = theme.fontFamily;
  theme.series.forEach((color, index) => {
    variables[`--office-series-${index + 1}`] = color;
  });
  return variables;
}
