import { useState } from "react";
import { useTx } from "../../i18n";
import type { MainOffer } from "../../studio/makeMain";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import { Button } from "../ui/button";

/**
 * Why the coordinator composer cannot send. A copy whose main is on another machine also
 * gets the two ways out: write to main's coordinator, which opens that machine's page and
 * says so, or make this machine main (`useMakeMain`: the confirmed move while the old main
 * is connected, a takeover once it has been unreachable for 10 minutes, off with its
 * reason in between).
 */
export function CoordinatorBlockedNotice({
  text,
  coordinator,
  projectTitle,
  hadConversation = false,
  current,
  copies,
  onOpen,
  mainOffer = null,
  onMakeMain = null,
  routesToMain = false,
}: {
  text: string;
  /** The checkout that starts work for this copy (main); null for any other reason. */
  coordinator: { readonly key: string; readonly machine: string | null } | null;
  projectTitle: string;
  /** This copy ran a coordinator before: its conversation stays here as history. */
  hadConversation?: boolean;
  /** This page's checkout key. */
  current: string;
  copies: readonly OrchestratorCopy[];
  /** Shows another checkout's page; null until saved choices load. */
  onOpen: ((key: string) => void) | null;
  /** "Make {this} main" for this page's copy; null when it has no switch. */
  mainOffer?: MainOffer | null;
  onMakeMain?: ((key: string) => void) | null;
  /** Send here goes to main's coordinator (`useRouteToMain`), so the note says so. */
  routesToMain?: boolean;
}) {
  const tx = useTx();
  if (!coordinator)
    return (
      <p className="project-muted" role="status">
        {text}
      </p>
    );
  const here = copies.find((copy) => copy.key === current)?.machine ?? mainOffer?.machine ?? null;
  const main = coordinator.machine;
  const offer = onMakeMain && here ? mainOffer : null;
  return (
    <div className="project-muted" role="status" data-workers-only={coordinator.key}>
      {/* One column: the message box lays its own direct children out in a row. */}
      <div className="min-w-0 flex-1">
        <p>
          {main
            ? tx("Main for {project} is {machine}. This copy takes work from there.", {
                project: projectTitle,
                machine: main,
              })
            : tx("Main for {project} is on another machine. This copy takes work from there.", {
                project: projectTitle,
              })}
          {hadConversation ? ` ${tx("The conversation here is kept as history.")}` : null}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onOpen ? (
            <Button
              variant="outline"
              size="xs"
              data-write-to-main=""
              onClick={() => onOpen(coordinator.key)}
            >
              {main
                ? tx("Write to {machine}'s coordinator", { machine: main })
                : tx("Write to main's coordinator")}
            </Button>
          ) : null}
          {offer ? (
            <Button
              variant="outline"
              size="xs"
              data-make-main={offer.key}
              disabled={offer.kind === "blocked"}
              onClick={() => onMakeMain?.(offer.key)}
            >
              {tx("Make {machine} main", { machine: offer.machine })}
            </Button>
          ) : null}
        </div>
        {routesToMain ? (
          <p className="mt-2 text-xs" data-routes-to-main="">
            {main
              ? tx(
                  "Send delivers your message to {machine}'s coordinator and opens its page, where the answer comes.",
                  { machine: main },
                )
              : tx(
                  "Send delivers your message to main's coordinator and opens its page, where the answer comes.",
                )}
          </p>
        ) : onOpen ? (
          <p className="mt-2 text-xs" data-write-to-main-note="">
            {main
              ? tx(
                  "Write opens {machine}'s page for this project, where its coordinator answers. Nothing is sent from here.",
                  { machine: main },
                )
              : tx(
                  "Write opens main's page for this project, where its coordinator answers. Nothing is sent from here.",
                )}
          </p>
        ) : null}
        {offer ? (
          <p className="mt-1 text-xs" data-make-main-note={offer.kind}>
            {offer.reason
              ? tx(offer.reason.text, offer.reason.values)
              : offer.kind === "takeover"
                ? tx(
                    "{main} has been unreachable for 10 minutes or more. Making {machine} main starts from the shared goal, memory and plan; the conversation on {main} stays there as history.",
                    { machine: offer.machine, main: offer.main },
                  )
                : tx(
                    "Making {machine} main moves the coordinator and its conversation here from {main}, which becomes a copy.",
                    { machine: offer.machine, main: offer.main },
                  )}
          </p>
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
 * On the machine that became main while the old main was unreachable: the earlier
 * conversation did not come along, so the page says where it is. Shown until the person
 * puts it away; `id` names the switch, so a later one is said again.
 */
export function OfflineSwitchNotice({
  id,
  machine,
  previous,
}: {
  /** The takeover this is about (`environmentId:projectId:operationId`). */
  id: string;
  /** This machine, the new main. */
  machine: string;
  /** The old main's machine; null when this app does not know its name. */
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
              "{machine} became main while {main} was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on {main} as history.",
              { machine, main: previous },
            )
          : tx(
              "{machine} became main while the old main was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on the old machine as history.",
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
