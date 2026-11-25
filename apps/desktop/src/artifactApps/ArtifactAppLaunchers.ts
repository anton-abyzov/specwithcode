// @effect-diagnostics nodeBuiltinImport:off - Pure path rules for POSIX and Windows paths (path.posix and path.win32), tested on any OS.
/**
 * Launcher files for an installed page, as data: the installer writes them.
 * A launcher only opens the app's launch URL for one install id, so every
 * generator checks that the URL is exactly that canonical URL for that id and
 * that the name is already sanitized; nothing from a page reaches a file
 * name, a plist, a shell script or a desktop entry unchecked.
 */
import * as NodePath from "node:path";

import { sanitizeArtifactAppName } from "./ArtifactAppName.ts";
import {
  artifactAppLaunchUrl,
  isArtifactAppInstallId,
  isArtifactAppScheme,
} from "./ArtifactAppUrl.ts";

export type LauncherFile =
  | {
      readonly relativePath: string;
      readonly kind: "text";
      readonly contents: string;
      readonly mode: number;
    }
  | { readonly relativePath: string; readonly kind: "app-icon" };

const DEFAULT_MINIMUM_SYSTEM_VERSION = "12.0";
const BUNDLE_ID_PREFIX_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
const SYSTEM_VERSION_PATTERN = /^[0-9]+(\.[0-9]+){0,2}$/;
const APP_USER_MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// oxlint-disable-next-line no-control-regex -- Paths written into launchers must not carry control characters.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f\u2028\u2029]/u;

function assertInstallId(installId: string): void {
  if (!isArtifactAppInstallId(installId)) throw new Error("Invalid install id.");
}

/** The URL must be the canonical launch URL for this install, nothing more. */
function assertLaunchUrl(installId: string, launchUrl: string): void {
  assertInstallId(installId);
  const separator = launchUrl.indexOf("://");
  const scheme = separator > 0 ? launchUrl.slice(0, separator) : "";
  if (!isArtifactAppScheme(scheme) || launchUrl !== artifactAppLaunchUrl(scheme, installId)) {
    throw new Error("The launch URL does not match the install.");
  }
}

/** The name becomes a file name, so it must already be a sanitized app name. */
function assertName(name: string): void {
  if (name.length === 0 || sanitizeArtifactAppName(name) !== name) {
    throw new Error("The app name is not sanitized.");
  }
}

