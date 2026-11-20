/**
 * What the GitHub Copilot sign-in step adds: the Copilot sign-ins that
 * machine already has (VS Code's Copilot extension, gh accounts, including an
 * enterprise host), found without reading any token; which GitHub host to
 * sign in to (github.com or an enterprise host); an Install Node.js button
 * when Copilot CLI cannot run because the machine has no Node.js; and Install
 * / update agent when Copilot CLI is missing, too old or unreadable.
 */
import { CopilotSignInHostPattern } from "@specweave-studio/contracts";
import type {
  EnvironmentId,
  ProviderAuthState,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { requestMachineToolInstall } from "../machineTools/machineToolInstallRequest";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CopilotInstallAgentButton } from "./CopilotInstallAgentButton";

/** The start of the server's message for this cause (CopilotDeviceAuthentication.ts). */
export const COPILOT_NEEDS_NODE_PREFIX =
  "Copilot CLI runs on Node.js, which this machine does not have.";

/** Every server message this action fixes names it (COPILOT_INSTALL_ACTION on the server). */
export const COPILOT_INSTALL_ACTION = "Install / update agent for GitHub Copilot";

export function copilotNeedsNode(message: string | null | undefined): boolean {
  return message?.startsWith(COPILOT_NEEDS_NODE_PREFIX) === true;
}

export function copilotNeedsAgentInstall(message: string | null | undefined): boolean {
  return message?.includes(COPILOT_INSTALL_ACTION) === true;
}

