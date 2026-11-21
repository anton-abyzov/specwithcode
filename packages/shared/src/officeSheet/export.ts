/**
 * Portable, zero-CDN exporters for SheetDocument:
 * - exportSheetToMarkdown: clean GFM tables + chart summaries
 * - exportSheetToStandaloneHtml: single-file, zero-script, XSS-safe HTML5 report
 *   with inline SVG charts and prefers-reduced-motion support.
 */
import { type SheetChartSeries, chartSeries, compactNumber } from "./chart.ts";
import { formatSheetValue } from "./format.ts";
import { type SheetEvaluation, evaluateSheet } from "./formula.ts";
import {
  type CellRange,
  type SheetChart,
  type SheetDocument,
  type SheetTab,
  columnIndex,
  columnLetters,
  parseCellAddress,
  rangeLookup,
  safeLinkHref,
  usedRange,
} from "./model.ts";
import { type OfficeTheme, type OfficeThemeMode, safeCssColor, safeFontFamily } from "./theme.ts";

export interface SheetHtmlExportOptions {
  readonly mode?: OfficeThemeMode;
  readonly evaluation?: SheetEvaluation;
  readonly theme?: OfficeTheme;
}

const DEFAULT_SERIES_LIGHT = ["#2563eb", "#0891b2", "#16a34a", "#d97706", "#9333ea", "#e11d48"];
const DEFAULT_SERIES_DARK = ["#60a5fa", "#22d3ee", "#4ade80", "#fbbf24", "#c084fc", "#fb7185"];
export const SHEET_EXPORT_CELL_BUDGET = 50_000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeMarkdownInline(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-.!|~])/g, "\\$1")
    .replace(/\r\n|\r|\n/g, " ")
    .trim();
}

function escapeMarkdownCell(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]!|~])/g, "\\$1")
    .replace(/\r\n|\r|\n/g, " ")
    .trim();
}

/**
 * Resolve exportable rows and columns for a tab within a cumulative cell budget.
 * For sparse tabs whose bounding box exceeds the budget (e.g., A1 and ZZ100000),
 * compacts to populated rows and columns so export never stalls or OOMs.
 */
function resolveExportGrid(
  tab: SheetTab,
  range: CellRange,
  remainingBudget: number,
): { readonly rows: number[]; readonly cols: number[]; readonly cellCount: number } {
  const visibleCols = visibleOrderedColumns(tab, range);
  const denseRowCount = range.end.row - range.start.row + 1;
  const denseCells = denseRowCount * visibleCols.length;
  if (denseCells <= remainingBudget) {
    const rows: number[] = [];
    for (let r = range.start.row; r <= range.end.row; r += 1) rows.push(r);
    return { rows, cols: visibleCols, cellCount: denseCells };
  }
  const populatedRows = new Set<number>();
  const populatedCols = new Set<number>();
  for (const addr of Object.keys(tab.cells)) {
    const parsed = parseCellAddress(addr);
    if (parsed) {
      populatedRows.add(parsed.row);
      populatedCols.add(parsed.col);
    }
  }
  const rows = [...populatedRows].sort((a, b) => a - b);
  const cols = visibleCols.filter((c) => populatedCols.has(c));
  const compactedCells = rows.length * cols.length;
  if (compactedCells > remainingBudget) {
    throw new Error(
      `Sheet export exceeds the ${SHEET_EXPORT_CELL_BUDGET.toLocaleString()} cell export budget.`,
    );
  }
  return { rows, cols, cellCount: compactedCells };
}

/**
 * Resolve visible column indices for a tab, honoring columnOrder and omitting
 * hiddenColumns without mutating underlying cell addresses.
 */
export function visibleOrderedColumns(tab: SheetTab, range: CellRange): number[] {
  const hidden = new Set((tab.hiddenColumns ?? []).map((col) => col.toUpperCase()));
  const base: number[] = [];
  for (let col = range.start.col; col <= range.end.col; col += 1) {
    base.push(col);
  }
  const baseSet = new Set(base);
  const ordered: number[] = [];
  const added = new Set<number>();
  for (const letters of tab.columnOrder ?? []) {
    const idx = columnIndex(letters);
    if (baseSet.has(idx) && !added.has(idx)) {
      ordered.push(idx);
      added.add(idx);
    }
  }
  for (const col of base) {
    if (!added.has(col)) ordered.push(col);
  }
  return ordered.filter((col) => !hidden.has(columnLetters(col)));
}

