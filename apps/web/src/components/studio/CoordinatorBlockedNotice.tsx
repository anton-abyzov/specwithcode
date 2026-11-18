import { useState } from "react";
import { useTx } from "../../i18n";
import type { CoordinatorBoxState } from "../../studio/coordinatorBoxState";
import { Button } from "../ui/button";

/**
 * Why the coordinator composer cannot send, or where a send goes. On a machine without the
 * coordinator it says where the coordinator is in one line (`coordinatorBoxState`) and
 * offers "Continue here" (`useMakeMain`: the confirmed move while the coordinator's machine
 * is connected, a takeover once it has been silent for 10 minutes, off with its reason in
 * between). Send itself is the message box's own button.
 */
export function CoordinatorBlockedNotice({
  text,
  box,
  coordinatorKey = null,
  hadConversation = false,
  onContinue = null,
}: {
  text: string;
  /** The box's state on a machine without the coordinator; null for any other reason. */
  box: CoordinatorBoxState | null;
  /** The coordinator's checkout, `environmentId:projectId`. */
  coordinatorKey?: string | null;
  /** This machine ran a coordinator before: its conversation stays here as history. */
  hadConversation?: boolean;
  /** Runs "Continue here" for this page's machine; null when the page offers none. */
  onContinue?: (() => void) | null;
}) {
  const tx = useTx();
  if (!box)
    return (
      <p className="project-muted" role="status">
        {text}
      </p>
    );
  const offer = onContinue ? box.continueHere : null;
  return (
    <div
      className="project-muted"
      role="status"
      data-workers-only={coordinatorKey ?? ""}
      data-box-state={box.kind}
    >
      {/* One column: the message box lays its own direct children out in a row. */}
      <div className="min-w-0 flex-1">
        <p data-box-line="">
          {tx(box.line.text, box.line.values)}
          {hadConversation ? ` ${tx("The conversation here is kept as history.")}` : null}
        </p>
        {offer ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              data-continue-here=""
              disabled={!offer.enabled}
              onClick={() => onContinue?.()}
            >
              {tx("Continue here")}
            </Button>
            {offer.note ? (
              <span className="text-xs" data-continue-here-note="">
                {tx(offer.note.text, offer.note.values)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const SEEN_PREFIX = "specwithcode:offline-switch-seen:";

function seen(id: string): boolean {
  try {
    return localStorage.getItem(`${SEEN_PREFIX}${id}`) === "1";
  } catch {
    return false;
  }
}

/**
 * On the machine that continued the coordinator while its old machine was offline: the
 * earlier conversation did not come along, so the page says where it is. Shown until the person
 * puts it away; `id` names the switch, so a later one is said again.
 */
export function OfflineSwitchNotice({
  id,
  machine,
  previous,
}: {
  /** The takeover this is about (`environmentId:projectId:operationId`). */
  id: string;
  /** This machine, where the coordinator continues. */
  machine: string;
  /** The machine the coordinator was on; null when this app does not know its name. */
  previous: string | null;
}) {
  const tx = useTx();
  const [hidden, setHidden] = useState(() => seen(id));
  if (hidden) return null;
  return (
    <div className="project-muted" role="status" data-offline-switch={id}>
      <p className="min-w-0 flex-1">
        {previous
          ? tx(
              "The coordinator continued on {machine} while {main} was offline. It started from the shared goal, memory and plan; the earlier conversation stays on {main} as history.",
              { machine, main: previous },
            )
          : tx(
              "The coordinator continued on {machine} while its old machine was offline. It started from the shared goal, memory and plan; the earlier conversation stays on the old machine as history.",
              { machine },
            )}
      </p>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => {
          try {
            localStorage.setItem(`${SEEN_PREFIX}${id}`, "1");
          } catch {
            /* Without storage it shows again after a reload. */
          }
          setHidden(true);
        }}
      >
        {tx("Got it")}
      </Button>
    </div>
  );
}