/** `company.ghe.com` or `https://company.ghe.com/` as a bare hostname; anything else is undefined. */
export function normalizeGitHubHost(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      CopilotSignInHostPattern.test(url.hostname)
      ? url.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

/** The person's host choice: untouched (`choice: ""`), a listed host, or a typed one (`"other"`). */
export interface CopilotHostChoice {
  readonly choice: string;
  readonly typed: string;
}

export const COPILOT_HOST_UNTOUCHED: CopilotHostChoice = { choice: "", typed: "" };

/**
 * The host sign-in starts with: `undefined` leaves the server's own choice
 * (a host variable, or the one enterprise host gh has), `null` is a typed
 * host that is not valid yet.
 */
export function pickedCopilotHost(value: CopilotHostChoice): string | null | undefined {
  if (value.choice === "") return undefined;
  if (value.choice === "other") return normalizeGitHubHost(value.typed) ?? null;
  return value.choice;
}

/** github.com and every enterprise host gh is signed in to, github.com first. */
export function copilotHostOptions(found: ProviderAuthState["copilotExistingSignIns"]): string[] {
  const hosts = new Set([
    "github.com",
    ...(found?.ghAccounts.map((account) => account.host) ?? []),
  ]);
  return [...hosts];
}

export function CopilotSignInHints({
  environmentId,
  environmentLabel,
  instanceId,
  found,
  message,
  readOnly,
  host,
  onHostChange,
  showExistingSignIns = true,
  canInstallAgent = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  /** What the server found on that machine (only this, never the sign-in state with its code). */
  readonly found: ProviderAuthState["copilotExistingSignIns"] | undefined;
  /** The failure shown above, if any. */
  readonly message: string | null;
  readonly readOnly: boolean;
  /** The host choice, shown while no sign-in is running; omit it to hide the choice. */
  readonly host?: CopilotHostChoice;
  readonly onHostChange?: (host: CopilotHostChoice) => void;
  readonly showExistingSignIns?: boolean;
  readonly canInstallAgent?: boolean;
}) {
  const tx = useTx();
  const needsNode = copilotNeedsNode(message);
  const needsInstall = canInstallAgent && !needsNode && copilotNeedsAgentInstall(message);
  // The host device sign-in goes to: one enterprise host and no other, as on the server.
  const hosts = [...new Set(found?.ghAccounts.map((account) => account.host) ?? [])];
  const enterprise = hosts.length === 1 && hosts[0] !== "github.com" ? hosts : [];
  const picked = host ? pickedCopilotHost(host) : undefined;
  const codeHost = picked ?? (picked === null ? undefined : (enterprise[0] ?? "github.com"));
  const showHostChoice = found !== undefined && host !== undefined && onHostChange !== undefined;
  const pressed = host?.choice || enterprise[0] || "github.com";
  if (
    !needsNode &&
    !needsInstall &&
    !showHostChoice &&
    (!showExistingSignIns || found === undefined || (!found.vscodeCopilot && found.ghAccounts.length === 0))
  )
    return null;
  return (
    <div className="my-2 grid gap-2 text-xs" data-copilot-sign-in-hints>
      {needsInstall && !readOnly ? (
        <CopilotInstallAgentButton
          key={JSON.stringify([environmentId, instanceId])}
          environmentId={environmentId}
          instanceId={instanceId}
        />
      ) : null}
      {showHostChoice ? (
        <div className="grid gap-1.5" role="group" aria-label={tx("GitHub host")}>
          <p className="font-medium text-foreground">{tx("GitHub host")}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {[...copilotHostOptions(found), "other"].map((option) => (
              <Button
                key={option}
                size="xs"
                variant={pressed === option ? "secondary" : "outline"}
                aria-pressed={pressed === option}
                disabled={readOnly}
                onClick={() => onHostChange({ choice: option, typed: host.typed })}
              >
                {option === "other" ? tx("Other enterprise host") : option}
              </Button>
            ))}
          </div>
          {host.choice === "other" ? (
            <label className="grid gap-1 text-muted-foreground">
              {tx("Enterprise host, such as company.ghe.com")}
              <Input
                size="sm"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="company.ghe.com"
                value={host.typed}
                disabled={readOnly}
                maxLength={253}
                aria-invalid={host.typed.trim() !== "" && picked === null}
                onChange={(event) => onHostChange({ choice: "other", typed: event.target.value })}
              />
            </label>
          ) : null}
          <p className="text-muted-foreground">
            {codeHost === undefined
              ? tx("Type the host your company's Copilot Enterprise uses, then sign in.")
              : tx(
                  "Personal accounts and most Copilot Business and Enterprise seats use github.com. Pick an enterprise host only when your company signs in at its own GHE.com address. Sign-in goes to {host}.",
                  { host: codeHost },
                )}
          </p>
        </div>
      ) : null}
      {needsNode && !readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              requestMachineToolInstall({
                environmentId,
                tool: "node",
                machineLabel: environmentLabel,
                neededBy: "copilot",
              })
            }
          >
            {tx("Install {tool}", { tool: "Node.js" })}
          </Button>
        </div>
      ) : null}
      {showExistingSignIns && found !== undefined && (found.vscodeCopilot || found.ghAccounts.length > 0) ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-muted-foreground">
          <p className="font-medium text-foreground">
            {renderRich(tx("Other GitHub sign-ins on {environmentLabel}"), { environmentLabel })}
          </p>
          <ul className="mt-1 list-disc ps-4">
            {found.vscodeCopilot ? <li>{tx("GitHub Copilot in VS Code")}</li> : null}
            {found.ghAccounts.map((account) => (
              <li key={`${account.host}/${account.account}`}>
                {tx("GitHub CLI signed in as {account} on {host}", account)}
              </li>
            ))}
          </ul>
          <p className="mt-1">{tx("These are not Copilot CLI's own sign-in.")}</p>
          <p className="mt-1">
            {enterprise.length === 1 && !showHostChoice
              ? tx(
                  "Copilot CLI keeps its own sign-in. Sign in once with the same account; the code goes to {host}.",
                  { host: enterprise[0]! },
                )
              : tx(
                  "Copilot CLI keeps its own sign-in, and SpecWithCode never copies another app's. Sign in once with the same account.",
                )}
          </p>
        </div>
      ) : null}
    </div>
  );
}
