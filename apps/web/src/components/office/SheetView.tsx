import {
  type OfficeThemeMode,
  type OfficeThemeSource,
  type SheetChartOverrides,
  type SheetChartType,
  type SheetDocument,
  type SheetTab,
  SHEET_LIMITS,
  addChart,
  cellInputText,
  cellName,
  chartFromSelection,
  columnLetters,
  evaluateSheet,
  exportSheetToMarkdown,
  exportSheetToStandaloneHtml,
  formatSheetValue,
  officeThemeVariables,
  rangeName,
  removeChart,
  resolveOfficeTheme,
  sheetColumnWidth,
} from "@specweave-studio/shared/officeSheet";
import { BarChart3Icon, Columns3Icon, CopyIcon, DownloadIcon } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { Button } from "../ui/button";
import { SheetCellEditor } from "./SheetCellEditor";
import { SheetContextMenu } from "./SheetContextMenu";
import { SheetFormatBar } from "./SheetFormatBar";
import { SheetFormulaBar } from "./SheetFormulaBar";
import { SheetGrid } from "./SheetGrid";
import { SheetShortcuts } from "./SheetShortcuts";
import { SheetTabs } from "./SheetTabs";
import { type SheetPlatform, detectSheetPlatform } from "./sheetKeyboard";
import { useSheetEditor } from "./useSheetEditor";
import { SheetColumnsPanel, SheetConflictBanner, SheetInsertChartForm } from "./SheetPanels";
import {
  type ColumnSortState,
  type Selection,
  chartOverrideKey,
  normalize,
  sheetGridModel,
} from "./sheetGridModel";
import { type SheetSaveHandler, useSheetDraft } from "./useSheetDraft";

export { SHEET_VIEW_COLUMNS, SHEET_VIEW_ROWS } from "./sheetGridModel";

function updateTab(
  document: SheetDocument,
  tabIndex: number,
  updater: (tab: SheetTab) => SheetTab,
): SheetDocument {
  return {
    ...document,
    tabs: document.tabs.map((entry, idx) => (idx === tabIndex ? updater(entry) : entry)),
  };
}

function slugFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${slug || "sheet"}.html`;
}

/**
 * A sheet artifact: tabs, a formula bar, a grid of computed and formatted
 * cells, and the charts bound to its ranges. The file is data; nothing in it
 * runs. With `onSave`, a selected range becomes a chart saved into the file.
 */
export function SheetView(props: {
  readonly text: string;
  readonly mode: OfficeThemeMode;
  readonly themeSource?: OfficeThemeSource | null | undefined;
  /** Writes the new file contents; resolves false on failure or "conflict" on revision mismatch. */
  readonly onSave?: SheetSaveHandler | undefined;
  /** Re-fetches the latest file contents from disk (used on conflict and Reload latest). */
  readonly onReload?: (() => void | Promise<void>) | undefined;
  /** Tells the host which design system the file names, so it can load it. */
  readonly onDesignSystem?: ((id: string | null) => void) | undefined;
  /** Optional hook for HTML export (defaults to browser Blob download). */
  readonly onExportHtml?: ((html: string, filename: string) => void) | undefined;
  /** Optional hook for Markdown copy (defaults to navigator.clipboard.writeText). */
  readonly onCopyMarkdown?: ((markdown: string) => void | Promise<void>) | undefined;
  /** Which command key the shortcuts use; detected from the browser when left out. */
  readonly platform?: SheetPlatform | undefined;
}): ReactNode {
  const tx = useTx();
  const {
    isOwnRevision,
    parsed,
    document,
    draft,
    incomingRevision,
    hasExternalConflict,
    saving,
    saveError,
    setSaveError,
    save,
    showOnly,
    discard,
  } = useSheetDraft({ text: props.text, onSave: props.onSave, onReload: props.onReload });
  const [tabIndex, setTabIndex] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [inserting, setInserting] = useState(false);
  const [organizingColumns, setOrganizingColumns] = useState(false);
  const [chartType, setChartType] = useState<SheetChartType>("bar");
  const [chartTitle, setChartTitle] = useState("");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [chartOverrides, setChartOverrides] = useState<Record<string, SheetChartOverrides>>({});
  const [columnSort, setColumnSort] = useState<ColumnSortState | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});

  const designSystem = document?.designSystem ?? null;
  const { onDesignSystem } = props;
  useEffect(() => {
    onDesignSystem?.(designSystem);
  }, [designSystem, onDesignSystem]);

  const evaluation = useMemo(() => (document ? evaluateSheet(document) : null), [document]);
  const theme = useMemo(
    () => officeThemeVariables(resolveOfficeTheme(props.themeSource, props.mode)),
    [props.mode, props.themeSource],
  );

  const activeIndex = document ? Math.min(tabIndex, document.tabs.length - 1) : 0;
  const tab = document?.tabs[activeIndex];

  const effectiveTab = useMemo<SheetTab | undefined>(() => {
    if (!tab) return undefined;
    if (Object.keys(localWidths).length === 0) return tab;
    return { ...tab, widths: { ...tab.widths, ...localWidths } };
  }, [localWidths, tab]);

  const reach = selection?.focus;
  const grid = useMemo(() => {
    if (!effectiveTab || !document || !evaluation) return null;
    return sheetGridModel({
      document,
      evaluation,
      tab: effectiveTab,
      tabIndex: activeIndex,
      chartOverrides,
      collapsedGroups,
      columnSort,
      reach,
    });
  }, [activeIndex, chartOverrides, collapsedGroups, columnSort, document, effectiveTab, evaluation, reach]);

  const platform = useMemo(() => props.platform ?? detectSheetPlatform(), [props.platform]);
  const editable = props.onSave !== undefined && !hasExternalConflict;
  const selectTab = (index: number) => {
    setTabIndex(index);
    setSelection(null);
    setInserting(false);
    setColumnSort(null);
    setLocalWidths({});
  };
  const editor = useSheetEditor({
    document,
    evaluation,
    tab,
    tabIndex: activeIndex,
    grid,
    editable,
    blockedReason:
      props.onSave && hasExternalConflict
        ? tx("Resolve the conflict before saving more changes.")
        : null,
    platform,
    selection,
    setSelection,
    selectTab: (index) => {
      editor.reset();
      selectTab(index);
    },
    save,
    setSaveError,
    isOwnRevision,
    incomingRevision,
  });

  if (!parsed.ok) {
    return (
      <div className="office-problem" role="alert">
        <p>{tx("This sheet could not be read.")}</p>
        <p className="text-muted-foreground">{parsed.error}</p>
      </div>
    );
  }
  if (!document || !evaluation || !tab || !effectiveTab || !grid) return null;

  const range = selection ? normalize(selection.anchor, selection.focus) : null;
  const focusInput = selection ? tab.cells[cellName(selection.focus)] : undefined;
  const focusValue = selection ? evaluation.valueAt(activeIndex, selection.focus) : null;

  /** A layout change: saved when the sheet can be saved, otherwise only shown. */
  const saveOrShow = (next: SheetDocument) => {
    if (props.onSave) void editor.commit(() => next);
    else showOnly(next);
  };

  const insertChart = async () => {
    if (!range) return;
    const chart = chartFromSelection(tab, range, chartType, chartTitle);
    if (await (editor.commit((doc) => addChart(doc, activeIndex, chart)) ?? false)) {
      setInserting(false);
      setChartTitle("");
    }
  };

  const toggleColumnSort = (col: number) => {
    setColumnSort((current) => {
      if (!current || current.col !== col) return { col, direction: "asc" };
      if (current.direction === "asc") return { col, direction: "desc" };
      return null;
    });
  };

  const startColumnResize = (col: number, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const letter = columnLetters(col);
    const startX = event.clientX;
    const startWidth = sheetColumnWidth(effectiveTab, col);
    let latestWidth = startWidth;

    const onMove = (moveEvent: MouseEvent) => {
      latestWidth = Math.max(
        56,
        Math.min(480, Math.round(startWidth + (moveEvent.clientX - startX))),
      );
      setLocalWidths((prev) => ({ ...prev, [letter]: latestWidth }));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (props.onSave && latestWidth !== startWidth) {
        const nextDoc = updateTab(document, activeIndex, (current) => ({
          ...current,
          widths: { ...current.widths, [letter]: latestWidth },
        }));
        void (editor.commit(() => nextDoc) ?? Promise.resolve(false)).then((ok) => {
          if (ok) {
            setLocalWidths((prev) => {
              const copy = { ...prev };
              delete copy[letter];
              return copy;
            });
          }
        });
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleColumnHidden = (col: number) => {
    const letter = columnLetters(col);
    const currentHidden = new Set((tab.hiddenColumns ?? []).map((entry) => entry.toUpperCase()));
    if (currentHidden.has(letter)) {
      currentHidden.delete(letter);
    } else {
      currentHidden.add(letter);
    }
    const nextHidden = [...currentHidden];
    saveOrShow(
      updateTab(document, activeIndex, (current) => {
        if (nextHidden.length > 0) {
          return { ...current, hiddenColumns: nextHidden };
        }
        const { hiddenColumns: _removed, ...rest } = current;
        return rest;
      }),
    );
  };

  const moveColumnOrder = (col: number, delta: -1 | 1) => {
    const order = [...grid.displayCols];
    const pos = order.indexOf(col);
    const target = pos + delta;
    if (pos < 0 || target < 0 || target >= order.length) return;
    [order[pos], order[target]] = [order[target]!, order[pos]!];
    const nextOrder = order.map((entry) => columnLetters(entry));
    saveOrShow(
      updateTab(document, activeIndex, (current) => ({ ...current, columnOrder: nextOrder })),
    );
  };

  const handleExportHtml = () => {
    setSaveError(null);
    let html: string;
    try {
      html = exportSheetToStandaloneHtml(document, {
        mode: props.mode,
        evaluation,
        theme: resolveOfficeTheme(props.themeSource, props.mode),
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : tx("Export failed."));
      return;
    }
    const filename = slugFileName(document.title);
    if (props.onExportHtml) {
      props.onExportHtml(html, filename);
      return;
    }
    if (typeof Blob === "undefined" || typeof URL === "undefined") return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = filename;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleCopyMarkdown = async () => {
    setSaveError(null);
    try {
      const markdown = exportSheetToMarkdown(document, evaluation);
      if (props.onCopyMarkdown) {
        await props.onCopyMarkdown(markdown);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      }
      setCopyStatus(tx("Copied Markdown"));
      setTimeout(() => setCopyStatus(null), 2000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : tx("Export failed."));
    }
  };

  const chartsFull = (tab.charts?.length ?? 0) >= SHEET_LIMITS.chartsPerTab;
  const style = {
    ...theme,
    ...(theme["--office-font"] ? { fontFamily: theme["--office-font"] } : {}),
  };

  return (
    <div className="office-surface office-sheet" style={style as CSSProperties} data-office="sheet">
      <div className="office-sheet-bar">
        <SheetFormulaBar
          address={range ? rangeName(range) : ""}
          value={
            focusInput === undefined
              ? ""
              : typeof focusInput === "boolean"
                ? formatSheetValue(focusValue, undefined)
                : cellInputText(focusInput)
          }
          editable={editable && selection !== null}
          editing={editor.editing?.origin === "bar"}
          mirroring={editor.editing?.origin === "cell"}
          store={editor.store}
          platform={platform}
          onStartEdit={() => {
            if (selection) editor.beginEdit(selection.focus, null, false, "bar");
          }}
          onAction={editor.onEditorAction}
          onGoTo={editor.goTo}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={organizingColumns}
          onClick={() => setOrganizingColumns((open) => !open)}
          data-sheet-columns-toggle
        >
          <Columns3Icon aria-hidden />
          {tx("Columns")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleCopyMarkdown()}
          data-sheet-copy-md
        >
          <CopyIcon aria-hidden />
          {copyStatus ?? tx("Copy Markdown")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleExportHtml}
          data-sheet-export-html
        >
          <DownloadIcon aria-hidden />
          {tx("Export HTML")}
        </Button>
        {props.onSave ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={range === null || chartsFull || saving}
            title={range === null ? tx("Select the cells to chart first.") : undefined}
            onClick={() => setInserting((open) => !open)}
            data-sheet-insert-chart
          >
            <BarChart3Icon aria-hidden />
            {tx("Insert chart")}
          </Button>
        ) : null}
      </div>
      {props.onSave ? (
        <SheetFormatBar
          style={selection ? grid.styleOf(selection.focus) : undefined}
          format={selection ? grid.formatOf(selection.focus) : undefined}
          disabled={!editable || selection === null}
          canUndo={editable && editor.canUndo}
          canRedo={editable && editor.canRedo}
          shortcutHint={platform === "mac" ? "⌘/" : "Ctrl+/"}
          onUndo={editor.undo}
          onRedo={editor.redo}
          onToggle={editor.toggle}
          onAlign={editor.align}
          onFill={editor.fill}
          onNumber={editor.number}
          onDecimals={editor.decimals}
          onBorders={editor.borders}
          onShortcuts={() => editor.setShortcutsOpen(true)}
        />
      ) : null}
      {hasExternalConflict && draft ? (
        <SheetConflictBanner
          canKeep={props.onSave !== undefined}
          refreshing={incomingRevision === draft.baseRevision}
          saving={saving}
          onReload={() => {
            discard();
            editor.reset();
            editor.clearHistory();
            void props.onReload?.();
          }}
          onKeep={() => void save(draft.document, { force: true })}
        />
      ) : null}
      {organizingColumns ? (
        <SheetColumnsPanel
          columns={grid.columns}
          hidden={tab.hiddenColumns ?? []}
          onToggle={toggleColumnHidden}
          onMove={moveColumnOrder}
        />
      ) : null}
      {inserting && range ? (
        <SheetInsertChartForm
          range={range}
          chartType={chartType}
          title={chartTitle}
          saving={saving}
          onType={setChartType}
          onTitle={setChartTitle}
          onSubmit={() => void insertChart()}
          onCancel={() => setInserting(false)}
        />
      ) : null}
      {saveError ? (
        <p className="office-sheet-note" role="alert">
          {saveError}
        </p>
      ) : null}
      {grid.clipped ? (
        <p className="office-sheet-note" role="status">
          {renderRich(tx("Showing the first {rows} rows and {columns} columns."), {
            rows: String(grid.rows),
            columns: String(grid.columns),
          })}
        </p>
      ) : null}
      <SheetGrid
        tab={effectiveTab}
        tabIndex={activeIndex}
        grid={grid}
        evaluation={evaluation}
        range={range}
        focus={selection?.focus ?? null}
        columnSort={columnSort}
        chartOverrides={chartOverrides}
        onChartOverrides={(key, next) => setChartOverrides((prev) => ({ ...prev, [key]: next }))}
        onRemoveChart={
          props.onSave && !saving
            ? (chartId) => {
                const key = chartOverrideKey(tab.name, chartId);
                setChartOverrides((prev) => {
                  const { [key]: _removed, ...rest } = prev;
                  return rest;
                });
                void editor.commit((doc) => removeChart(doc, activeIndex, chartId));
              }
            : undefined
        }
        onPick={editor.pick}
        onSortColumn={toggleColumnSort}
        onResizeStart={startColumnResize}
        onToggleGroup={(key, collapsed) =>
          setCollapsedGroups((prev) => ({ ...prev, [key]: collapsed }))
        }
        onKeyDown={editor.onGridKeyDown}
        scrollRef={editor.scrollRef}
        editing={editor.editing?.tabIndex === activeIndex ? editor.editing.address : null}
        editor={
          editor.editing ? (
            <SheetCellEditor
              store={editor.store}
              platform={platform}
              typing={editor.editing.typing}
              focused={editor.editing.origin === "cell"}
              onAction={editor.onEditorAction}
            />
          ) : null
        }
        onEdit={editable ? (address) => editor.beginEdit(address, null, false) : undefined}
        onHeader={editor.pickHeader}
        onContextMenu={editable ? editor.openMenu : undefined}
      />
      <SheetTabs
        tabs={document.tabs}
        active={activeIndex}
        editable={editable}
        onSelect={(index) => {
          if (editor.editing) editor.commitEdit(null);
          editor.reset();
          selectTab(index);
        }}
        onAdd={editor.newTab}
        onRename={editor.renameTabAt}
        onDelete={editor.deleteTabAt}
      />
      <SheetContextMenu
        target={editor.menu}
        onClose={() => editor.setMenu(null)}
        onCommand={editor.structure}
      />
      {editor.shortcutsOpen ? (
        <SheetShortcuts
          platform={platform}
          onClose={() => {
            editor.setShortcutsOpen(false);
            editor.focusGrid();
          }}
        />
      ) : null}
    </div>
  );
}
