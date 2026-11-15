import type {
  DesktopCommandLineToolAction,
  DesktopCommandLineToolResult,
  DesktopCommandLineToolState,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const COMMAND_LINE_DOCS_URL =
  "https://github.com/anton-abyzov/specwithcode/blob/main/docs/user/command-line.md";

type Run = (action: DesktopCommandLineToolAction) => void;

export interface CommandLineToolViewProps {
  readonly state: DesktopCommandLineToolState | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onAction: Run;
  readonly onOpenDocs: () => void;
  /** "card": Settings > Machines. "offer": the last first-run step. */
  readonly variant: "card" | "offer";
}

const isOwn = (state: DesktopCommandLineToolState) =>
  state.install === "installed" || state.install === "other-copy" || state.install === "broken";

function Code({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

function StatusLine({ state }: { state: DesktopCommandLineToolState }) {
  const tx = useTx();
  switch (state.install) {
    case "installed":
      return (
        <p data-command-line-status="installed" className="text-sm text-foreground">
          {state.version !== null && state.version === state.appVersion
            ? tx("Installed, matches this app ({version}).", { version: state.version })
            : state.version !== null
              ? tx("Installed, version {version}; this app is {appVersion}.", {
                  version: state.version,
                  appVersion: state.appVersion,
                })
              : tx("Installed.")}{" "}
          <span className="text-muted-foreground">{state.commandPath}</span>
        </p>
      );
    case "other-copy":
      return (
        <p data-command-line-status="other-copy" className="text-sm text-foreground">
          {tx("Installed, but it runs another copy of the app at {path}.", {
            path: state.pointsAt ?? "",
          })}
        </p>
      );
    case "broken":
      return (
        <p data-command-line-status="broken" className="text-sm text-warning-foreground">
          {tx(
            "The command points at a copy of the app that is gone ({path}). Repair points it at this app.",
            {
              path: state.pointsAt ?? "",
            },
          )}
        </p>
      );
    case "blocked-managed":
      return (
        <p data-command-line-status="blocked-managed" className="text-sm text-muted-foreground">
          {tx(
            "{path} comes from the command-line install of SpecWithCode, which keeps it up to date. The app leaves it as it is.",
            {
              path: state.commandPath,
            },
          )}
        </p>
      );
    case "blocked-other":
      return (
        <p data-command-line-status="blocked-other" className="text-sm text-warning-foreground">
          {tx(
            "Something else is already at {path}. The app will not replace it; move it away to install the app's command there.",
            {
              path: state.commandPath,
            },
          )}
        </p>
      );
    case "none":
      return (
        <p data-command-line-status="none" className="text-sm text-muted-foreground">
          {tx("Not installed.")}
        </p>
      );
  }
}

function PathAdvice({
  state,
  pending,
  onAction,
}: {
  state: DesktopCommandLineToolState;
  pending: boolean;
  onAction: Run;
}) {
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  if (state.install !== "installed" || state.onPath === "yes") return null;
  if (state.platform === "win32") {
    return (
      <p className="text-sm text-muted-foreground">{tx("Open a new terminal window to use it.")}</p>
    );
  }
  const line = state.pathLine ?? "";
  return (
    <div
      data-command-line-path
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
    >
      <p className="text-sm text-foreground">
        {state.onPath === "no"
          ? tx(
              "{folder} is not on your terminal's PATH yet, so a new terminal will not find the command.",
              {
                folder: state.binDirectory,
              },
            )
          : tx(
              "The app could not read your terminal's PATH. If a new terminal says command not found, add this line.",
            )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Code>{line}</Code>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => {
            void navigator.clipboard?.writeText(line).then(() => setCopied(true));
          }}
        >
          {copied ? tx("Copied") : tx("Copy")}
        </Button>
      </div>
      {state.startupFile !== null && !state.startupLineAdded ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => onAction("add-to-path")}
          >
            {tx("Add it to {file}", { file: state.startupFile })}
          </Button>
          <span className="text-xs text-muted-foreground">
            {tx("Adds only this line, marked as added by SpecWithCode. Remove takes it out again.")}
          </span>
        </div>
      ) : null}
      {state.startupLineAdded ? (
        <p className="text-xs text-muted-foreground">
          {tx("Added to {file}. Open a new terminal window to use it.", {
            file: state.startupFile ?? "",
          })}
        </p>
      ) : null}
    </div>
  );
}

const UNAVAILABLE: Record<NonNullable<DesktopCommandLineToolState["unavailable"]>, string> = {
  development: "A development build has no command to install.",
  "temporary-location":
    "This copy of the app runs from a disk image or a temporary folder. Move SpecWithCode to Applications and open it from there first.",
  "missing-shim": "This copy of the app has no specwithcode command inside it. Reinstall the app.",
};

export function CommandLineToolView(props: CommandLineToolViewProps) {
  const tx = useTx();
  const { state, pending, error, onAction } = props;
  const what = (
    <p className="text-sm text-muted-foreground">
      {tx(
        "The specwithcode command is this app driven from a terminal: the same version as the app, talking to the app that is already running. It is not a second copy and needs no separate sign-in. Use it over SSH, on a machine with no screen, or in scripts and agents.",
      )}{" "}
      <button
        type="button"
        className="text-foreground underline underline-offset-2"
        onClick={props.onOpenDocs}
      >
        {tx("What is this?")}
      </button>
    </p>
  );
  const changes =
    state === null ? null : (
      <p className="text-xs text-muted-foreground">
        {state.platform === "win32"
          ? tx(
              "Installing writes {path}, which runs the command inside the app, and adds {folder} to your user PATH. No administrator password.",
              {
                path: state.commandPath,
                folder: state.binDirectory,
              },
            )
          : tx(
              "Installing adds {path}, a link to the command inside the app. Nothing else changes, and no administrator password is needed.",
              {
                path: state.commandPath,
              },
            )}
      </p>
    );
  const own = state !== null && isOwn(state);
  const actions =
    state === null || state.unavailable !== null ? null : (
      <div className="flex flex-wrap items-center gap-2">
        {state.install === "none" ? (
          <Button size="sm" disabled={pending} onClick={() => onAction("install")}>
            {tx("Install command-line tool")}
          </Button>
        ) : null}
        {state.install === "broken" ? (
          <Button size="sm" disabled={pending} onClick={() => onAction("install")}>
            {tx("Repair")}
          </Button>
        ) : null}
        {state.install === "other-copy" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onAction("install")}
          >
            {tx("Use this copy")}
          </Button>
        ) : null}
        {own ? (
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={pending}
            onClick={() => onAction("remove")}
          >
            {tx("Remove")}
          </Button>
        ) : null}
      </div>
    );
  const body = (
    <div className="flex flex-col gap-3 px-4 py-3">
      {what}
      {state === null ? (
        <p className="text-sm text-muted-foreground">{tx("Checking…")}</p>
      ) : (
        <>
          {state.unavailable !== null ? (
            <p data-command-line-status="unavailable" className="text-sm text-muted-foreground">
              {tx(UNAVAILABLE[state.unavailable])}
            </p>
          ) : (
            <StatusLine state={state} />
          )}
          {state.shadowedBy !== null ? (
            <p data-command-line-shadowed className="text-sm text-warning-foreground">
              {tx(
                "A different specwithcode at {path} comes first on your PATH, so a terminal runs that one instead. The app did not change it.",
                {
                  path: state.shadowedBy,
                },
              )}
            </p>
          ) : null}
          <PathAdvice state={state} pending={pending} onAction={onAction} />
          {state.install === "none" && state.unavailable === null ? changes : null}
          {actions}
        </>
      )}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
  if (props.variant === "offer") {
    return (
      <div data-command-line-offer className="rounded-xl border border-border/60">
        <p className="px-4 pt-3 text-sm font-medium text-foreground">{tx("Command line")}</p>
        {body}
      </div>
    );
  }
  return (
    <SettingsSection {...searchableSetting("command-line-tool")} data-command-line-card>
      {body}
    </SettingsSection>
  );
}

