import { SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A stand-in for the app: sidebar with its footer, the project header with its settings. */
export function Shell({
  footer,
  main,
  host,
}: {
  footer: ReactNode;
  main: ReactNode;
  host: ReactNode;
}) {
  return (
    <div className="fx-shell">
      <aside className="fx-sidebar">
        <div className="fx-sidebar-list">
          <p>specweave</p>
          <p>Machine color top line</p>
          <p>Join code pop-up</p>
        </div>
        <div className="fx-sidebar-footer">
          {footer}
          <div className="px-2 text-xs text-muted-foreground">Anton · Settings</div>
        </div>
      </aside>
      <main className="fx-main">
        <header className="fx-topbar" data-project-header>
          <span className="font-medium">specweave</span>
          <button
            type="button"
            data-project-settings
            aria-label="Project settings"
            className="inline-flex size-7 items-center justify-center rounded-md border border-border"
          >
            <SettingsIcon className="size-4" />
          </button>
          <span className="ml-2 text-muted-foreground">Join code pop-up · M5</span>
        </header>
        {main ? (
          <div className="fx-settings">
            <h1 className="mb-4 text-lg font-semibold">Settings › Machines</h1>
            {main}
          </div>
        ) : (
          <div className="fx-chat">The thread's messages sit here.</div>
        )}
      </main>
      {host}
    </div>
  );
}