function assertPlainPath(value: string, label: string): void {
  if (value.length === 0 || CONTROL_CHARACTER.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function singleQuoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function plistEntry(key: string, value: string | boolean): string {
  const rendered =
    typeof value === "boolean" ? `<${value}/>` : `<string>${escapeXml(value)}</string>`;
  return `\t<key>${escapeXml(key)}</key>\n\t${rendered}`;
}

export function macArtifactAppBundle(input: {
  readonly installId: string;
  readonly name: string;
  readonly launchUrl: string;
  readonly bundleIdPrefix: string;
  readonly minimumSystemVersion?: string;
}): { readonly bundleName: string; readonly files: ReadonlyArray<LauncherFile> } {
  assertLaunchUrl(input.installId, input.launchUrl);
  assertName(input.name);
  if (!BUNDLE_ID_PREFIX_PATTERN.test(input.bundleIdPrefix)) {
    throw new Error("Invalid bundle identifier prefix.");
  }
  const minimumSystemVersion = input.minimumSystemVersion ?? DEFAULT_MINIMUM_SYSTEM_VERSION;
  if (!SYSTEM_VERSION_PATTERN.test(minimumSystemVersion)) {
    throw new Error("Invalid minimum system version.");
  }

  const infoPlist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    plistEntry("CFBundleDevelopmentRegion", "en"),
    plistEntry("CFBundleDisplayName", input.name),
    plistEntry("CFBundleExecutable", "launcher"),
    plistEntry("CFBundleIconFile", "AppIcon"),
    plistEntry("CFBundleIdentifier", `${input.bundleIdPrefix}.artifactapp.${input.installId}`),
    plistEntry("CFBundleInfoDictionaryVersion", "6.0"),
    plistEntry("CFBundleName", input.name),
    plistEntry("CFBundlePackageType", "APPL"),
    plistEntry("CFBundleShortVersionString", "1.0"),
    plistEntry("CFBundleVersion", "1"),
    plistEntry("LSMinimumSystemVersion", minimumSystemVersion),
    plistEntry("LSUIElement", false),
    plistEntry("NSHighResolutionCapable", true),
    plistEntry("SpecWithCodeArtifactAppInstallId", input.installId),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  // The launcher hands the install id to SpecWithCode and exits; the app owns the window.
  const launcher = [
    "#!/bin/sh",
    `exec /usr/bin/open ${singleQuoteShell(input.launchUrl)}`,
    "",
  ].join("\n");

  return {
    bundleName: `${input.name}.app`,
    files: [
      { relativePath: "Contents/Info.plist", kind: "text", contents: infoPlist, mode: 0o644 },
      { relativePath: "Contents/MacOS/launcher", kind: "text", contents: launcher, mode: 0o755 },
      { relativePath: "Contents/Resources/AppIcon.icns", kind: "app-icon" },
      { relativePath: "Contents/PkgInfo", kind: "text", contents: "APPL????", mode: 0o644 },
    ],
  };
}

// Desktop Entry spec: string values escape backslash, newline, carriage return and tab.
function escapeDesktopEntryString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

// Exec values are unescaped twice (string rules, then Exec quoting), so the
// argument is quoted with reserved characters escaped and percent signs
// doubled, then string-escaped on top.
function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

export function linuxArtifactAppDesktopEntry(input: {
  readonly installId: string;
  readonly name: string;
  readonly launchUrl: string;
  readonly iconPath: string | null;
}): { readonly fileName: string; readonly contents: string } {
  assertLaunchUrl(input.installId, input.launchUrl);
  assertName(input.name);
  if (input.iconPath !== null) assertPlainPath(input.iconPath, "icon path");
  const contents = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.name)}`,
    "Comment=A page installed from SpecWithCode",
    `Exec=xdg-open ${escapeDesktopEntryExecArgument(input.launchUrl)}`,
    ...(input.iconPath === null ? [] : [`Icon=${escapeDesktopEntryString(input.iconPath)}`]),
    "Terminal=false",
    "Categories=Utility;",
    "StartupNotify=true",
    `X-SpecWithCode-Artifact-App=${input.installId}`,
    "",
  ].join("\n");
  return { fileName: `specwithcode-app-${input.installId}.desktop`, contents };
}

export function windowsArtifactAppShortcut(input: {
  readonly installId: string;
  readonly name: string;
  readonly launchUrl: string;
  readonly executablePath: string;
  readonly iconPath: string | null;
  readonly appUserModelId: string;
}): {
  readonly fileName: string;
  readonly options: {
    target: string;
    args: string;
    description: string;
    icon?: string;
    iconIndex?: number;
    appUserModelId: string;
  };
} {
  assertLaunchUrl(input.installId, input.launchUrl);
  assertName(input.name);
  assertPlainPath(input.executablePath, "executable path");
  if (input.iconPath !== null) assertPlainPath(input.iconPath, "icon path");
  if (!APP_USER_MODEL_ID_PATTERN.test(input.appUserModelId)) {
    throw new Error("Invalid AppUserModelID.");
  }
  return {
    fileName: `${input.name}.lnk`,
    options: {
      target: input.executablePath,
      args: `"${input.launchUrl}"`,
      description: `${input.name}, a page installed from SpecWithCode`,
      ...(input.iconPath === null ? {} : { icon: input.iconPath, iconIndex: 0 }),
      appUserModelId: input.appUserModelId,
    },
  };
}

/** Where launchers go. Joined with the target platform's path rules, not the host's. */
export function artifactAppInstallFolders(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly appDataDir: string;
  readonly desktopDir: string;
  readonly displayName: string;
}): { readonly primary: string; readonly desktop: string | null } {
  const appsFolder = `${input.displayName} Apps`;
  if (input.platform === "darwin") {
    return {
      primary: NodePath.posix.join(input.homeDir, "Applications", appsFolder),
      desktop: null,
    };
  }
  if (input.platform === "win32") {
    return {
      primary: NodePath.win32.join(
        input.appDataDir,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        appsFolder,
      ),
      desktop: input.desktopDir,
    };
  }
  return {
    primary: NodePath.posix.join(input.homeDir, ".local", "share", "applications"),
    desktop: null,
  };
}
