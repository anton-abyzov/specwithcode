import { englishPhrase, type TranslatePhrase } from "../../../i18n";

/**
 * The Threads panel's banner while this window is signed out of SpecWithCode
 * Connect and that cuts it off from a saved machine (1417). Connect is
 * optional: with nothing cut off there is no banner. It says only what the
 * window knows: a machine "is running" only when this machine's server
 * reaches it, and "still connected" only for a live session.
 *
 * @module signedOutBannerModel
 */

export interface SignedOutBannerMachine {
  readonly name: string;
  /** Its connection stopped for want of a Connect sign-in in this window. */
  readonly needsSignIn: boolean;
  /** This machine's server reaches it now (the fleet says "reachable"). */
  readonly reachableFromMachine: boolean;
  /** This window has a live session with it now. */
  readonly connected: boolean;
  /** The app's own machine, which never needs Connect. */
  readonly isThisMachine: boolean;
}

export interface SignedOutBannerContent {
  readonly title: string;
  readonly body: string;
  /** The machines it cuts off, for the screen reader and tests. */
  readonly cutOff: ReadonlyArray<string>;
}

/** Joins names into a list the way a sentence does, in the window's language. */
export type JoinNames = (names: ReadonlyArray<string>) => string;

/** "M5", "M5 and m3", "M5, m3 and m1". */
export const joinNames: JoinNames = (names) => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

export function signedOutBanner(
  input: {
    /** This window's Connect account: only a settled "signed out" shows a banner. */
    readonly signedOut: boolean;
    readonly machines: ReadonlyArray<SignedOutBannerMachine>;
  },
  tx: TranslatePhrase = englishPhrase,
  join: JoinNames = joinNames,
): SignedOutBannerContent | null {
  if (!input.signedOut) return null;
  // A machine with a live session is never cut off, whatever its mark says.
  const cut = input.machines.filter(
    (machine) => machine.needsSignIn && !machine.isThisMachine && !machine.connected,
  );
  if (cut.length === 0) return null;
  const running = cut.filter((machine) => machine.reachableFromMachine).map(({ name }) => name);
  const unknown = cut.filter((machine) => !machine.reachableFromMachine).map(({ name }) => name);
  const working = input.machines
    .filter((machine) => machine.connected && !machine.isThisMachine && !machine.needsSignIn)
    .map(({ name }) => name);
  const lines = [
    running.length === 1
      ? tx("{machine} is running, but this window can't reach it until you sign in.", {
          machine: running[0]!,
        })
      : running.length > 1
        ? tx("{machines} are running, but this window can't reach them until you sign in.", {
            machines: join(running),
          })
        : null,
    unknown.length > 0
      ? tx("{machines} can't be reached from this window until you sign in.", {
          machines: join(unknown),
        })
      : null,
    tx("This machine is not affected."),
    working.length > 0 ? tx("Still connected: {machines}.", { machines: join(working) }) : null,
  ];
  return {
    title: tx("Signed out of SpecWithCode Connect"),
    body: lines.filter((line) => line !== null).join(" "),
    cutOff: cut.map(({ name }) => name),
  };
}
