import type { EnvironmentId } from "@specweave-studio/contracts";
import { CopyIcon, EyeIcon, EyeOffIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { clearClipboardIfText } from "../../browser/externalBrowsers";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

/** How often an open Chrome setup reads the status, so a new profile shows within 3 s. */
export const BROWSER_EXTENSION_POLL_MS = 3_000;

/** After this long the desktop app clears a copied pairing code that is still on the clipboard. */
export const PAIRING_CODE_CLIPBOARD_MS = 120_000;

/**
 * Why pairing Chrome is the safer way to give agents a browser. First-run's
 * row, Settings > Chrome and the Connect Chrome card all say it with these
 * strings, so the three can never drift apart.
 */
export function useChromeWhy() {
  const tx = useTx();
  return {
    /** Always under the row's heading and the card's title. */
    always: tx("Agents use only the Chrome profiles you pair, and only while they are paired."),
    /** When the row is open, and on the Settings page. */
    open: tx(
      "They work in the live browser, in a blue tab group you can pull a tab out of. They never read Chrome's files on disk, which Full Disk Access would open to every agent.",
    ),
    /** Beside the profile list, only where it shows. */
    list: tx("SpecWithCode reads Chrome's profile names to show this list."),
    pick: tx("Pick the profile where the accounts agents need are signed in."),
    another: tx(
      "One profile is enough when everything agents need is signed in there. Pair a second one for a work account or another brand's accounts. The browser tools never reach a profile you did not pair.",
    ),
    several: tx("Agents use the profile you name."),
    lastUsed: tx(
      "It opens in the Chrome profile you used last. To pair another, switch to it in Chrome first.",
    ),
    codeWarning: tx("Anyone with this code can pair a browser with this computer."),
  } as const;
}

export interface ChromeProfileChoice {
  readonly directory: string;
  readonly name: string;
}

export type PairingCodeState =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "copied" }
  | { readonly kind: "shown"; readonly code: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The pairing steps both Settings > Chrome and first-run's row draw: the
 * profile (where the desktop app can list Chrome's), Add to Chrome, and the
 * code, copied in one press without being shown.
 */
export function BrowserExtensionSteps({
  profiles,
  chosen,
  onChoose,
  storeUrl,
  onAddToChrome,
  code,
  onCopyCode,
  onShowCode,
  onHideCode,
  canPair,
  waiting,
  remote,
}: {
  /** Chrome's profiles; null or empty where they cannot be read, and the store link opens as today. */
  readonly profiles: readonly ChromeProfileChoice[] | null;
  readonly chosen: string | null;
  readonly onChoose: (directory: string) => void;
  readonly storeUrl: string;
  /** Opens the store page in the chosen profile; absent where only a plain link works. */
  readonly onAddToChrome?: (() => void) | undefined;
  readonly code: PairingCodeState;
  readonly onCopyCode: () => void | Promise<void>;
  readonly onShowCode: () => void | Promise<void>;
  readonly onHideCode: () => void;
  /** This window may request the code. */
  readonly canPair: boolean;
  /** A code went out and no profile has connected yet. */
  readonly waiting: boolean;
  /** Setting up Chrome on another computer: its code works only there. */
  readonly remote?: ReactNode;
}) {
  const tx = useTx();
  const why = useChromeWhy();
  const list = profiles !== null && profiles.length > 1;
  const picked = list ? profiles.find((profile) => profile.directory === chosen) : undefined;
  const busy = code.kind === "working";
  return (
    <div data-slot="browser-extension-steps" className="space-y-2.5">
      {list ? (
        <div className="space-y-1.5">
          <div
            role="radiogroup"
            aria-label={tx("Chrome profile")}
            className="flex flex-wrap items-center gap-1.5"
          >
            <span className="me-1 text-sm font-semibold">{tx("Chrome profile")}</span>
            {profiles.map((profile) => {
              const on = profile.directory === chosen;
              return (
                <button
                  key={profile.directory}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-chrome-profile={profile.directory}
                  onClick={() => onChoose(profile.directory)}
                  className={
                    on
                      ? "rounded-full border border-transparent bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground"
                      : "rounded-full border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground hover:bg-accent/50"
                  }
                >
                  {profile.name}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {why.pick} {why.list}
          </p>
        </div>
      ) : null}
      <ol className="list-decimal space-y-2 ps-5 text-sm marker:text-muted-foreground">
        <li className="ps-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {onAddToChrome && (!list || picked !== undefined) ? (
              <Button size="sm" variant="outline" onClick={onAddToChrome}>
                <ExternalLinkIcon />
                {tx("Add to Chrome")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                render={<a href={storeUrl} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon />
                {tx("Add to Chrome")}
                <span className="sr-only"> {tx("(opens the Chrome Web Store)")}</span>
              </Button>
            )}
            <span className="text-muted-foreground">
              {onAddToChrome && picked !== undefined
                ? tx("Opens the store page in {profile}.", { profile: picked.name })
                : onAddToChrome && !list && profiles?.length === 1
                  ? tx("Opens the store page in Chrome.")
                  : why.lastUsed}
            </span>
          </div>
        </li>
        <li className="ps-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Button
              size="sm"
              variant="outline"
              data-pairing-copy=""
              disabled={!canPair || busy}
              onClick={onCopyCode}
            >
              {busy ? <Spinner /> : <CopyIcon />}
              {code.kind === "copied" ? tx("Copied") : tx("Copy code")}
            </Button>
            {code.kind === "shown" ? (
              <Button size="sm" variant="ghost" onClick={onHideCode}>
                <EyeOffIcon />
                {tx("Hide")}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={!canPair || busy} onClick={onShowCode}>
                <EyeIcon />
                {tx("Show")}
              </Button>
            )}
            <span className="text-muted-foreground">
              {tx(
                "Paste it in the extension's page, or click its icon in Chrome's toolbar and paste it there.",
              )}
            </span>
          </div>
          {code.kind === "shown" ? (
            <Input
              nativeInput
              readOnly
              font="mono"
              size="compact"
              className="mt-1.5 max-w-xs"
              aria-label={tx("Pairing code")}
              value={code.code}
            />
          ) : null}
          {waiting ? (
            <p role="status" className="mt-1 text-xs font-semibold text-accent-foreground">
              {tx("Waiting for Chrome…")}
            </p>
          ) : null}
        </li>
      </ol>
      {code.kind === "failed" ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {code.message}
        </p>
      ) : null}
      {remote}
      <p className="text-xs text-muted-foreground">{why.codeWarning}</p>
    </div>
  );
}

/**
 * The pairing code, requested only on a press: Copy puts it on the clipboard
 * without showing it, Show reveals it for typing by hand. Once a profile
 * pairs, or after two minutes, the desktop app clears the clipboard if it
 * still holds the code. `profiles` names the profiles connected now (the
 * relay keeps each label unique, and a reconnect keeps it, unlike the
 * per-connection id); a name not connected at the hand-out means the code did
 * its job, so a reconnect or a profile leaving is not a pairing.
 */
export function usePairingCode(
  environmentId: EnvironmentId,
  { profiles }: { profiles: readonly string[] },
) {
  const tx = useTx();
  const pairing = useAtomCommand(projectWorkspace.browserExtensionPairing);
  const [code, setCode] = useState<PairingCodeState>({ kind: "idle" });
  const [handedOut, setHandedOut] = useState(false);
  const copied = useRef<string | null>(null);
  // One clear per code on the clipboard: a second Copy restarts the two minutes.
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pairedAtHandOut, setPairedAtHandOut] = useState<ReadonlySet<string>>(new Set());
  const clear = useCallback(() => {
    const value = copied.current;
    copied.current = null;
    if (value !== null) void clearClipboardIfText(value);
  }, []);
  const request = useCallback(async () => {
    setCode({ kind: "working" });
    try {
      const result = await pairing({ environmentId, input: {} });
      if (result._tag === "Success") return result.value.pairingCode;
    } catch {
      // Reported below.
    }
    setCode({ kind: "failed", message: tx("The pairing code could not be read. Try again.") });
    return null;
  }, [environmentId, pairing, tx]);
  const copy = useCallback(async () => {
    const value = await request();
    if (value === null) return;
    try {
      await writeTextToClipboard(value, "pairing code");
    } catch {
      setCode({ kind: "failed", message: tx("The code could not be copied. Press Show instead.") });
      return;
    }
    copied.current = value;
    setPairedAtHandOut(new Set(profiles));
    // Two minutes after the last copy, whatever happens meanwhile, even after the screen closes.
    if (clearTimer.current !== null) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => {
      clearTimer.current = null;
      void clearClipboardIfText(value);
    }, PAIRING_CODE_CLIPBOARD_MS);
    setHandedOut(true);
    setCode({ kind: "copied" });
  }, [profiles, request, tx]);
  const show = useCallback(async () => {
    const value = await request();
    if (value === null) return;
    setPairedAtHandOut(new Set(profiles));
    setHandedOut(true);
    setCode({ kind: "shown", code: value });
  }, [profiles, request]);
  const hide = useCallback(() => setCode({ kind: "idle" }), []);
  // A new profile paired: the code has done its job.
  const newlyPaired = handedOut && profiles.some((profile) => !pairedAtHandOut.has(profile));
  useEffect(() => {
    if (!newlyPaired) return;
    clear();
    setHandedOut(false);
    setCode({ kind: "idle" });
  }, [newlyPaired, clear]);
  return { code, handedOut, copy, show, hide } as const;
}
