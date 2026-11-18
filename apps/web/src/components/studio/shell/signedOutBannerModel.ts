import { englishPhrase, type TranslatePhrase } from "../../../i18n";

/**
 * The Threads panel's banner while this window is signed out of SpecWithCode
 * Connect and that cuts it off from a saved machine (1417). Connect is
 * optional: with nothing cut off there is no banner.
 *
 * @module signedOutBannerModel
 */

export interface SignedOutBannerMachine {
  readonly name: string;
  /** Its connection stopped for want of a Connect sign-in in this window. */
  readonly needsSignIn: boolean;
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

/** "M5", "M5 and m3", "M5, m3 and m1". */
export function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function signedOutBanner(
  input: {
    /** This window's Connect account: only a settled "signed out" shows a banner. */
    readonly signedOut: boolean;
    readonly machines: ReadonlyArray<SignedOutBannerMachine>;
  },
  tx: TranslatePhrase = englishPhrase,
): SignedOutBannerContent | null {
  if (!input.signedOut) return null;
  const cutOff = input.machines
    .filter((machine) => machine.needsSignIn && !machine.isThisMachine)
    .map((machine) => machine.name);
  if (cutOff.length === 0) return null;
  const working = input.machines
    .filter((machine) => machine.connected && !machine.isThisMachine && !machine.needsSignIn)
    .map((machine) => machine.name);
  const cut = tx("{machines} can't be opened from this window until you sign in.", {
    machines: joinNames(cutOff),
  });
  const still =
    working.length === 0
      ? tx("This machine is not affected.")
      : tx("This machine and {machines} are not affected.", { machines: joinNames(working) });
  return { title: tx("Signed out of SpecWithCode Connect"), body: `${cut} ${still}`, cutOff };
}
