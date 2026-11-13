import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  MachineToolId,
  MachineToolsCheck,
} from "@specweave-studio/contracts";
import { CheckIcon, ExternalLinkIcon, GitBranchIcon, GithubIcon, HexagonIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useT, useTx } from "../../i18n";
import type { MachineToolInstallState } from "../../studio/machineTools";
import { Button } from "../ui/button";
import {
  linuxGitCommand,
  MACHINE_TOOL_DOWNLOADS,
  MACHINE_TOOL_NAMES,
  MachineToolLog,
  useMachineTools,
} from "../machineTools/machineToolsUi";
import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";

const ICONS: Readonly<Record<MachineToolId, ReactNode>> = {
  git: <GitBranchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
  node: <HexagonIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
  gh: <GithubIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
};

/** A link to a tool's own download page, for a machine the app cannot install it on. */
function DownloadLink({ tool }: { readonly tool: MachineToolId }) {
  const tx = useTx();
  const name = MACHINE_TOOL_NAMES[tool];
  return (
    <Button
      size="sm"
      variant="outline"
      render={<a href={MACHINE_TOOL_DOWNLOADS[tool]} target="_blank" rel="noreferrer" />}
    >
      <ExternalLinkIcon aria-hidden />
      {tx("Get {tool}", { tool: name })}
    </Button>
  );
}

/**
 * One missing tool: what it is for, one button (or the command or link the
 * person needs when the app cannot install it there), and its log.
 */
export function MachineToolRow({
  tool,
  check,
  os,
  install,
  wasMissing,
  readOnly,
  onInstall,
  onCheckAgain,
}: {
  readonly tool: MachineToolId;
  readonly check: MachineToolsCheck;
  readonly os: ExecutionEnvironmentPlatformOs | undefined;
  readonly install: MachineToolInstallState;
  /** Missing when setup opened; it stays on screen as Ready once installed. */
  readonly wasMissing: boolean;
  readonly readOnly: boolean;
  readonly onInstall: () => void;
  readonly onCheckAgain: () => void;
}) {
  const t = useT();
  const tx = useTx();
  const name = MACHINE_TOOL_NAMES[tool];
  const present = check[tool] === "present";
  const mine = install.tool === tool;
  const running = mine && install.status === "running";
  const failed = mine && install.status === "failed";
  const handedOff = mine && install.status === "done" && install.handedOff && !present;
  const otherRunning = install.status === "running" && !mine;
  const installable = check.installable.includes(tool);
  const linuxCommand =
    tool === "git" && os === "linux" ? linuxGitCommand(check.packageManager) : null;
  if (present && !wasMissing) return null;

  const uses =
    tool === "git"
      ? tx("Recommended. Agents use Git to track and undo their changes.")
      : tool === "node"
        ? tx("Recommended. SpecWeave runs on Node.js, and many agent tools need it.")
        : tx("Publishes projects to GitHub and opens pull requests from the app.");

  const detail = present ? (
    tool === "gh" ? (
      tx("Installed. Sign in to GitHub with gh auth login when you want to publish.")
    ) : null
  ) : running ? (
    tx("Installing. Its log is below.")
  ) : handedOff ? (
    tx(
      "Confirm in the macOS window that opened. The download can take a few minutes, and this row updates when it is done.",
    )
  ) : failed ? (
    <span className="text-warning-foreground">
      {tx("The install ended with an error. Its log is below.")}
    </span>
  ) : readOnly && tool === "git" && os === "darwin" ? (
    tx("Not installed. Run this command in a terminal on that Mac, then press Check again.")
  ) : readOnly && linuxCommand === null ? (
    tx(
      "Not installed. Get it from its own site, or ask someone who can maintain this machine to install it from here.",
    )
  ) : tool === "git" && os === "darwin" ? (
    tx(
      "Not installed. On a Mac it comes with Apple's developer tools. Without them, macOS shows its own prompt the first time something runs Git.",
    )
  ) : tool === "git" && installable ? (
    tx("Not installed. One click installs it with winget, and Windows asks for your permission.")
  ) : tool === "git" && os === "windows" ? (
    tx("Not installed. Download Git for Windows, install it, then press Check again.")
  ) : linuxCommand !== null ? (
    tx("Not installed. Run this command in a terminal, then press Check again.")
  ) : tool === "git" ? (
    tx("Not installed. Install Git with your system's package manager, then press Check again.")
  ) : installable && tool === "node" ? (
    tx(
      "Not installed. One click installs Node.js 22 in SpecWithCode's own folder, with no admin password. A Node.js you install yourself later still comes first.",
    )
  ) : installable ? (
    tx("Not installed. One click installs it in SpecWithCode's own folder, with no admin password.")
  ) : (
    tx("Not installed. Get it from its own site, then press Check again.")
  );

  const readOnlyMacGit = readOnly && tool === "git" && os === "darwin";
  const action = present ? undefined : readOnly ? (
    <>
      {readOnlyMacGit || linuxCommand !== null ? null : <DownloadLink tool={tool} />}
      <Button size="sm" variant="ghost" onClick={onCheckAgain}>
        {tx("Check again")}
      </Button>
    </>
  ) : installable ? (
    running ? undefined : (
      <Button
        size="sm"
        variant="outline"
        disabled={otherRunning}
        aria-label={tx("Install {tool}", { tool: name })}
        onClick={onInstall}
      >
        {handedOff
          ? tx("Ask again")
          : failed
            ? t("wizard.retry")
            : tx("Install {tool}", { tool: name })}
      </Button>
    )
  ) : linuxCommand !== null || tool === "git" ? (
    <>
      {os === "windows" ? <DownloadLink tool={tool} /> : null}
      <Button size="sm" variant="ghost" onClick={onCheckAgain}>
        {tx("Check again")}
      </Button>
    </>
  ) : (
    <>
      <DownloadLink tool={tool} />
      <Button size="sm" variant="ghost" onClick={onCheckAgain}>
        {tx("Check again")}
      </Button>
    </>
  );

  return (
    <AgentRow
      agent={tool}
      state={
        present
          ? "present"
          : running
            ? "installing"
            : handedOff
              ? "requested"
              : failed
                ? "install-failed"
                : "missing"
      }
      icon={ICONS[tool]}
      name={name}
      uses={uses}
      detail={detail}
      status={
        present ? (
          <AgentRowStatus tone="ready">{t("wizard.agents.ready")}</AgentRowStatus>
        ) : running || handedOff ? (
          <AgentRowStatus tone="checking">{tx("Installing…")}</AgentRowStatus>
        ) : undefined
      }
      action={action}
    >
      {mine && !present && (running || failed || install.lines.length > 0) ? (
        <MachineToolLog
          lines={install.lines}
          status={install.status}
          detail={failed ? install.detail : null}
        />
      ) : null}
      {!present && readOnlyMacGit ? (
        <AgentCommand command="xcode-select --install" open flush />
      ) : null}
      {!present && !mine && linuxCommand !== null ? (
        <AgentCommand command={linuxCommand} open flush />
      ) : null}
      {present && tool === "gh" && wasMissing ? (
        <AgentCommand command="gh auth login" flush />
      ) : null}
    </AgentRow>
  );
}

