// The Word editor over a .docx that shoot.mjs keeps on disk: GET /open reads
// it with the server's reader, POST /save writes it with the server's writer.
// Query: ?theme=light|dark, ?loss=1 (pretend a save would drop something).
import type { DesignDocumentOpenResult, OfficeDocument } from "@specweave-studio/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { DocumentEditor } from "~/components/office/document/DocumentEditor";
import { documentToMarkdown } from "@specweave-studio/shared/officeDocument";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const fixture = window as unknown as { saves: number; markdown?: string };
fixture.saves = 0;

function App(): ReactNode {
  const [opened, setOpened] = useState<DesignDocumentOpenResult | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const load = useCallback(async () => {
    const value = (await (await fetch("/open")).json()) as DesignDocumentOpenResult;
    setRevision(value.revision);
    setOpened(
      params.get("loss") === "1" ? { ...value, lossOnSave: ["Comments"], keptNotShown: ["Headers and footers"] } : value,
    );
  }, []);
  useEffect(() => void load(), [load]);
  if (!opened) return null;
  return (
    <div className="flex h-screen flex-col">
      <DocumentEditor
        key={opened.revision}
        name="field-notes.docx"
        document={opened.document}
        lossOnSave={opened.lossOnSave}
        keptNotShown={opened.keptNotShown}
        autosaveMs={400}
        onSave={async (document: OfficeDocument, options) => {
          fixture.saves += 1;
          const response = await fetch("/save", {
            method: "POST",
            body: JSON.stringify({ document, expectedRevision: options.force ? null : revision }),
          });
          if (response.status === 409) return "conflict";
          if (!response.ok) return "failed";
          setRevision(((await response.json()) as { revision: string }).revision);
          return "saved";
        }}
        onReload={() => void load()}
        onExportMarkdown={(document) => {
          fixture.markdown = documentToMarkdown(document);
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
