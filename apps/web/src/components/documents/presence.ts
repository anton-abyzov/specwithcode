/**
 * Who else is on a document, as the views draw it: a colour from the Office
 * series (the same eight a sheet's chips use, so it follows the theme) and a
 * short name.
 */
import type { DocumentSessionParticipant } from "@specweave-studio/contracts";

/** A participant as a view shows it. */
export interface PresenceEntry {
  readonly id: string;
  readonly kind: "window" | "agent";
  readonly name: string;
  readonly color: number;
  readonly self: boolean;
  readonly viewOnly: boolean;
  /** The tab's id in the merge document, and where on it. */
  readonly tab?: string | undefined;
  readonly cell?: string | undefined;
  readonly range?: string | undefined;
}

/**
 * Names for the people and agents on a document. Windows of one machine have
 * no name of their own, so the others are numbered in the order they joined.
 */
export function presenceEntries(
  participants: ReadonlyArray<DocumentSessionParticipant>,
  selfId: string | null,
  names: { readonly self: string; readonly window: (n: number) => string; readonly agent: string },
): ReadonlyArray<PresenceEntry> {
  let windows = 0;
  return participants.map((participant) => {
    const self = participant.id === selfId;
    if (participant.kind === "window" && !self) windows += 1;
    const name =
      participant.kind === "agent"
        ? (participant.label ?? names.agent)
        : self
          ? names.self
          : names.window(windows + 1);
    return {
      id: participant.id,
      kind: participant.kind,
      name,
      color: participant.color,
      self,
      viewOnly: participant.access === "view",
      tab: participant.place?.tab,
      cell: participant.place?.cell,
      range: participant.place?.range,
    };
  });
}
