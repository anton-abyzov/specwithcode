import { useState } from "react";
import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";

import { useTx } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { catalogPresence } from "./addServerPlan";
import { CATALOG_SHOWN, catalogDraft, SERVER_CATALOG, type CatalogEntry } from "./serverCatalog";
import { parseServerPaste, type PasteRefusal, type ServerDraft } from "./serverPaste";

/** The first part of adding a server: paste what its setup page gives, or pick a known one. */
export function AddServerPick({
  snapshot,
  onPick,
  onByHand,
}: {
  readonly snapshot: NativeConnectionsSnapshot;
  readonly onPick: (draft: ServerDraft, entry: CatalogEntry | null) => void;
  readonly onByHand: () => void;
}) {
  const tx = useTx();
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState<PasteRefusal | null>(null);
  const [all, setAll] = useState(false);
  const entries = all ? SERVER_CATALOG : SERVER_CATALOG.slice(0, CATALOG_SHOWN);

  function read() {
    const result = parseServerPaste(text);
    if (result === null) return;
    if (result.ok) {
      setRefusal(null);
      onPick(result.draft, null);
    } else setRefusal(result);
  }

  return (
    <div className="space-y-4" data-testid="add-server-pick">
      <form
        className="space-y-2"
        data-testid="add-server-pick-form"
        onSubmit={(event) => {
          event.preventDefault();
          read();
        }}
      >
        <label className="block space-y-1.5 text-sm">
          <span>
            {tx(
              "Paste what the server's setup page gives you: a web address, a command, or a settings block.",
            )}
          </span>
          <Textarea
            value={text}
            rows={2}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-testid="add-server-paste"
            aria-invalid={refusal !== null || undefined}
            aria-describedby={refusal !== null ? "add-server-refusal" : undefined}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) => {
              setText(event.target.value);
              setRefusal(null);
            }}
          />
        </label>
        {refusal ? (
          <div
            id="add-server-refusal"
            role="alert"
            className="space-y-2 text-sm text-destructive-foreground"
          >
            <p>{tx(refusal.reason, refusal.params)}</p>
            <Button type="button" variant="outline" onClick={onByHand}>
              {tx("Enter details by hand")}
            </Button>
          </div>
        ) : null}
        <Button type="submit" disabled={text.trim() === ""}>
          {tx("Add")}
        </Button>
      </form>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{tx("Popular servers")}</h4>
        <ul
          id="add-server-catalog"
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="add-server-catalog"
        >
          {entries.map((entry) => {
            const presence = catalogPresence(snapshot, entry);
            return (
              <li
                key={entry.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5"
                data-testid={`catalog-${entry.id}`}
              >
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium"
                >
                  {entry.title.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">{tx(entry.line)}</p>
                </div>
                {presence === "absent" ? null : <Badge variant="success">{tx("Added")}</Badge>}
                {presence === "added" ? null : (
                  <Button
                    variant="outline"

                    aria-label={`${tx(presence === "partly" ? "Add to more tools" : "Add")}: ${entry.title}`}
                    onClick={() => onPick(catalogDraft(entry), entry)}
                  >
                    {tx(presence === "partly" ? "Add to more tools" : "Add")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          {SERVER_CATALOG.length > CATALOG_SHOWN ? (
            <Button
              variant="outline"

              aria-expanded={all}
              aria-controls="add-server-catalog"
              onClick={() => setAll(!all)}
            >
              {all ? tx("Show fewer") : tx("Show all")}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onByHand}>
            {tx("Enter details by hand")}
          </Button>
        </div>
      </div>
    </div>
  );
}