/**
 * The basics an agent machine needs, checked on the machine being set up:
 * Git, Node.js and, for publishing, the GitHub CLI. Quiet when they are all
 * there. Each missing one gets its own row and at most one button; nothing
 * here blocks Continue, and skipping is always fine.
 */
export function MachineBasics({
  environmentId,
  os,
  readOnly,
  fallback,
}: {
  readonly environmentId: EnvironmentId;
  readonly os: ExecutionEnvironmentPlatformOs | undefined;
  /** The person may not install on this machine. */
  readonly readOnly: boolean;
  /** Shown instead when the machine runs a SpecWithCode too old to answer. */
  readonly fallback: ReactNode;
}) {
  const tx = useTx();
  const { state, install, refresh, start } = useMachineTools(environmentId);
  const [wasMissing, setWasMissing] = useState<ReadonlySet<MachineToolId>>(new Set());
  const check = state.kind === "ready" ? state.check : null;
  const missingNow = (["git", "node", "gh"] as const).filter((tool) => check?.[tool] === "missing");
  if (missingNow.some((tool) => !wasMissing.has(tool)))
    setWasMissing(new Set([...wasMissing, ...missingNow]));

  // Coming back from a terminal, a browser or macOS's own window is the moment to look again.
  const anyMissing = missingNow.length > 0;
  useEffect(() => {
    if (!anyMissing || typeof window === "undefined") return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [anyMissing, refresh]);

  if (state.kind === "unavailable") return <>{fallback}</>;
  if (check === null) return null;

  const row = (tool: MachineToolId) => (
    <MachineToolRow
      key={tool}
      tool={tool}
      check={check}
      os={os}
      install={install}
      wasMissing={wasMissing.has(tool)}
      readOnly={readOnly}
      onInstall={() => start(tool)}
      onCheckAgain={() => void refresh()}
    />
  );
  const shown = (tool: MachineToolId) =>
    check[tool] === "missing" || (wasMissing.has(tool) && check[tool] === "present");
  const basicsReady = check.git === "present" && check.node === "present";
  const ghMissing = check.gh === "missing" || (wasMissing.has("gh") && check.gh === "present");

  return (
    <div className="mt-3 space-y-2" data-machine-basics>
      {basicsReady && !shown("git") && !shown("node") ? (
        <p
          className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
          data-machine-basics-ready
        >
          <CheckIcon aria-hidden className="size-3.5 text-success-foreground" />
          {check.gh === "present" && !wasMissing.has("gh")
            ? tx("Git, Node.js and GitHub CLI are ready.")
            : tx("Git and Node.js are ready.")}
        </p>
      ) : null}
      {shown("git") ? row("git") : null}
      {shown("node") ? row("node") : null}
      {ghMissing ? (
        <details className="px-1 text-xs" data-machine-basics-optional>
          <summary className="cursor-default text-muted-foreground">
            {tx("Optional, for publishing to GitHub: GitHub CLI")}
          </summary>
          <div className="mt-2">{row("gh")}</div>
        </details>
      ) : null}
    </div>
  );
}
