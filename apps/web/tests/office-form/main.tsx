// The form view over a form and its responses Sheet that shoot.mjs keeps on
// disk: GET and POST /form and /sheet, POSTs by revision (409 on a conflict).
// Query: ?theme=light|dark, ?tab=edit|fill|responses.
import { formResponseCount, formatSubmittedAt } from "@specweave-studio/shared/officeForm";
import { parseSheetDocument } from "@specweave-studio/shared/officeSheet";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { FormView, type FormTab } from "~/components/office/form/FormView";
import { submitFormResponse } from "~/components/office/form/submitFormResponse";
import { SheetView } from "~/components/office/SheetView";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const tab = (params.get("tab") ?? "edit") as FormTab;

async function post(path: string, contents: string, expectedRevision: string | undefined) {
  const response = await fetch(path, {
    method: "POST",
    body: JSON.stringify({ contents, expectedRevision }),
  });
  return response.status === 409
    ? ("conflict" as const)
    : response.ok
      ? (true as const)
      : { error: `HTTP ${response.status}` };
}

function App(): ReactNode {
  const [form, setForm] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const loadForm = useCallback(async () => setForm(await (await fetch("/form")).text()), []);
  const loadSheet = useCallback(async () => {
    const response = await fetch("/sheet");
    setSheet(response.ok ? await response.text() : null);
  }, []);
  useEffect(() => {
    void loadForm();
    void loadSheet();
  }, [loadForm, loadSheet]);
  if (form === null) return null;
  const parsed = sheet === null ? null : parseSheetDocument(sheet);
  return (
    <div className="flex h-screen flex-col">
      <FormView
        text={form}
        initialTab={tab}
        onReload={() => void loadForm()}
        onSave={async (contents, expectedRevision) => {
          const outcome = await post("/form", contents, expectedRevision);
          if (outcome === true) setForm(contents);
          return outcome === true ? true : outcome === "conflict" ? "conflict" : false;
        }}
        onSubmit={async (document, answers) => {
          const outcome = await submitFormResponse({
            document,
            answers,
            submittedAt: formatSubmittedAt(new Date()),
            read: async () => {
              const response = await fetch("/sheet");
              if (response.status === 404) return { _tag: "gone" };
              return response.ok
                ? { _tag: "contents", contents: await response.text() }
                : { _tag: "unavailable" };
            },
            write: (contents, expectedRevision) => post("/sheet", contents, expectedRevision),
          });
          await loadSheet();
          return outcome;
        }}
        responseCount={parsed?.ok ? formResponseCount(parsed.document) : null}
        responses={
          sheet === null ? (
            <p>No Sheet</p>
          ) : (
            <SheetView text={sheet} mode={dark ? "dark" : "light"} />
          )
        }
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