/** Export a SheetDocument to clean GitHub-Flavored Markdown tables and chart summaries. */
export function exportSheetToMarkdown(
  document: SheetDocument,
  evaluation: SheetEvaluation = evaluateSheet(document),
): string {
  const sections: string[] = [`# ${escapeMarkdownInline(document.title)}`];
  let remainingBudget = SHEET_EXPORT_CELL_BUDGET;

  document.tabs.forEach((tab, tabIndex) => {
    sections.push(`\n## ${escapeMarkdownInline(tab.name)}`);
    const range = usedRange(tab);
    if (!range) {
      sections.push("\n*(Empty tab)*");
    } else {
      const grid = resolveExportGrid(tab, range, remainingBudget);
      remainingBudget -= grid.cellCount;
      if (grid.cols.length === 0) {
        sections.push("\n*(All columns hidden)*");
      } else {
        const formatAt = rangeLookup(tab.formats);
        const rows = grid.rows.map((row) =>
          grid.cols.map((col) => {
            const value = evaluation.valueAt(tabIndex, { col, row });
            return escapeMarkdownCell(formatSheetValue(value, formatAt({ col, row })));
          }),
        );
        const header = rows[0] ?? grid.cols.map((col) => columnLetters(col));
        const body = rows.slice(1);
        const lines: string[] = [
          `| ${header.join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
          ...body.map((r) => `| ${r.join(" | ")} |`),
        ];
        sections.push(`\n${lines.join("\n")}`);
      }
    }

    for (const chart of tab.charts ?? []) {
      const series = chartSeries(document, evaluation, tabIndex, chart);
      sections.push(`\n### Chart: ${escapeMarkdownInline(chart.title)}`);
      if (series.points.length === 0) {
        sections.push("\n*(No chart data)*");
        continue;
      }
      const lines = [
        "| Label | Value | Share |",
        "| --- | ---: | ---: |",
        ...series.points.map(
          (point) =>
            `| ${escapeMarkdownCell(point.label)} | ${compactNumber(point.value)} | ${Math.round(point.share * 100)}% |`,
        ),
      ];
      sections.push(`\n${lines.join("\n")}`);
    }
  });

  return `${sections.join("\n")}\n`;
}

function renderChartSvg(
  chart: SheetChart,
  series: SheetChartSeries,
  palette: ReadonlyArray<string>,
): string {
  if (series.points.length === 0) {
    return `<p class="empty">No numeric values in ${escapeHtml(chart.values)}.</p>`;
  }
  const colorAt = (idx: number): string => palette[idx % palette.length] ?? "#2563eb";
  const animatedClass = chart.animate === false ? "" : " animated";

  if (chart.type === "bar") {
    const maxAbs = Math.max(1, ...series.points.map((p) => Math.abs(p.value)));
    const rows = series.points
      .map((point, idx) => {
        const pct = Math.max(2, Math.round((Math.abs(point.value) / maxAbs) * 100));
        return `<div class="bar-row">
  <span class="bar-label" title="${escapeHtml(point.label)}">${escapeHtml(point.label)}</span>
  <div class="bar-track"><div class="bar-fill${animatedClass}" style="width:${pct}%;background:${colorAt(idx)}"></div></div>
  <span class="bar-val">${escapeHtml(compactNumber(point.value))}</span>
</div>`;
      })
      .join("\n");
    return `<div class="bars">${rows}</div>`;
  }

  if (chart.type === "column") {
    const width = 560;
    const height = 220;
    const padX = 28;
    const padTop = 18;
    const padBottom = 38;
    const plotW = width - padX * 2;
    const plotH = height - padTop - padBottom;
    const minVal = Math.min(0, series.min);
    const maxVal = Math.max(0, series.max);
    const span = maxVal - minVal || 1;
    const zeroY = padTop + (maxVal / span) * plotH;
    const slot = plotW / series.points.length;
    const barW = Math.max(10, Math.min(44, slot * 0.65));
    const bars = series.points
      .map((point, idx) => {
        const scaled = (Math.abs(point.value) / span) * plotH;
        const h = point.value === 0 ? 1.5 : Math.max(2, scaled);
        const x = padX + idx * slot + (slot - barW) / 2;
        const y = point.value >= 0 ? zeroY - h : zeroY;
        const labelX = x + barW / 2;
        const valY = point.value >= 0 ? y - 5 : y + h + 11;
        return `<g>
  <rect class="svg-bar${animatedClass}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${colorAt(idx)}"><title>${escapeHtml(point.label)}: ${escapeHtml(compactNumber(point.value))}</title></rect>
  <text x="${labelX.toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle" class="svg-val">${escapeHtml(compactNumber(point.value))}</text>
  <text x="${labelX.toFixed(1)}" y="${(height - 12).toFixed(1)}" text-anchor="middle" class="svg-lbl">${escapeHtml(point.label.slice(0, 14))}</text>
</g>`;
      })
      .join("\n");
    return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">
  <line x1="${padX}" y1="${zeroY.toFixed(1)}" x2="${width - padX}" y2="${zeroY.toFixed(1)}" class="svg-axis" />
  ${bars}
</svg>`;
  }

  if (chart.type === "line") {
    const width = 560;
    const height = 220;
    const padX = 32;
    const padTop = 20;
    const padBottom = 36;
    const plotW = width - padX * 2;
    const plotH = height - padTop - padBottom;
    const minV = Math.min(0, series.min);
    const maxV = Math.max(minV + 1, series.max);
    const stepX = series.points.length > 1 ? plotW / (series.points.length - 1) : 0;
    const coords = series.points.map((point, idx) => {
      const x = series.points.length === 1 ? width / 2 : padX + idx * stepX;
      const y = padTop + plotH - ((point.value - minV) / (maxV - minV)) * plotH;
      return { x, y, point };
    });
    const pathD = coords
      .map((c, idx) => `${idx === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(" ");
    const dots = coords
      .map(
        (c) => `<g>
  <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="${colorAt(0)}"><title>${escapeHtml(c.point.label)}: ${escapeHtml(compactNumber(c.point.value))}</title></circle>
  <text x="${c.x.toFixed(1)}" y="${(height - 12).toFixed(1)}" text-anchor="middle" class="svg-lbl">${escapeHtml(c.point.label.slice(0, 12))}</text>
</g>`,
      )
      .join("\n");
    return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">
  <line x1="${padX}" y1="${padTop + plotH}" x2="${width - padX}" y2="${padTop + plotH}" class="svg-axis" />
  <path class="svg-line${animatedClass}" d="${pathD}" fill="none" stroke="${colorAt(0)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  ${dots}
</svg>`;
  }

  // Donut
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = series.points
    .filter((p) => p.share > 0)
    .map((point, idx) => {
      const dash = point.share * circumference;
      const seg = `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="${colorAt(idx)}" stroke-width="20" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"><title>${escapeHtml(point.label)}: ${escapeHtml(compactNumber(point.value))} (${Math.round(point.share * 100)}%)</title></circle>`;
      offset += dash;
      return seg;
    })
    .join("\n");
  const legend = series.points
    .map(
      (point, idx) => `<li class="legend-item">
  <span class="swatch" style="background:${colorAt(idx)}"></span>
  <span class="legend-label">${escapeHtml(point.label)}</span>
  <span class="legend-val">${escapeHtml(compactNumber(point.value))} (${Math.round(point.share * 100)}%)</span>
</li>`,
    )
    .join("\n");
  return `<div class="donut-wrap">
  <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="${escapeHtml(chart.title)}">
    <circle cx="80" cy="80" r="${radius}" fill="none" class="svg-track" stroke-width="20" />
    ${segments}
    <text x="80" y="84" text-anchor="middle" class="svg-total">${escapeHtml(compactNumber(series.total))}</text>
  </svg>
  <ul class="legend">${legend}</ul>
</div>`;
}

/**
 * Export a SheetDocument as a single self-contained, zero-CDN, zero-script HTML5 file.
 * Safe to open offline or share as a private artifact.
 */
export function exportSheetToStandaloneHtml(
  document: SheetDocument,
  options: SheetHtmlExportOptions = {},
): string {
  const mode: OfficeThemeMode = options.mode ?? "light";
  const evaluation = options.evaluation ?? evaluateSheet(document);
  const theme = options.theme;

  const surface =
    safeCssColor(theme?.surface) ?? (mode === "dark" ? "#0f172a" : "#ffffff");
  const card = mode === "dark" ? "#1e293b" : "#f8fafc";
  const text = safeCssColor(theme?.text) ?? (mode === "dark" ? "#f1f5f9" : "#0f172a");
  const muted = safeCssColor(theme?.muted) ?? (mode === "dark" ? "#94a3b8" : "#475569");
  const line = safeCssColor(theme?.line) ?? (mode === "dark" ? "#334155" : "#e2e8f0");
  const accent = safeCssColor(theme?.accent) ?? (mode === "dark" ? "#60a5fa" : "#2563eb");
  const font =
    safeFontFamily(theme?.fontFamily) ??
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const themeSeries = (theme?.series ?? [])
    .map((c) => safeCssColor(c))
    .filter((c): c is string => c !== null);
  const palette =
    themeSeries.length > 0
      ? themeSeries
      : mode === "dark"
        ? DEFAULT_SERIES_DARK
        : DEFAULT_SERIES_LIGHT;

  let remainingBudget = SHEET_EXPORT_CELL_BUDGET;
  const tabsHtml = document.tabs
    .map((tab, tabIndex) => {
      const range = usedRange(tab);
      const formatAt = rangeLookup(tab.formats);
      const styleAt = rangeLookup(tab.styles);

      let tableHtml = `<p class="empty">Empty tab</p>`;
      if (range) {
        const grid = resolveExportGrid(tab, range, remainingBudget);
        remainingBudget -= grid.cellCount;
        if (grid.cols.length > 0) {
          const rowsHtml = grid.rows.map((row) => {
            const cellsHtml = grid.cols
              .map((col) => {
                const value = evaluation.valueAt(tabIndex, { col, row });
                const style = styleAt({ col, row });
                const formatted = formatSheetValue(value, formatAt({ col, row }));
                const href = typeof value === "string" ? safeLinkHref(value) : null;
                const classes: string[] = [];
                if (style?.bold || style?.heading) classes.push("b");
                if (style?.italic) classes.push("i");
                if (style?.topBorder) classes.push("tb");
                if (style?.align) classes.push(`a-${style.align}`);
                else if (typeof value === "number") classes.push("a-right");
                if (style?.tone) classes.push(`t-${style.tone}`);
                const fill = safeCssColor(style?.fill);
                const inlineStyle = fill ? ` style="background:${fill}"` : "";
                const inner = href
                  ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(formatted)}</a>`
                  : escapeHtml(formatted);
                const tag = row === range.start.row && style?.heading ? "th" : "td";
                const cls = classes.length > 0 ? ` class="${classes.join(" ")}"` : "";
                return `<${tag}${cls}${inlineStyle}>${inner}</${tag}>`;
              })
              .join("");
            return `<tr>${cellsHtml}</tr>`;
          });
          tableHtml = `<div class="table-wrap"><table><tbody>${rowsHtml.join("\n")}</tbody></table></div>`;
        }
      }

      const chartsHtml =
        (tab.charts ?? []).length > 0
          ? `<div class="charts">${(tab.charts ?? [])
              .map((chart) => {
                const series = chartSeries(document, evaluation, tabIndex, chart);
                return `<article class="chart-card">
  <h3>${escapeHtml(chart.title)}</h3>
  ${renderChartSvg(chart, series, palette)}
</article>`;
              })
              .join("\n")}</div>`
          : "";

      return `<section class="tab-section">
  <h2>${escapeHtml(tab.name)}</h2>
  ${chartsHtml}
  ${tableHtml}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(document.title)}</title>
<style>
:root {
  --surface: ${surface};
  --card: ${card};
  --text: ${text};
  --muted: ${muted};
  --line: ${line};
  --accent: ${accent};
  --font: ${font};
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 28px 24px 48px;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
}
main { max-width: 1080px; margin: 0 auto; }
h1 { margin: 0 0 20px; font-size: 24px; font-weight: 650; letter-spacing: -0.01em; }
h2 { margin: 28px 0 12px; font-size: 17px; font-weight: 600; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 18px; }
.chart-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: minmax(90px, 140px) 1fr 64px; align-items: center; gap: 10px; font-size: 12px; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.bar-track { height: 10px; background: var(--line); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; transform-origin: left center; }
.bar-fill.animated { animation: growX 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.bar-val { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }
.chart-svg { width: 100%; height: auto; display: block; }
.svg-axis { stroke: var(--line); stroke-width: 1; }
.svg-track { stroke: var(--line); }
.svg-val { fill: var(--text); font-size: 11px; font-variant-numeric: tabular-nums; }
.svg-lbl { fill: var(--muted); font-size: 11px; }
.svg-total { fill: var(--text); font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.svg-bar.animated { transform-box: fill-box; transform-origin: center bottom; animation: growY 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.svg-line.animated { animation: fadeIn 420ms ease-out both; }
.donut-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; }
.legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; flex: 1; min-width: 160px; }
.legend-item { display: flex; align-items: center; gap: 8px; }
.swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
.legend-label { flex: 1; color: var(--muted); }
.legend-val { font-variant-numeric: tabular-nums; font-weight: 500; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 11px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
.b { font-weight: 600; }
.i { font-style: italic; }
.tb { border-top: 2px solid var(--line); }
.a-right { text-align: right; }
.a-center { text-align: center; }
.t-accent { color: var(--accent); }
.t-muted { color: var(--muted); }
.t-positive { color: #16a34a; }
.t-negative { color: #dc2626; }
.t-warning { color: #d97706; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.empty { color: var(--muted); font-size: 13px; margin: 8px 0; }
@keyframes growX { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes growY { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .bar-fill.animated, .svg-bar.animated, .svg-line.animated { animation: none !important; }
}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(document.title)}</h1>
  ${tabsHtml}
</main>
</body>
</html>`;
}
