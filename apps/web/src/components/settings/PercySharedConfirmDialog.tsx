/**
 * The confirmation behind "Use my Percy on <machine>" (1448 D-12, D-15): which
 * of the account's machines join, and, while two or more separate assistants
 * exist and none is linked, which one the link starts from and its name.
 *
 * @module PercySharedConfirmDialog
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useId, useState } from "react";

import { useTx } from "../../i18n";
import { USE_MY_PERCY_PHRASE } from "../../studio/personalAssistant";
import {
  type Phrase,
  type ShareSeat,
  shareSeatStartable,
  shareStartPlan,
} from "../../studio/personalShare";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Radio, RadioGroup } from "../ui/radio-group";

/** One other machine of the account, as the confirmation lists it. */
export interface ShareCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The window may change this machine's settings now, through its own session. */
  readonly writable: boolean;
  /** Why the machine can never join (another Connect account); it stays unticked. */
  readonly blocked: Phrase | null;
  /**
   * The relay lists it under this window's Connect account, or this machine's
   * server reports it joined. Only such a machine is ticked by default: a
   * tick shares Percy's memory, and a connected machine may be a team
   * member's, a LAN or an SSH pairing.
   */
  readonly account: boolean;
}

/** Whether a machine starts ticked; the owner's own tick or untick wins. */
export const shareCandidateTicked = (
  machine: ShareCandidate,
  choice: ReadonlyMap<string, boolean>,
): boolean => machine.blocked === null && (choice.get(machine.environmentId) ?? machine.account);

export interface ShareConfirmChoice {
  readonly ticked: readonly EnvironmentId[];
  readonly startEnvironmentId: string | null;
  readonly name: string | null;
}