/** The desktop bridge's command-line tool action, or undefined in a browser or an older app. */
const bridgeAction = () =>
  typeof window === "undefined" ? undefined : window.desktopBridge?.commandLineTool;

export function useCommandLineTool() {
  const action = bridgeAction();
  const [state, setState] = useState<DesktopCommandLineToolState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    (next: DesktopCommandLineToolAction) => {
      if (action === undefined) return;
      setPending(true);
      action(next)
        .then((result: DesktopCommandLineToolResult) => {
          setState(result.state);
          setError(result.ok ? null : result.reason);
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setPending(false));
    },
    [action],
  );
  useEffect(() => {
    if (action === undefined) return;
    let live = true;
    void action("inspect")
      .then((result) => {
        if (live) setState(result.state);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [action]);
  return { available: action !== undefined, state, pending, error, run };
}

export function CommandLineCard({ variant = "card" }: { variant?: "card" | "offer" }) {
  const tool = useCommandLineTool();
  if (!tool.available) return null;
  return (
    <CommandLineToolView
      variant={variant}
      state={tool.state}
      pending={tool.pending}
      error={tool.error}
      onAction={tool.run}
      onOpenDocs={() => {
        void window.desktopBridge?.openExternal(COMMAND_LINE_DOCS_URL);
      }}
    />
  );
}
