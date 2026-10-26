import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetInviteResult,
  StudioFleetTailscaleStatus,
} from "@specweave-studio/contracts/studioFleet";

import {
  FleetInviteFailure,
  inviteStudioFleetMachine,
  readStudioFleetTailscale,
  revokeStudioFleetInvitation,
  signInStudioFleetTailscale,
} from "../../studio/fleet";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * The in-app `specwithcode fleet invite`: this machine publishes itself on its
 * own Tailscale name and shows one line to paste on the main machine. The
 * line is a credential, so it lives only in this component's state and is
 * dropped as soon as the person leaves.
 */

export type FleetInviteReason = FleetInviteFailure["reason"];

export interface FleetInviteProblemView {
  readonly reason: FleetInviteReason;
  readonly message: string;
}

/** A short heading per problem; the server's message says what to do. */
export function fleetInviteProblemTitle(reason: FleetInviteReason): string {
  switch (reason) {
    case "tailscale_missing":
      return "Tailscale is not installed";
    case "tailscale_signed_out":
      return "Tailscale is not signed in";
    case "tailscale_unavailable":
      return "Tailscale is not answering";
    case "magic_dns_missing":
      return "MagicDNS is off";
    case "serves_other_server":
    case "port_occupied":
      return "That port is already in use";
    case "serve_failed":
      return "Tailscale could not publish this machine";
    case "dev_server_not_proxiable":
      return "This server cannot be published";
    case "tailscale_needs_admin":
      return "Tailscale needs an administrator";
    case "tailscale_sign_in_failed":
      return "Could not start signing in";
    case "permission":
      return "Manage access required";
    case "unknown":
      return "Could not make the line";
  }
}

/** "valid for 365 days, until Oct 18, 2027" in the viewer's own date format. */
export function fleetInviteValidity(expiresAt: string, now: number = Date.now()): string {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return "valid until it expires";
  const days = Math.max(1, Math.round((expires - now) / 86_400_000));
  const date = new Date(expires).toLocaleDateString(undefined, { dateStyle: "medium" });
  return `valid for ${days === 1 ? "1 day" : `${days} days`}, until ${date}`;
}

export interface FleetInviteController {
  readonly name: string;
  readonly ownEnvironmentId: EnvironmentId | null;
  readonly coordinatorEnvironmentId: string;
  readonly setCoordinatorEnvironmentId: (id: string) => void;
  readonly setName: (name: string) => void;
  readonly pending: "create" | "revoke" | null;
  readonly invitation: StudioFleetInviteResult | null;
  readonly revoked: boolean;
  readonly problem: FleetInviteProblemView | null;
  readonly create: () => Promise<StudioFleetInviteResult | null>;
  readonly revoke: () => Promise<void>;
  /** Forgets the line, for when the person closes the dialog or moves on. */
  readonly reset: () => void;
}

export function useFleetInvite(environmentId: EnvironmentId | null): FleetInviteController {
  const [name, setName] = useState("");
  const [coordinatorEnvironmentId, setCoordinatorEnvironmentId] = useState("");
  const [pending, setPending] = useState<"create" | "revoke" | null>(null);
  const [invitation, setInvitation] = useState<StudioFleetInviteResult | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [problem, setProblem] = useState<FleetInviteProblemView | null>(null);
  async function create() {
    if (pending || !environmentId || !coordinatorEnvironmentId.trim()) return null;
    setPending("create");
    setProblem(null);
    setRevoked(false);
    try {
      const made = await inviteStudioFleetMachine(environmentId, {
        label: name,
        coordinatorEnvironmentId: EnvironmentId.make(coordinatorEnvironmentId.trim()),
      });
      setInvitation(made);
      return made;
    } catch (failure) {
      setProblem(
        failure instanceof FleetInviteFailure
          ? { reason: failure.reason, message: failure.message }
          : { reason: "unknown", message: "Could not make the line. Try again." },
      );
      return null;
    } finally {
      setPending(null);
    }
  }
  async function revoke() {
    if (pending || !invitation) return;
    setPending("revoke");
    setProblem(null);
    try {
      await revokeStudioFleetInvitation(invitation.sessionId);
      setInvitation(null);
      setRevoked(true);
    } catch {
      setProblem({
        reason: "unknown",
        message:
          "Could not revoke the line. Revoke Fleet management (fleet invite) under Authorized clients in Settings > Connections.",
      });
    } finally {
      setPending(null);
    }
  }
  function reset() {
    setInvitation(null);
    setRevoked(false);
    setProblem(null);
    setName("");
    setCoordinatorEnvironmentId("");
  }
  return {
    ownEnvironmentId: environmentId,
    name,
    setName,
    coordinatorEnvironmentId,
    setCoordinatorEnvironmentId,
    pending,
    invitation,
    revoked,
    problem,
    create,
    revoke,
    reset,
  };
}

