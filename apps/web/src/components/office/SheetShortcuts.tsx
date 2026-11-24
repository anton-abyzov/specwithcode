import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { useTx } from "../../i18n";
import { type SheetPlatform, sheetShortcuts } from "./sheetKeyboard";

/** The list of keys (Cmd/Ctrl+/), with this platform's key names. */
export function SheetShortcuts(props: { readonly platform: SheetPlatform; readonly onClose: () => void }): ReactNode {
  const tx = useTx();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="office-shortcuts-backdrop" onMouseDown={props.onClose}>
      <div
        ref={ref}
        className="office-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label={tx("Keyboard shortcuts")}
        tabIndex={-1}
        data-sheet-shortcuts
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" || (event.key === "/" && (event.metaKey || event.ctrlKey))) {
            event.preventDefault();
            props.onClose();
          }
        }}
      >
        <header>
          <h2>{tx("Keyboard shortcuts")}</h2>
          <button type="button" className="office-tool" aria-label={tx("Close")} onClick={props.onClose}>
            <XIcon aria-hidden />
          </button>
        </header>
        <div className="office-shortcuts-groups">
          {sheetShortcuts(props.platform).map((group) => (
            <section key={group.group}>
              <h3>{tx(group.group)}</h3>
              <dl>
                {group.entries.map((entry) => (
                  <div key={entry.label}>
                    <dt>{tx(entry.label)}</dt>
                    <dd>
                      <kbd>{entry.keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
