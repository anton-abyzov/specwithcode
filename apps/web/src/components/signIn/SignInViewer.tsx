/**
 * The sign-in view (1488): a live picture of a Chrome tab on another machine
 * that only the person sees and drives. Frames arrive sealed to a key this
 * window makes for the view and forgets when it closes; typed text leaves
 * sealed to the view's key. The address shown is the one Chrome reports.
 */
import type { BrowserSignInOutcome, EnvironmentId } from "@specweave-studio/contracts";
import {
  newSignInViewerKey,
  signInKeyFingerprint,
  type SignInViewerKey,
  unsealForSignIn,
} from "@specweave-studio/shared/signInSeal";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { KeyRoundIcon, LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useTx } from "../../i18n";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
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
import {
  createSignInSender,
  framePoint,
  signInKeyAction,
  type SignInSender,
} from "./signInViewerLogic";

export interface SignInViewerRequest {
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  /** The machine whose Chrome it is, as the card named it. */
  readonly machine: string;
  /** The site the agent asked for, as the card named it. */
  readonly site: string;
}

const useViewer = create<{ request: SignInViewerRequest | null; attempt: number }>(() => ({
  request: null,
  attempt: 0,
}));

/** Opens the view for an allowed sign-in card. One view at a time. */
export function openSignInViewer(request: SignInViewerRequest) {
  useViewer.setState((state) => ({ request, attempt: state.attempt + 1 }));
}

/** The view's four calls to the machine with the tab. */
function useSignInViewApi() {
  return {
    start: useAtomCommand(projectWorkspace.browserSignInStart, {
      label: "sign-in view",
      reportFailure: false,
    }),
    frame: useAtomCommand(projectWorkspace.browserSignInFrame, {
      label: "sign-in frame",
      reportFailure: false,
    }),
    input: useAtomCommand(projectWorkspace.browserSignInInput, {
      label: "sign-in input",
      reportFailure: false,
    }),
    end: useAtomCommand(projectWorkspace.browserSignInEnd, {
      label: "sign-in end",
      reportFailure: false,
    }),
  };
}

export type SignInViewApi = ReturnType<typeof useSignInViewApi>;

export function SignInViewerHost() {
  const request = useViewer((state) => state.request);
  const attempt = useViewer((state) => state.attempt);
  const api = useSignInViewApi();
  return request ? (
    <SignInViewer
      // A new attempt mounts a new view, with a new key.
      key={`${request.requestId}:${attempt}`}
      request={request}
      api={api}
      onClose={() => useViewer.setState({ request: null })}
      onRetry={() => openSignInViewer(request)}
    />
  ) : null;
}

interface ShownFrame {
  readonly frame: string;
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly origin: string;
  readonly title: string;
  /** Proves to the machine that input comes from the window that opened this view. */
  readonly token: string;
  readonly dialog?: string;
  readonly passkey?: { readonly kind: string; readonly rpId: string; readonly notice: string };
}

type Phase =
  | { readonly kind: "opening" }
  | {
      readonly kind: "open";
      readonly viewId: string;
      readonly profile: string;
      readonly fingerprint: string;
    }
  | { readonly kind: "ended"; readonly outcome: BrowserSignInOutcome | "closed" }
  | { readonly kind: "failed"; readonly message: string };

const POLL_MS = 450;

const failureText = (result: unknown, fallback: string) => {
  const failure = squashAtomCommandFailure(result as never) as { message?: unknown } | undefined;
  return typeof failure?.message === "string" && failure.message.trim()
    ? failure.message
    : fallback;
};

