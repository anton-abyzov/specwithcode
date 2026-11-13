import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
  type MachineReadinessSweep,
  type MachineReadinessToolId,
  type MachineToolsCheck,
} from "@specweave-studio/contracts";
import {
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GithubIcon,
  HexagonIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useT, useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import type { MachineToolInstallState } from "../../studio/machineTools";
import { Button } from "../ui/button";
import {
  installTargets,
  linuxGitCommand,
  MACHINE_TOOL_DOWNLOADS,
  MACHINE_TOOL_NAMES,
  MachineToolLog,
  machineToolStatus,
  useMachineTools,
} from "../machineTools/machineToolsUi";
import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";

const ICONS: Readonly<Record<MachineReadinessToolId, ReactNode>> = {
  git: <GitBranchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
  node: <HexagonIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
  gh: <GithubIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
  specweave: <FileTextIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />,
};

/** A link to a tool's own download page, for a machine the app cannot install it on. */
function DownloadLink({ tool }: { readonly tool: MachineReadinessToolId }) {
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
  readonly tool: MachineReadinessToolId;
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
  const status = machineToolStatus(check, tool);
  const outdated = status?.outdated === true;
  // The app's own older copy is replaced; the person's own old one is only named.
  const updatable = outdated && status?.managed === true && status.canInstall;
  const present = status?.presence === "present" && !updatable;
  const mine = install.tool === tool;
  const running = mine && install.status === "running";
  const failed = mine && install.status === "failed";
  const handedOff = mine && install.status === "done" && install.handedOff && !present;
  const otherRunning = install.status === "running" && !mine;
  const installable = status?.canInstall === true;
  const linuxCommand =
    tool === "git" && os === "linux" ? linuxGitCommand(check.packageManager) : null;
  if (present && !wasMissing && !outdated) return null;

  const uses =
    tool === "git"
      ? tx("Recommended. Agents use Git to track and undo their changes.")
      : tool === "node"
        ? tx("Recommended. SpecWeave runs on Node.js, and many agent tools need it.")
        : tool === "specweave"
          ? tx("Recommended. Plans and tracks work in SpecWeave projects.")
          : tx("Publishes projects to GitHub and opens pull requests from the app.");
  const version = status?.version ?? null;

  const detail =
    present && outdated ? (
      <span className="text-warning-foreground">
        {tool === "node"
          ? tx(
              "Version {version} is older than SpecWeave and Copilot need (Node.js 20 or newer). Update it where you installed it.",
              { version: version ?? "?" },
            )
          : tx(
              "Version {version} is older than SpecWithCode needs. Update it where you installed it.",
              {
                version: version ?? "?",
              },
            )}
      </span>
    ) : present ? (
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
    ) : updatable ? (
      readOnly ? (
        tx("SpecWithCode's copy is version {version}, older than this release uses.", {
          version: version ?? "?",
        })
      ) : (
        tx(
          "SpecWithCode's copy is version {version}. One click replaces it with the version this release uses.",
          { version: version ?? "?" },
        )
      )
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
    ) : tool === "specweave" && installable ? (
      tx(
        "Not installed. One click installs it in SpecWithCode's own folder with Node.js, with no admin password.",
      )
    ) : installable && tool === "node" ? (
      tx(
        "Not installed. One click installs Node.js 22 in SpecWithCode's own folder, with no admin password. A Node.js you install yourself later still comes first.",
      )
    ) : installable ? (
      tx(
        "Not installed. One click installs it in SpecWithCode's own folder, with no admin password.",
      )
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
        aria-label={
          updatable ? tx("Update {tool}", { tool: name }) : tx("Install {tool}", { tool: name })
        }
        onClick={onInstall}
      >
        {handedOff
          ? tx("Ask again")
          : failed
            ? t("wizard.retry")
            : updatable
              ? tx("Update {tool}", { tool: name })
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
        present && outdated
          ? "missing"
          : present
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
        present && !outdated ? (
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

/** One line on what the check after the last app update did, when it did something. */
function SweepLine({ sweep }: { readonly sweep: MachineReadinessSweep | undefined }) {
  const tx = useTx();
  if (sweep === undefined) return null;
  const names = sweep.installed.map((tool) => MACHINE_TOOL_NAMES[tool]).join(", ");
  const text =
    sweep.state === "waiting"
      ? tx(
          "After the update to {version}, SpecWithCode checks these again once no work runs on this machine.",
          { version: sweep.version },
        )
      : sweep.state === "failed"
        ? tx("After the update to {version}, an install did not finish: {detail}", {
            version: sweep.version,
            detail: sweep.detail ?? "",
          })
        : names !== ""
          ? tx("After the update to {version}, SpecWithCode installed {tools}.", {
              version: sweep.version,
              tools: names,
            })
          : null;
  if (text === null) return null;
  return (
    <p
      className={
        sweep.state === "failed"
          ? "px-1 text-xs text-warning-foreground"
          : "px-1 text-xs text-muted-foreground"
      }
      data-machine-readiness-sweep={sweep.state}
    >
      {text}
    </p>
  );
}

const MAIN_TOOLS = ["git", "node", "specweave"] as const;

/**
 * Machine readiness on one machine: Git, Node.js, SpecWeave and, for
 * publishing, the GitHub CLI. Quiet when they are all there. Each missing or
 * too old one gets its own row and at most one button, and Install everything
 * runs the installs one after another; nothing here blocks Continue, and
 * skipping is always fine. A machine on an older SpecWithCode answers for Git,
 * Node.js and gh only, and shows no SpecWeave row.
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
  const { state, install, refresh, start, startAll, installingAll } =
    useMachineTools(environmentId);
  const [wasMissing, setWasMissing] = useState<ReadonlySet<MachineReadinessToolId>>(new Set());
  const check = state.kind === "ready" ? state.check : null;
  const needsWork = (tool: MachineReadinessToolId) => {
    if (check === null) return false;
    const status = machineToolStatus(check, tool);
    return status !== null && (status.presence === "missing" || status.outdated);
  };
  const missingNow = (["git", "node", "gh", "specweave"] as const).filter(needsWork);
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

  const row = (tool: MachineReadinessToolId) => (
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
  const shown = (tool: MachineReadinessToolId) =>
    needsWork(tool) ||
    (wasMissing.has(tool) && machineToolStatus(check, tool)?.presence === "present");
  const reportsSpecweave = machineToolStatus(check, "specweave") !== null;
  const mainReady = MAIN_TOOLS.every(
    (tool) => !shown(tool) && (tool !== "specweave" || reportsSpecweave),
  );
  const ghShown = shown("gh");
  const targets = readOnly ? [] : installTargets(check);

  return (
    <div className="mt-3 space-y-2" data-machine-basics>
      {mainReady ? (
        <p
          className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
          data-machine-basics-ready
        >
          <CheckIcon aria-hidden className="size-3.5 text-success-foreground" />
          {check.gh === "present" && !wasMissing.has("gh")
            ? tx("Git, Node.js, SpecWeave and GitHub CLI are ready.")
            : tx("Git, Node.js and SpecWeave are ready.")}
        </p>
      ) : !reportsSpecweave && !shown("git") && !shown("node") ? (
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
      {targets.length > 1 ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs text-muted-foreground">
            {tx("{count} tools are missing or out of date on this machine.", {
              count: targets.length,
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={installingAll || install.status === "running"}
            onClick={() => startAll(targets)}
            data-machine-basics-install-all
          >
            {tx("Install everything missing")}
          </Button>
        </div>
      ) : null}
      {MAIN_TOOLS.map((tool) => (shown(tool) ? row(tool) : null))}
      {ghShown ? (
        <details
          className="px-1 text-xs"
          data-machine-basics-optional
          open={installingAll || undefined}
        >
          <summary className="cursor-default text-muted-foreground">
            {tx("Optional, for publishing to GitHub: GitHub CLI")}
          </summary>
          <div className="mt-2">{row("gh")}</div>
        </details>
      ) : null}
      <SweepLine sweep={check.lastSweep} />
    </div>
  );
}

/** Machine basics for any machine, local or reached over Connect: its own OS and permissions. */
export function MachineBasicsOn({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const os = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.platform
    .os;
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  return (
    <MachineBasics environmentId={environmentId} os={os} readOnly={!canMaintain} fallback={null} />
  );
}