/** The name field, the line once made, and plain-words problems. Layout belongs to the caller. */
export function FleetInvitePanel({
  controller,
  defaultName,
  canManage,
  copied,
  onCopy,
  createLabel = "Make the line",
  blocked = false,
}: {
  readonly controller: Pick<
    FleetInviteController,
    | "ownEnvironmentId"
    | "coordinatorEnvironmentId"
    | "setCoordinatorEnvironmentId"
    | "name"
    | "setName"
    | "pending"
    | "invitation"
    | "revoked"
    | "problem"
    | "create"
    | "revoke"
  >;
  /** This machine's own name, used when the field is left empty. */
  readonly defaultName: string | null;
  readonly canManage: boolean;
  readonly copied: boolean;
  readonly onCopy: (code: string) => void;
  readonly createLabel?: string;
  /** Tailscale is not ready here yet, so making the line would fail. */
  readonly blocked?: boolean;
}) {
  const { name, setName, pending, invitation, revoked, problem } = controller;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {controller.ownEnvironmentId ? (
        <p className="text-xs text-muted-foreground">
          This machine’s environment ID:{" "}
          <code className="select-all">{controller.ownEnvironmentId}</code>
        </p>
      ) : null}
      {invitation ? (
        <>
          <div className="flex min-w-0 gap-2">
            <Input
              readOnly
              font="mono"
              size="sm"
              aria-label="Invitation line for the main machine"
              className="min-w-0 flex-1"
              value={invitation.code}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" variant="outline" onClick={() => onCopy(invitation.code)}>
              {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Paste this line on your main machine under Settings &gt; Connections &gt; Add a machine.
            It works like a password, so only paste it there, and it is{" "}
            {fleetInviteValidity(invitation.expiresAt)}.
          </p>
          <div>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending !== null}
              onClick={() => void controller.revoke()}
            >
              {pending === "revoke" ? "Revoking…" : "Revoke this line"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Main machine environment ID
            </span>
            <Input
              value={controller.coordinatorEnvironmentId}
              autoComplete="off"
              disabled={pending !== null || !canManage}
              onChange={(event) => controller.setCoordinatorEnvironmentId(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Approve this main machine to manage access. Copy its environment ID from Settings &gt;
              Connections on that machine.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Name on the main machine (optional)
            </span>
            <Input
              value={name}
              maxLength={80}
              placeholder={defaultName ?? "This machine"}
              autoComplete="off"
              disabled={pending !== null || !canManage}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {revoked ? (
            <p role="status" className="text-xs text-muted-foreground">
              Revoked. That line no longer works anywhere.
            </p>
          ) : null}
          <div>
            <Button
              size="sm"
              disabled={
                pending !== null ||
                !canManage ||
                blocked ||
                !controller.coordinatorEnvironmentId.trim()
              }
              onClick={() => void controller.create()}
            >
              {pending === "create"
                ? "Making the line…"
                : canManage
                  ? createLabel
                  : "Manage access required"}
            </Button>
          </div>
        </>
      )}
      {problem ? (
        <Alert variant="error" role="alert">
          <AlertTitle>{fleetInviteProblemTitle(problem.reason)}</AlertTitle>
          <AlertDescription>{problem.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/** How often to look again while waiting for the person to install or sign in. */
export const TAILSCALE_POLL_MS = 3_000;
/** Slower, for the Settings row while its dialog is closed. */
export const TAILSCALE_IDLE_POLL_MS = 15_000;
export const BREW_INSTALL_TAILSCALE = "brew install --cask tailscale";

/** Where Tailscale's own download page for the server's platform is. */
export function tailscaleDownloadUrl(platform: string): string {
  switch (platform) {
    case "darwin":
      return "https://tailscale.com/download/mac";
    case "linux":
      return "https://tailscale.com/download/linux";
    case "win32":
      return "https://tailscale.com/download/windows";
    default:
      return "https://tailscale.com/download";
  }
}

export interface TailscaleReadinessView {
  readonly kind:
    | "checking"
    | "unreachable"
    | "not_installed"
    | "signed_out"
    | "no_magic_dns"
    | "ready";
  readonly title: string;
  readonly description: string;
  /** Install opens the download page; sign in starts Tailscale's sign-in here. */
  readonly action: "install" | "sign_in" | null;
  readonly downloadUrl: string | null;
  /** Shown to copy when Homebrew is installed; the app never runs it. */
  readonly brewCommand: string | null;
}

/** What to show for Tailscale's state here, in plain words. */
export function tailscaleReadinessView(
  status: StudioFleetTailscaleStatus | null,
  failed: boolean,
): TailscaleReadinessView {
  const none = { action: null, downloadUrl: null, brewCommand: null } as const;
  if (!status)
    return failed
      ? {
          ...none,
          kind: "unreachable",
          title: "Could not check Tailscale",
          description: "The app tries again on its own.",
        }
      : {
          ...none,
          kind: "checking",
          title: "Checking whether Tailscale is ready on this machine…",
          description: "",
        };
  switch (status.state) {
    case "not_installed":
      return {
        kind: "not_installed",
        title: "Tailscale is not installed",
        description:
          "For a main machine to start work here, install Tailscale on this machine, open it and sign in. This updates on its own once it is installed.",
        action: "install",
        downloadUrl: tailscaleDownloadUrl(status.platform),
        brewCommand:
          status.platform === "darwin" && status.homebrew ? BREW_INSTALL_TAILSCALE : null,
      };
    case "signed_out":
      return {
        ...none,
        kind: "signed_out",
        title:
          status.backendState === "Stopped"
            ? "Tailscale is turned off"
            : "Tailscale is not signed in",
        description:
          "Sign in to the same tailnet as your main machine. This updates on its own once you have.",
        action: "sign_in",
      };
    case "running":
      return status.magicDns
        ? { ...none, kind: "ready", title: "Tailscale is connected", description: "" }
        : {
            ...none,
            kind: "no_magic_dns",
            title: "MagicDNS is off",
            description:
              "Turn on MagicDNS in the Tailscale admin console under DNS. This updates on its own.",
          };
  }
}

export interface TailscaleReadiness {
  readonly status: StudioFleetTailscaleStatus | null;
  readonly failed: boolean;
  readonly ready: boolean;
  /**
   * Hold back making the line while Tailscale is known not to be ready. When
   * the check itself failed, the invite is allowed and reports its own error.
   */
  readonly blocksInvite: boolean;
  readonly signingIn: boolean;
  /** The sign-in page last opened, to open again if the browser lost it. */
  readonly loginUrl: string | null;
  readonly problem: FleetInviteProblemView | null;
  readonly signIn: () => Promise<void>;
  readonly openUrl: (url: string) => void;
}

/**
 * Whether a failed status read means the check itself failed. Right after a
 * page load the connection is still starting, which reads as missing access;
 * that stays on checking and the next look settles it.
 */
export function countsAsTailscaleCheckFailure(failure: unknown): boolean {
  return !(failure instanceof FleetInviteFailure && failure.reason === "permission");
}

const openExternal = (url: string) => {
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => undefined);
};

/**
 * Reads Tailscale's state here and looks again every few seconds until it is
 * connected, so the person never has to press refresh. Nothing animates while
 * it waits.
 */
export function useTailscaleReadiness(
  environmentId: EnvironmentId | null,
  options: { readonly enabled: boolean; readonly intervalMs?: number },
): TailscaleReadiness {
  const [status, setStatus] = useState<StudioFleetTailscaleStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<FleetInviteProblemView | null>(null);
  const [round, setRound] = useState(0);
  const intervalMs = options.intervalMs ?? TAILSCALE_POLL_MS;
  const ready = status?.state === "running" && status.magicDns;
  useEffect(() => {
    if (!options.enabled || environmentId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const next = await readStudioFleetTailscale(environmentId);
        if (cancelled) return;
        setStatus(next);
        setFailed(false);
        if (next.state === "running" && next.magicDns) return;
      } catch (failure) {
        if (cancelled) return;
        if (countsAsTailscaleCheckFailure(failure)) setFailed(true);
      }
      timer = setTimeout(() => void check(), intervalMs);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [environmentId, options.enabled, intervalMs, round]);
  async function signIn() {
    if (signingIn || environmentId === null) return;
    setSigningIn(true);
    setProblem(null);
    try {
      const url = await signInStudioFleetTailscale(environmentId);
      setLoginUrl(url);
      if (url) openExternal(url);
    } catch (failure) {
      setProblem(
        failure instanceof FleetInviteFailure
          ? { reason: failure.reason, message: failure.message }
          : {
              reason: "tailscale_sign_in_failed",
              message: "Could not start signing in. Open the Tailscale app and sign in there.",
            },
      );
    } finally {
      setSigningIn(false);
      // Look again now rather than at the next tick.
      setRound((current) => current + 1);
    }
  }
  return {
    status,
    failed,
    ready,
    blocksInvite: !ready && !(failed && status === null),
    signingIn,
    loginUrl,
    problem,
    signIn,
    openUrl: openExternal,
  };
}

/** Install, sign in or MagicDNS guidance; nothing once Tailscale is ready. */
export function TailscaleReadinessNotice({
  readiness,
  canManage,
  onCopyCommand,
}: {
  readonly readiness: Pick<
    TailscaleReadiness,
    "status" | "failed" | "signingIn" | "loginUrl" | "problem" | "signIn" | "openUrl"
  >;
  readonly canManage: boolean;
  readonly onCopyCommand: (command: string) => void;
}) {
  const view = tailscaleReadinessView(readiness.status, readiness.failed);
  if (view.kind === "ready") return null;
  if (view.kind === "checking")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {view.title}
      </p>
    );
  return (
    <Alert variant="warning" role="status" aria-label={view.title}>
      <AlertTitle>{view.title}</AlertTitle>
      <AlertDescription>
        <span className="block">{view.description}</span>
        {view.action === "install" && view.downloadUrl ? (
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => readiness.openUrl(view.downloadUrl!)}
            >
              Install Tailscale
            </Button>
          </span>
        ) : null}
        {view.brewCommand ? (
          <span className="mt-2 flex min-w-0 items-center gap-2">
            <span className="shrink-0">Or in Terminal:</span>
            <Input
              readOnly
              font="mono"
              size="sm"
              aria-label="Command that installs Tailscale with Homebrew"
              className="min-w-0 flex-1"
              value={view.brewCommand}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="xs" variant="outline" onClick={() => onCopyCommand(view.brewCommand!)}>
              Copy
            </Button>
          </span>
        ) : null}
        {view.action === "sign_in" ? (
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={readiness.signingIn || !canManage}
              onClick={() => void readiness.signIn()}
            >
              {readiness.signingIn
                ? "Opening Tailscale…"
                : canManage
                  ? "Sign in to Tailscale"
                  : "Manage access required"}
            </Button>
            {readiness.loginUrl ? (
              <Button
                size="xs"
                variant="link"
                onClick={() => readiness.openUrl(readiness.loginUrl!)}
              >
                Open the sign-in page again
              </Button>
            ) : null}
          </span>
        ) : null}
        {readiness.problem ? (
          <span role="alert" className="mt-2 block text-destructive-foreground">
            {readiness.problem.message}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Settings > Connections: make this machine's invitation in a dialog. Closing
 * it forgets the line, so it is never shown twice.
 */
export function FleetInviteDialog({
  environmentId,
  defaultName,
  canManage,
  open,
  onOpenChange,
  readiness,
}: {
  readonly environmentId: EnvironmentId;
  /** This machine's own name, used when the field is left empty. */
  readonly defaultName: string | null;
  readonly canManage: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly readiness: TailscaleReadiness;
}) {
  const controller = useFleetInvite(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: "invitation line" });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) controller.reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite this machine to another one</DialogTitle>
          <DialogDescription>
            Your main machine can then start work here. For now, letting a main machine start work
            on this one also needs Tailscale on both, signed in to the same tailnet. This publishes
            the app here on this machine&apos;s private Tailscale name, never on the public
            internet. Your app and phone can already reach this machine through SpecWithCode Connect
            without Tailscale.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {controller.invitation ? null : (
            <TailscaleReadinessNotice
              readiness={readiness}
              canManage={canManage}
              onCopyCommand={(command) => copyToClipboard(command, undefined)}
            />
          )}
          <FleetInvitePanel
            controller={controller}
            defaultName={defaultName}
            canManage={canManage}
            copied={isCopied}
            onCopy={(code) => copyToClipboard(code, undefined)}
            blocked={readiness.blocksInvite}
          />
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            disabled={controller.pending !== null}
            onClick={() => {
              controller.reset();
              onOpenChange(false);
            }}
          >
            {controller.invitation ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Beside Invite this machine: Tailscale's state here, with Install or Sign in
 * when it is not ready, and the dialog the button opens. One check serves
 * both; it looks again sooner while the dialog is open. Only a main machine
 * starting work here needs Tailscale; SpecWithCode Connect reaches this
 * machine without it.
 */
export function FleetInviteArea({
  environmentId,
  defaultName,
  canManage,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly defaultName: string | null;
  readonly canManage: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const readiness = useTailscaleReadiness(environmentId, {
    enabled: canManage,
    intervalMs: open ? TAILSCALE_POLL_MS : TAILSCALE_IDLE_POLL_MS,
  });
  const { copyToClipboard } = useCopyToClipboard<void>({ target: "command" });
  return (
    <>
      {canManage && !open ? (
        <TailscaleReadinessNotice
          readiness={readiness}
          canManage={canManage}
          onCopyCommand={(command) => copyToClipboard(command, undefined)}
        />
      ) : null}
      <FleetInviteDialog
        environmentId={environmentId}
        defaultName={defaultName}
        canManage={canManage}
        open={open}
        onOpenChange={onOpenChange}
        readiness={readiness}
      />
    </>
  );
}
