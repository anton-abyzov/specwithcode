// The sheet viewer over a fictional workbook, and the Excel and Word previews
// over a parsed file. Query:
//   ?view=sheet               the demo workbook (Loan, Investment, Revenue), editable
//   ?view=workbook            a parsed .xlsx, read from /workbook.json (shoot.mjs writes it)
//   ?view=document            a parsed .docx, read from /document.json
//   ?tab=Loan|Investment|Revenue   the tab to open
//   ?animate=off              every chart with animate: false
//   ?theme=light|dark
import type {
  DesignPreviewDocumentResult,
  DesignPreviewWorkbookResult,
} from "@specweave-studio/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { DocxDocumentView, workbookSummary } from "~/components/files/OfficeDocumentPreview";
import { SheetView } from "~/components/office/SheetView";
import { demoWorkbook } from "./sheets";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const mode = dark ? "dark" : "light";
const view = params.get("view") ?? "sheet";

/** The demo workbook, saved in memory so a chart or layout change shows at once. */
function DemoSheet(): ReactNode {
  const [text, setText] = useState(() => demoWorkbook({ animate: params.get("animate") !== "off" }));
  const tab = params.get("tab");
  useEffect(() => {
    if (!tab) return;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".office-sheet-tabs > button")) {
      if (button.textContent?.trim() === tab) button.click();
    }
  }, [tab]);
  return (
    <SheetView
      text={text}
      mode={mode}
      onSave={async (contents) => {
        setText(contents);
        return true;
      }}
      onExportHtml={(html) => {
        (window as unknown as { exportedHtml?: string }).exportedHtml = html;
      }}
    />
  );
}

function useJson<T>(path: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    void fetch(path)
      .then((response) => response.json())
      .then(setData);
  }, [path]);
  return data;
}

/** A parsed workbook, laid out as the app's Excel preview lays it out. */
function Workbook(): ReactNode {
  const preview = useJson<DesignPreviewWorkbookResult>("/workbook.json");
  if (!preview) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-xlsx-preview="store-plan.xlsx">
      <div
        className="shrink-0 border-b bg-muted/30 px-4 py-1.5 text-muted-foreground text-xs"
        role="status"
      >
        {workbookSummary(preview)}
      </div>
      <div className="flex min-h-0 flex-1">
        <SheetView text={preview.sheetJson} mode={mode} />
      </div>
    </div>
  );
}

function WordDocument(): ReactNode {
  const preview = useJson<DesignPreviewDocumentResult>("/document.json");
  return preview ? <DocxDocumentView name="store-plan.docx" preview={preview} /> : null;
}

createRoot(document.getElementById("root")!).render(
  <main className="flex h-screen flex-col bg-background text-foreground">
    {view === "workbook" ? <Workbook /> : view === "document" ? <WordDocument /> : <DemoSheet />}
  </main>,
);
