/**
 * The choices "Open links in" and the browser's "Open in" menu offer, built
 * from the installed browsers the desktop shell reports.
 *
 * @module externalBrowserOptions
 */
import {
  externalBrowserTargetLabel,
  type BrowserLinkTarget,
  type ExternalBrowser,
  type ExternalBrowserTarget,
} from "@specweave-studio/contracts";

export interface ExternalBrowserChoice {
  /** Stable key for lists and select values. */
  readonly key: string;
  readonly label: string;
  /** The signed-in account, when the browser records one. */
  readonly detail?: string;
  readonly target: ExternalBrowserTarget;
}

export const externalTargetKey = (target: ExternalBrowserTarget): string =>
  `external:${target.browserId}:${target.profileDirectory ?? ""}`;

const sameTarget = (left: ExternalBrowserTarget, right: ExternalBrowserTarget): boolean =>
  left.browserId === right.browserId && left.profileDirectory === right.profileDirectory;

/**
 * One choice per profile, or one per browser that has never been opened and
 * so has no profiles yet.
 */
export function externalBrowserChoices(
  browsers: ReadonlyArray<ExternalBrowser>,
): ReadonlyArray<ExternalBrowserChoice> {
  return browsers.flatMap((browser): ExternalBrowserChoice[] => {
    if (browser.profiles.length === 0) {
      const target = { browserId: browser.id };
      return [{ key: externalTargetKey(target), label: browser.name, target }];
    }
    return browser.profiles.map((profile) => {
      const target = { browserId: browser.id, profileDirectory: profile.directory };
      return {
        key: externalTargetKey(target),
        label: externalBrowserTargetLabel(browsers, target),
        ...(profile.account ? { detail: profile.account } : {}),
        target,
      };
    });
  });
}

export interface LinkTargetOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly linkTarget: BrowserLinkTarget;
  readonly externalTarget: ExternalBrowserTarget | null;
}

export const SYSTEM_LINK_TARGET_LABEL = "Your default browser";
export const APP_LINK_TARGET_LABEL = "SpecWithCode";

/**
 * The label for a saved target that no installed profile matches exactly:
 * a browser saved without a profile opens its last-used profile, so it is
 * only "not found" when the browser itself is gone (or the profile is).
 */
function unmatchedTargetLabel(
  browsers: ReadonlyArray<ExternalBrowser>,
  saved: ExternalBrowserTarget,
): string {
  const label = externalBrowserTargetLabel(browsers, saved);
  const browser = browsers.find((candidate) => candidate.id === saved.browserId);
  if (browser && saved.profileDirectory === undefined) return `${label} (last used profile)`;
  return `${label} (not found)`;
}

/**
 * Options for the "Open links in" select and the one currently chosen.
 * Without a browser list (web build) only the two built-in choices show. A
 * saved profile that is no longer installed stays listed, marked as missing,
 * so the setting never silently reads as something else. While the list is
 * still loading (`loading`), the saved profile shows under its stored name
 * rather than reading as "Your default browser" for a moment.
 */
export function buildLinkTargetOptions(input: {
  readonly browsers: ReadonlyArray<ExternalBrowser> | null;
  readonly linkTarget: BrowserLinkTarget;
  readonly externalTarget: ExternalBrowserTarget | null;
  readonly loading?: boolean;
}): { readonly options: ReadonlyArray<LinkTargetOption>; readonly selected: LinkTargetOption } {
  const system: LinkTargetOption = {
    value: "system",
    label: SYSTEM_LINK_TARGET_LABEL,
    linkTarget: "system",
    externalTarget: null,
  };
  const app: LinkTargetOption = {
    value: "app",
    label: APP_LINK_TARGET_LABEL,
    linkTarget: "app",
    externalTarget: null,
  };
  const external: LinkTargetOption[] =
    input.browsers === null
      ? []
      : externalBrowserChoices(input.browsers).map((choice) => ({
          value: choice.key,
          label: choice.label,
          ...(choice.detail ? { detail: choice.detail } : {}),
          linkTarget: "system",
          externalTarget: choice.target,
        }));
  const saved = input.linkTarget === "system" ? input.externalTarget : null;
  if (
    saved !== null &&
    !external.some((option) => option.externalTarget && sameTarget(option.externalTarget, saved))
  ) {
    if (input.browsers !== null) {
      external.push({
        value: externalTargetKey(saved),
        label: unmatchedTargetLabel(input.browsers, saved),
        linkTarget: "system",
        externalTarget: saved,
      });
    } else if (input.loading) {
      external.push({
        value: externalTargetKey(saved),
        label: externalBrowserTargetLabel([], saved),
        linkTarget: "system",
        externalTarget: saved,
      });
    }
  }
  const options = [system, app, ...external];
  const selected =
    input.linkTarget === "app"
      ? app
      : saved === null
        ? system
        : (external.find(
            (option) => option.externalTarget && sameTarget(option.externalTarget, saved),
          ) ?? system);
  return { options, selected };
}

export const OPEN_IN_DEFAULT_BROWSER_LABEL = "Open in your default browser";

/**
 * What the in-app browser's "open outside" button does, in words: it follows
 * "Open links in", so it names the chosen profile when one is saved.
 */
export function openOutsideAppLabel(input: {
  readonly browsers: ReadonlyArray<ExternalBrowser> | null;
  readonly linkTarget: BrowserLinkTarget;
  readonly externalTarget: ExternalBrowserTarget | null;
}): string {
  if (input.linkTarget !== "system" || input.externalTarget === null) {
    return OPEN_IN_DEFAULT_BROWSER_LABEL;
  }
  return `Open in ${externalBrowserTargetLabel(input.browsers ?? [], input.externalTarget)}`;
}
