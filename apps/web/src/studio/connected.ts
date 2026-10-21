import type { EnvironmentId } from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";
import { environmentPresentations } from "../state/presentation";

/**
 * Whether a connection is connected, as a boolean. The presentation is rebuilt
 * on every connection-state and server-config update while it stays connected;
 * a request atom that reads it whole restarts its request mid-flight each time,
 * so a slow first answer can take minutes. An equal boolean does not
 * invalidate its readers.
 */
export function connectedPhaseAtom(
  presentation: Atom.Atom<{ readonly connection: { readonly phase: string } } | null>,
) {
  return Atom.make((get) => get(presentation)?.connection.phase === "connected");
}

/** Request atoms read this instead of the environment's presentation. */
export const environmentConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  connectedPhaseAtom(environmentPresentations.presentationAtom(environmentId)).pipe(
    Atom.withLabel(`environment-connected:${environmentId}`),
  ),
);
