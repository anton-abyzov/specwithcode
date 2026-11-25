import * as Schema from "effect/Schema";

/**
 * Installed pages ("artifact apps"): a published html_render page installed as
 * an app on the person's computer. The desktop shell keeps a private record of
 * each install and writes a small launcher for the operating system (a macOS
 * app bundle, Windows shortcuts or a Linux desktop entry). The launcher only
 * names the install id; the shell owns the window and the page always comes
 * from the thread, so a page republished under the same title shows the newest
 * version on the next launch.
 */

/** A random 128-bit install id as 32 lowercase hex characters. */
export const ArtifactAppInstallIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));
export type ArtifactAppInstallId = typeof ArtifactAppInstallIdSchema.Type;

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** What the client asks the shell to install. */
export const DesktopArtifactAppInstallInputSchema = Schema.Struct({
  environmentId: BoundedId,
  threadId: BoundedId,
  /** The page's attachment id at install time, used when no page with the title remains. */
  attachmentId: BoundedId,
  /** The page title; the app is named after it and follows the newest page with it. */
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type DesktopArtifactAppInstallInput = typeof DesktopArtifactAppInstallInputSchema.Type;

/** One installed page as the client sees it. Paths stay in the shell. */
export const DesktopArtifactAppSchema = Schema.Struct({
  installId: ArtifactAppInstallIdSchema,
  /** The name the operating system shows, after sanitizing and look-alike protection. */
  name: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  attachmentId: Schema.String,
  title: Schema.String,
  /** ISO time of the install. */
  installedAt: Schema.String,
});
export type DesktopArtifactApp = typeof DesktopArtifactAppSchema.Type;

export const DesktopArtifactAppInstallResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("installed"), app: DesktopArtifactAppSchema }),
  Schema.Struct({ status: Schema.Literal("already-installed"), app: DesktopArtifactAppSchema }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type DesktopArtifactAppInstallResult = typeof DesktopArtifactAppInstallResultSchema.Type;

export const DesktopArtifactAppUninstallInputSchema = Schema.Struct({
  installId: ArtifactAppInstallIdSchema,
});
export type DesktopArtifactAppUninstallInput = typeof DesktopArtifactAppUninstallInputSchema.Type;

/** The bridge methods for installed pages. Absent on builds predating them and outside desktop. */
export interface DesktopArtifactAppsBridge {
  /** Asks the person to confirm, writes the launcher and opens the app. */
  installArtifactApp?: (
    input: DesktopArtifactAppInstallInput,
  ) => Promise<DesktopArtifactAppInstallResult>;
  /** Removes the launcher (to the Trash on macOS) and forgets the install. */
  uninstallArtifactApp?: (input: DesktopArtifactAppUninstallInput) => Promise<boolean>;
  listArtifactApps?: () => Promise<ReadonlyArray<DesktopArtifactApp>>;
  /** The install this window shows; null outside an installed-page window. */
  getArtifactApp?: () => Promise<DesktopArtifactApp | null>;
  /** Shows the launcher in Finder, Explorer or the file manager. */
  revealArtifactApp?: (input: DesktopArtifactAppUninstallInput) => Promise<boolean>;
}