export function PercySharedConfirmDialog(props: {
  readonly ownEnvironmentId: EnvironmentId;
  readonly ownLabel: string;
  readonly candidates: readonly ShareCandidate[];
  /** Each machine's own assistant, this machine's included. */
  readonly seats: readonly ShareSeat[];
  /** Memory file counts are still being read: the "Start from" default may change. */
  readonly reading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: (choice: ShareConfirmChoice) => void;
  readonly onCancel: () => void;
}) {
  const tx = useTx();
  const nameId = useId();
  // The owner's own ticks; a machine not in here keeps its default.
  const [choice, setChoice] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [startChoice, setStartChoice] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const ticked = props.candidates
    .filter((machine) => shareCandidateTicked(machine, choice))
    .map((machine) => machine.environmentId);
  const taking = new Set<string>([props.ownEnvironmentId, ...ticked]);
  const writable = new Set<string>(
    props.candidates.filter((machine) => machine.writable).map((machine) => machine.environmentId),
  );
  const startable = (environmentId: string) =>
    shareSeatStartable(props.ownEnvironmentId, writable, environmentId);
  const plan = shareStartPlan({
    ownEnvironmentId: props.ownEnvironmentId,
    seats: props.seats.filter((seat) => taking.has(seat.environmentId)),
    writable,
  });
  const labelOf = (environmentId: string) =>
    environmentId === props.ownEnvironmentId
      ? props.ownLabel
      : (props.candidates.find((machine) => machine.environmentId === environmentId)?.label ??
        environmentId);
  const start =
    plan.kind === "choose"
      ? startChoice !== null &&
        startable(startChoice) &&
        plan.options.some((seat) => seat.environmentId === startChoice)
        ? startChoice
        : plan.defaultEnvironmentId
      : plan.kind === "join"
        ? null
        : plan.environmentId;
  const name = plan.kind === "choose" ? (nameDraft ?? plan.defaultName) : null;
  const nameMissing = name !== null && name.trim().length === 0;
  const title = tx(USE_MY_PERCY_PHRASE, { machine: props.ownLabel });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A running change finishes in view, so a failure is never dropped unseen.
        if (!open && !props.busy) props.onCancel();
      }}
    >
      <DialogPopup showCloseButton={!props.busy} data-percy-shared-confirm>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {tx(
              "Percy's memory, instructions, name and attached repositories become the same on the machines you tick. Each machine saves a copy first, so you can undo it there. No chat is moved.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            <fieldset className="grid gap-2">
              <legend className="mb-1 font-medium text-foreground text-sm">
                {tx("Machines that join")}
              </legend>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked disabled aria-label={props.ownLabel} />
                <span className="min-w-0">
                  {props.ownLabel}{" "}
                  <span className="text-muted-foreground">{tx("(this machine)")}</span>
                </span>
              </label>
              {props.candidates.map((machine) => {
                const isTicked = shareCandidateTicked(machine, choice);
                return (
                  <label
                    key={machine.environmentId}
                    className="flex items-start gap-2 text-sm"
                    data-share-candidate={machine.environmentId}
                  >
                    <Checkbox
                      checked={isTicked}
                      disabled={machine.blocked !== null || props.busy}
                      aria-label={machine.label}
                      onCheckedChange={(checked) =>
                        setChoice((current) => new Map(current).set(machine.environmentId, checked))
                      }
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span>{machine.label}</span>
                      {machine.blocked ? (
                        <span className="text-muted-foreground text-xs">
                          {tx(machine.blocked.text, machine.blocked.values)}
                        </span>
                      ) : (
                        <>
                          {machine.account ? null : (
                            <span className="text-muted-foreground text-xs" data-share-not-account>
                              {tx("Not listed under your Connect account")}
                            </span>
                          )}
                          {!machine.writable && isTicked ? (
                            <span className="text-muted-foreground text-xs" data-share-manual>
                              {tx("Turn it on in Settings on {machine}", {
                                machine: machine.label,
                              })}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                  </label>
                );
              })}
              {props.candidates.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {tx(
                    "This window knows no other machine yet. Turn the switch on in Settings on each one; it joins by itself.",
                  )}
                </p>
              ) : null}
            </fieldset>

            {plan.kind === "choose" ? (
              <>
                <fieldset className="grid gap-2" data-share-start>
                  <legend className="mb-1 font-medium text-foreground text-sm">
                    {tx("Start from")}
                  </legend>
                  <RadioGroup
                    value={start ?? ""}
                    onValueChange={(value) => setStartChoice(String(value))}
                    aria-label={tx("Start from")}
                  >
                    {plan.options.map((seat) => (
                      <label
                        key={seat.environmentId}
                        className="flex items-start gap-2 text-sm"
                        data-share-start-option={seat.environmentId}
                      >
                        <Radio
                          value={seat.environmentId}
                          disabled={props.busy || !startable(seat.environmentId)}
                        />
                        <span className="grid min-w-0 gap-0.5">
                          <span>
                            {tx("{name} on {machine}", {
                              name: seat.title,
                              machine: labelOf(seat.environmentId),
                            })}
                          </span>
                          {startable(seat.environmentId) ? null : (
                            <span
                              className="text-muted-foreground text-xs"
                              data-share-start-elsewhere
                            >
                              {tx("Choose it in Settings on {machine}", {
                                machine: labelOf(seat.environmentId),
                              })}
                            </span>
                          )}
                          <span className="text-muted-foreground text-xs">
                            {seat.memoryFileCount === null
                              ? props.reading
                                ? tx("Reading its memory…")
                                : tx("Its memory could not be read")
                              : seat.memoryFileCount === 1
                                ? tx("1 memory file")
                                : tx("{count} memory files", {
                                    count: String(seat.memoryFileCount),
                                  })}
                          </span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                  <p className="text-muted-foreground text-xs">
                    {tx(
                      "Its instructions, icon and repository list lead. Memory from every machine is kept: nothing is dropped.",
                    )}
                  </p>
                </fieldset>
                <div className="grid gap-1.5">
                  <label htmlFor={nameId} className="font-medium text-foreground text-sm">
                    {tx("Name")}
                  </label>
                  <Input
                    id={nameId}
                    value={name ?? ""}
                    maxLength={120}
                    disabled={props.busy}
                    aria-invalid={nameMissing || undefined}
                    onChange={(event) => setNameDraft(event.target.value)}
                  />
                </div>
              </>
            ) : null}

            {props.error ? (
              <p role="alert" className="text-error-foreground text-xs">
                {props.error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            {tx("Cancel")}
          </Button>
          <Button
            disabled={props.busy || nameMissing}
            data-share-confirm
            onClick={() => props.onConfirm({ ticked, startEnvironmentId: start, name })}
          >
            {props.busy ? tx("Turning on…") : tx("Turn on")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