/** The view itself; `api` is the host's RPCs, or a fixture's stand-ins. */
export function SignInViewer(props: {
  readonly request: SignInViewerRequest;
  readonly api: SignInViewApi;
  readonly onClose: () => void;
  /** Opens the view again after it failed to start. */
  readonly onRetry?: () => void;
}) {
  const tx = useTx();
  const { request } = props;
  const { start, frame: pull, input: send, end } = props.api;
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [frame, setFrame] = useState<ShownFrame | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keyRef = useRef<SignInViewerKey | null>(null);
  const senderRef = useRef<SignInSender | null>(null);
  const frameRef = useRef<ShownFrame | null>(null);
  const [retryable, setRetryable] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const environmentId = request.environmentId;

  // Open the view, then pull frames until it ends or this window closes.
  useEffect(() => {
    let alive = true;
    let viewId: string | null = null;
    const run = async () => {
      let key: SignInViewerKey;
      try {
        key = await newSignInViewerKey();
      } catch {
        setPhase({
          kind: "failed",
          message: tx(
            "This browser cannot open a sealed sign-in view. Use a current Chrome, Safari or Firefox.",
          ),
        });
        return;
      }
      keyRef.current = key;
      const started = await start({
        environmentId,
        input: { requestId: request.requestId, viewerKey: key.publicKey },
      });
      if (started._tag !== "Success") {
        if (!alive) return;
        setRetryable(true);
        setPhase({
          kind: "failed",
          message: failureText(started, tx("Could not open the sign-in.")),
        });
        return;
      }
      const opened = started.value;
      // This window closed while the tab opened: cancel it, so it never stays held for nobody.
      if (!alive) {
        void end({ environmentId, input: { viewId: opened.viewId, end: "cancel" } });
        return;
      }
      viewId = opened.viewId;
      // The key the server reported must be the one it seals with; show its short form.
      const fingerprint = await signInKeyFingerprint(opened.publicKey);
      if (fingerprint !== opened.fingerprint) {
        await end({ environmentId, input: { viewId: opened.viewId, end: "cancel" } });
        setPhase({
          kind: "failed",
          message: tx("The view's key did not match. Nothing was shown or typed."),
        });
        return;
      }
      senderRef.current = createSignInSender({
        publicKey: opened.publicKey,
        sendText: async (sealed) => {
          const sent = await send({
            environmentId,
            input: {
              viewId: opened.viewId,
              token: frameRef.current?.token ?? "",
              input: { type: "text", sealed },
            },
          });
          if (sent._tag !== "Success")
            setNotice(
              failureText(sent, tx("That text was not typed. Look at the page and try again.")),
            );
        },
        sendKey: async (frameId, keyName) => {
          const sent = await send({
            environmentId,
            input: {
              viewId: opened.viewId,
              token: frameRef.current?.token ?? "",
              input: { type: "key", frame: frameId, key: keyName },
            },
          });
          if (sent._tag !== "Success") setNotice(failureText(sent, tx("That key was not sent.")));
        },
        onError: () => setNotice(tx("That text was not typed. Look at the page and try again.")),
      });
      setPhase({ kind: "open", viewId: opened.viewId, profile: opened.profile, fingerprint });
      let failures = 0;
      for (;;) {
        const result = await pull({ environmentId, input: { viewId: opened.viewId } });
        if (!alive) return;
        if (result._tag === "Success") {
          failures = 0;
          if (result.value.ended !== undefined) {
            setPhase({ kind: "ended", outcome: result.value.ended });
            return;
          }
          if (result.value.sealed !== undefined) {
            try {
              const opened = JSON.parse(
                new TextDecoder().decode(await unsealForSignIn(result.value.sealed, key)),
              ) as ShownFrame;
              if (!alive) return;
              frameRef.current = opened;
              setFrame(opened);
              if (opened.dialog) setNotice(opened.dialog);
            } catch {
              setNotice(
                tx("A frame could not be opened with this window's key, so it was not shown."),
              );
            }
          }
        } else if (++failures >= 5) {
          setPhase({
            kind: "failed",
            message: failureText(result, tx("The sign-in view stopped answering.")),
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    void run();
    return () => {
      alive = false;
      senderRef.current?.drop();
      keyRef.current = null;
      // Closing this window without Done cancels the view, so the tab never stays held for nobody.
      if (viewId !== null) void end({ environmentId, input: { viewId, end: "cancel" } });
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- One view per mount; the host keys this by request id.
  }, []);

  useEffect(() => {
    if (phase.kind === "open") surfaceRef.current?.focus();
  }, [phase.kind]);

  const viewId = phase.kind === "open" ? phase.viewId : null;
  const finish = async (how: "done" | "cancel") => {
    if (viewId === null) return props.onClose();
    senderRef.current?.flush();
    const token = frameRef.current?.token;
    const result = await end({
      environmentId,
      input:
        how === "done" && token !== undefined ? { viewId, end: how, token } : { viewId, end: how },
    });
    if (result._tag !== "Success") {
      setNotice(failureText(result, tx("Could not end the sign-in. Try again.")));
      return;
    }
    setPhase({ kind: "ended", outcome: how === "done" ? "done" : "cancelled" });
  };

  const pointOn = (event: { clientX: number; clientY: number }) => {
    const shown = frameRef.current;
    const image = imageRef.current;
    if (!shown || !image) return null;
    const point = framePoint(
      { x: event.clientX, y: event.clientY },
      image.getBoundingClientRect(),
      shown,
    );
    return point === null ? null : { shown, point };
  };

  const ended = phase.kind === "ended" || phase.kind === "failed";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-4xl" data-sign-in-viewer>
        <DialogHeader>
          <DialogTitle>
            {tx("Sign in to {site} on {machine}", { site: request.site, machine: request.machine })}
          </DialogTitle>
          <DialogDescription>
            {tx(
              "Type the password and any code yourself. Agents cannot see this tab until you press Done.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            {phase.kind === "open" ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span
                  className="inline-flex items-center gap-1.5 rounded-md bg-success/10 px-2 py-1 font-mono text-success-foreground"
                  data-sign-in-origin
                >
                  <LockIcon className="size-3" aria-hidden />
                  {frame?.origin ?? tx("Loading…")}
                </span>
                <span>
                  {tx("Address read from Chrome on {machine}, not from the page", {
                    machine: request.machine,
                  })}
                </span>
                <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-warning-foreground">
                  {tx("Agents locked out")}
                </span>
              </div>
            ) : null}
            {frame?.passkey ? (
              <p
                className="rounded-md border-l-2 border-warning bg-warning/10 px-2 py-1.5 text-xs/5"
                data-sign-in-passkey
                role="status"
              >
                <KeyRoundIcon className="me-1 inline size-3" aria-hidden />
                {frame.passkey.notice}
              </p>
            ) : null}
            {notice !== null ? (
              <p className="text-xs text-muted-foreground" role="status" data-sign-in-notice>
                {notice}
              </p>
            ) : null}
            <div
              ref={surfaceRef}
              tabIndex={0}
              role="application"
              aria-label={tx("Live view of the sign-in page. Click to focus, then type.")}
              data-sign-in-surface
              className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-md border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(event) => {
                const shown = frameRef.current;
                const sender = senderRef.current;
                if (!shown || !sender) return;
                const action = signInKeyAction(event);
                if (action.kind === "ignore") return;
                event.preventDefault();
                event.stopPropagation();
                if (action.kind === "named") sender.key(shown.frame, action.key);
                else sender.text(shown.frame, action.text);
              }}
              onPaste={(event) => {
                const shown = frameRef.current;
                const text = event.clipboardData.getData("text/plain");
                if (!shown || !text) return;
                event.preventDefault();
                senderRef.current?.text(shown.frame, text);
                senderRef.current?.flush();
              }}
            >
              {phase.kind === "opening" ? (
                <p className="text-sm text-muted-foreground">
                  {tx("Opening the sign-in page on {machine}…", { machine: request.machine })}
                </p>
              ) : phase.kind === "failed" ? (
                <p className="text-sm text-destructive-foreground" role="alert">
                  {phase.message}
                </p>
              ) : phase.kind === "ended" ? (
                <p className="text-sm text-muted-foreground" data-sign-in-ended={phase.outcome}>
                  {phase.outcome === "done"
                    ? tx("Signed in. The agent can carry on.")
                    : phase.outcome === "timed_out"
                      ? tx("The view closed after ten minutes with nothing done in it.")
                      : phase.outcome === "tab_closed"
                        ? tx("The tab was closed in Chrome.")
                        : tx("The sign-in was cancelled and its tab closed.")}
                </p>
              ) : frame ? (
                <img
                  ref={imageRef}
                  src={`data:image/jpeg;base64,${frame.data}`}
                  alt={frame.title || tx("The sign-in page")}
                  draggable={false}
                  className="block h-auto max-h-[65vh] w-auto max-w-full select-none"
                  onClick={(event) => {
                    surfaceRef.current?.focus();
                    const at = pointOn(event);
                    if (!at || viewId === null) return;
                    senderRef.current?.other(async () => {
                      const sent = await send({
                        environmentId,
                        input: {
                          viewId,
                          token: at.shown.token,
                          input: { type: "click", frame: at.shown.frame, ...at.point },
                        },
                      });
                      if (sent._tag !== "Success")
                        setNotice(failureText(sent, tx("That click was not sent.")));
                    });
                  }}
                  onWheel={(event) => {
                    const at = pointOn(event);
                    if (!at || viewId === null) return;
                    const deltaX = Math.max(-5_000, Math.min(5_000, event.deltaX));
                    const deltaY = Math.max(-5_000, Math.min(5_000, event.deltaY));
                    senderRef.current?.other(async () => {
                      await send({
                        environmentId,
                        input: {
                          viewId,
                          token: at.shown.token,
                          input: {
                            type: "scroll",
                            frame: at.shown.frame,
                            ...at.point,
                            deltaX,
                            deltaY,
                          },
                        },
                      });
                    });
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {tx("Waiting for the first frame…")}
                </p>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter className="items-center">
          {phase.kind === "open" ? (
            <span className="me-auto text-xs text-muted-foreground">
              {tx("Typing is sealed to key {fingerprint}. Ends after 10 minutes idle.", {
                fingerprint: phase.fingerprint,
              })}
            </span>
          ) : null}
          {ended ? (
            <>
              {phase.kind === "failed" && retryable && props.onRetry ? (
                <Button variant="outline" onClick={props.onRetry} data-sign-in-retry>
                  {tx("Try again")}
                </Button>
              ) : null}
              <Button onClick={props.onClose}>{tx("Close")}</Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => void finish("cancel")}
                data-sign-in-end="cancel"
              >
                {tx("Cancel")}
              </Button>
              <Button
                onClick={() => void finish("done")}
                disabled={phase.kind !== "open"}
                data-sign-in-end="done"
              >
                {tx("Done, I'm signed in")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
