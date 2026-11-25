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
export interface DesktopArtifactAppsBridge extends DesktopArtifactAppPowersBridge {
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

/**
 * Desktop powers. A page declares the ones it wants in a manifest inside its
 * own file, the person allows them in a native dialog, and the answer holds
 * for one version of the page only: the install, the attachment and the
 * sha256 of the file's bytes. The page asks through the frame's JSON-RPC
 * channel; the shell decides every request.
 */
export const ARTIFACT_APP_POWERS = [
  "notifications",
  "tray",
  "always-on-top",
  "global-shortcuts",
] as const;
export const ArtifactAppPowerSchema = Schema.Literals(ARTIFACT_APP_POWERS);
export type ArtifactAppPower = typeof ArtifactAppPowerSchema.Type;

/** What the installed page's window shows in its Permissions menu. */
export const DesktopArtifactAppPermissionsSchema = Schema.Struct({
  /** The version the window has open; null when none is. */
  attachmentId: Schema.NullOr(Schema.String),
  /** The powers the version's file declares. */
  declared: Schema.Array(ArtifactAppPowerSchema),
  /** The declared powers the person allowed for exactly these bytes. */
  granted: Schema.Array(ArtifactAppPowerSchema),
});
export type DesktopArtifactAppPermissions = typeof DesktopArtifactAppPermissionsSchema.Type;

/**
 * - `open`: the window is about to show this version at this URL. The shell
 *   asks for consent when the version declares powers it has no answer for.
 * - `get`: the current state.
 * - `ask`: show the consent dialog again for the open version.
 * - `turn-off`: end the grant and release everything it held.
 * - `close`: the window no longer shows a version.
 */
export const DesktopArtifactAppPermissionsInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("open"),
    attachmentId: BoundedId,
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  }),
  Schema.Struct({ action: Schema.Literals(["get", "ask", "turn-off", "close"]) }),
]);
export type DesktopArtifactAppPermissionsInput =
  typeof DesktopArtifactAppPermissionsInputSchema.Type;

/** One request from the page, as the window forwards it. The shell validates `params`. */
export const DesktopArtifactAppPowerInputSchema = Schema.Struct({
  /** The version whose frame asked. A request for any other version is refused. */
  attachmentId: BoundedId,
  method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  params: Schema.Unknown,
});
export type DesktopArtifactAppPowerInput = typeof DesktopArtifactAppPowerInputSchema.Type;

const ARTIFACT_APP_POWER_ERRORS = [
  /** No grant for this power on this version, or the shell could not prove one. */
  "not-allowed",
  "invalid-request",
  "rate-limited",
  /** Another app, the app itself or another installed page uses the accelerator. */
  "shortcut-taken",
  "shortcut-limit",
  /** The operating system refused, such as a desktop without a tray. */
  "unavailable",
] as const;
export const DesktopArtifactAppPowerReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.Literals(ARTIFACT_APP_POWER_ERRORS) }),
]);
export type DesktopArtifactAppPowerReply = typeof DesktopArtifactAppPowerReplySchema.Type;

/** What the shell tells the page: a tray item was clicked or a shortcut pressed. */
export const DesktopArtifactAppPowerEventSchema = Schema.Union([
  Schema.Struct({
    attachmentId: Schema.String,
    method: Schema.Literal("app/tray/clicked"),
    params: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    attachmentId: Schema.String,
    method: Schema.Literal("app/shortcut/pressed"),
    params: Schema.Struct({ accelerator: Schema.String }),
  }),
]);
export type DesktopArtifactAppPowerEvent = typeof DesktopArtifactAppPowerEventSchema.Type;

/** The bridge methods for desktop powers; answered only inside an installed page's window. */
export interface DesktopArtifactAppPowersBridge {
  artifactAppPermissions?: (
    input: DesktopArtifactAppPermissionsInput,
  ) => Promise<DesktopArtifactAppPermissions>;
  artifactAppPower?: (input: DesktopArtifactAppPowerInput) => Promise<DesktopArtifactAppPowerReply>;
  onArtifactAppPowerEvent?: (listener: (event: DesktopArtifactAppPowerEvent) => void) => () => void;
}
