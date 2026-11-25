import { describe, expect, it } from "vite-plus/test";

import {
  artifactAppInstallFolders,
  linuxArtifactAppDesktopEntry,
  macArtifactAppBundle,
  windowsArtifactAppShortcut,
  type LauncherFile,
} from "./ArtifactAppLaunchers.ts";
import { artifactAppLaunchUrl, artifactAppUserModelId } from "./ArtifactAppUrl.ts";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const URL = artifactAppLaunchUrl("studio", ID);

const textFile = (files: ReadonlyArray<LauncherFile>, relativePath: string) => {
  const file = files.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined || file.kind !== "text") throw new Error(`missing ${relativePath}`);
  return file;
};

// Each generator takes a launch URL; none may accept anything but this install's canonical URL.
const hostileLaunches: ReadonlyArray<[string, string, string]> = [
  ["another install's URL", ID, artifactAppLaunchUrl("studio", OTHER_ID)],
  ["a web URL", ID, "https://example.com/"],
  ["a trailing slash", ID, `${URL}/`],
  ["a query", ID, `${URL}?x`],
  ["a quote", ID, `${URL}'`],
  ["a shell command", ID, `${URL}'; rm -rf ~; '`],
  ["an uppercase scheme", ID, URL.toUpperCase()],
  ["a bad install id", "not-an-id", URL],
];

describe("macArtifactAppBundle", () => {
  const bundle = macArtifactAppBundle({
    installId: ID,
    name: "Morning dashboard",
    launchUrl: URL,
    bundleIdPrefix: "com.specweave.studio",
  });

  it("names the bundle after the app and lists its files", () => {
    expect(bundle.bundleName).toBe("Morning dashboard.app");
    expect(bundle.files.map((file) => [file.relativePath, file.kind])).toEqual([
      ["Contents/Info.plist", "text"],
      ["Contents/MacOS/launcher", "text"],
      ["Contents/Resources/AppIcon.icns", "app-icon"],
      ["Contents/PkgInfo", "text"],
    ]);
  });

  it("writes an Info.plist with a per-install bundle id", () => {
    const plist = textFile(bundle.files, "Contents/Info.plist").contents;
    expect(plist).toContain(
      "<key>CFBundleIdentifier</key>\n\t<string>com.specweave.studio.artifactapp.0123456789abcdef0123456789abcdef</string>",
    );
    expect(plist).toContain("<key>CFBundleName</key>\n\t<string>Morning dashboard</string>");
    expect(plist).toContain("<key>CFBundleDisplayName</key>\n\t<string>Morning dashboard</string>");
    expect(plist).toContain("<key>CFBundleExecutable</key>\n\t<string>launcher</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>\n\t<string>AppIcon</string>");
    expect(plist).toContain("<key>CFBundlePackageType</key>\n\t<string>APPL</string>");
    expect(plist).toContain("<key>LSMinimumSystemVersion</key>\n\t<string>12.0</string>");
    expect(plist).toContain("<key>LSUIElement</key>\n\t<false/>");
    expect(plist).toContain(
      `<key>SpecWithCodeArtifactAppInstallId</key>\n\t<string>${ID}</string>`,
    );
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("XML-escapes the name", () => {
    const escaped = macArtifactAppBundle({
      installId: ID,
      name: "R&D 'quoted' &lt;tag&gt;",
      launchUrl: URL,
      bundleIdPrefix: "com.specweave.studio",
      minimumSystemVersion: "13.0",
    });
    const plist = textFile(escaped.files, "Contents/Info.plist").contents;
    expect(plist).toContain("<string>R&amp;D &apos;quoted&apos; &amp;lt;tag&amp;gt;</string>");
    expect(plist).not.toContain("<string>R&D");
    expect(plist).toContain("<string>13.0</string>");
    expect(escaped.bundleName).toBe("R&D 'quoted' &lt;tag&gt;.app");
  });

  it("writes an executable launcher that only opens the launch URL", () => {
    const launcher = textFile(bundle.files, "Contents/MacOS/launcher");
    expect(launcher.mode).toBe(0o755);
    expect(launcher.contents).toBe(`#!/bin/sh\nexec /usr/bin/open '${URL}'\n`);
  });

  it("writes PkgInfo without a newline", () => {
    expect(textFile(bundle.files, "Contents/PkgInfo").contents).toBe("APPL????");
  });

  it.each(hostileLaunches)("rejects %s", (_label, installId, launchUrl) => {
    expect(() =>
      macArtifactAppBundle({
        installId,
        name: "Board",
        launchUrl,
        bundleIdPrefix: "com.specweave.studio",
      }),
    ).toThrow();
  });

  it.each([
    ["a path", "../../Library/LaunchAgents/x"],
    ["a separator", "a/b"],
    ["a trailing .app", "Board.app"],
    ["a leading dot", ".hidden"],
    ["a newline", "a\nb"],
    ["an empty name", ""],
  ])("rejects an unsanitized name with %s", (_label, name) => {
    expect(() =>
      macArtifactAppBundle({ installId: ID, name, launchUrl: URL, bundleIdPrefix: "com.x" }),
    ).toThrow();
  });

  it("rejects a bad bundle id prefix or system version", () => {
    expect(() =>
      macArtifactAppBundle({ installId: ID, name: "B", launchUrl: URL, bundleIdPrefix: "com x" }),
    ).toThrow();
    expect(() =>
      macArtifactAppBundle({
        installId: ID,
        name: "B",
        launchUrl: URL,
        bundleIdPrefix: "com.x",
        minimumSystemVersion: "12</string>",
      }),
    ).toThrow();
  });
});

describe("linuxArtifactAppDesktopEntry", () => {
  it("writes a desktop entry that opens the launch URL", () => {
    const entry = linuxArtifactAppDesktopEntry({
      installId: ID,
      name: "Morning dashboard",
      launchUrl: URL,
      iconPath: "/home/me/.local/share/icons/specwithcode.png",
    });
    expect(entry.fileName).toBe(`specwithcode-app-${ID}.desktop`);
    expect(entry.contents.split("\n")).toEqual([
      "[Desktop Entry]",
      "Type=Application",
      "Name=Morning dashboard",
      "Comment=A page installed from SpecWithCode",
      `Exec=xdg-open "${URL}"`,
      "Icon=/home/me/.local/share/icons/specwithcode.png",
      "Terminal=false",
      "Categories=Utility;",
      "StartupNotify=true",
      `X-SpecWithCode-Artifact-App=${ID}`,
      "",
    ]);
  });

  it("omits the icon when there is none", () => {
    const entry = linuxArtifactAppDesktopEntry({
      installId: ID,
      name: "Board",
      launchUrl: URL,
      iconPath: null,
    });
    expect(entry.contents).not.toContain("Icon=");
  });

  it("escapes the name and icon per the Desktop Entry spec", () => {
    const entry = linuxArtifactAppDesktopEntry({
      installId: ID,
      name: "50% $HOME `x`",
      launchUrl: URL,
      iconPath: "C:\\icons\\a.png",
    });
    const lines = entry.contents.split("\n");
    expect(lines).toContain("Name=50% $HOME `x`");
    expect(lines).toContain("Icon=C:\\\\icons\\\\a.png");
    // Only the keys written above appear; nothing in the name can start a new key.
    expect(lines.filter((line) => line.includes("="))).toHaveLength(9);
  });

  it.each(hostileLaunches)("rejects %s", (_label, installId, launchUrl) => {
    expect(() =>
      linuxArtifactAppDesktopEntry({ installId, name: "Board", launchUrl, iconPath: null }),
    ).toThrow();
  });

  it("rejects an unsanitized name and an icon path with a newline", () => {
    expect(() =>
      linuxArtifactAppDesktopEntry({
        installId: ID,
        name: "a\nExec=evil",
        launchUrl: URL,
        iconPath: null,
      }),
    ).toThrow();
    expect(() =>
      linuxArtifactAppDesktopEntry({
        installId: ID,
        name: "Board",
        launchUrl: URL,
        iconPath: "/x\nExec=evil",
      }),
    ).toThrow();
  });
});

describe("windowsArtifactAppShortcut", () => {
  const appUserModelId = artifactAppUserModelId("com.specweave.studio", ID);
  const executablePath = "C:\\Users\\me\\AppData\\Local\\Programs\\SpecWithCode\\SpecWithCode.exe";

  it("starts SpecWithCode with the launch URL and a per-install identity", () => {
    const shortcut = windowsArtifactAppShortcut({
      installId: ID,
      name: "Morning dashboard",
      launchUrl: URL,
      executablePath,
      iconPath: "C:\\icons\\specwithcode.ico",
      appUserModelId,
    });
    expect(shortcut).toEqual({
      fileName: "Morning dashboard.lnk",
      options: {
        target: executablePath,
        args: `"${URL}"`,
        description: "Morning dashboard, a page installed from SpecWithCode",
        icon: "C:\\icons\\specwithcode.ico",
        iconIndex: 0,
        appUserModelId: `com.specweave.studio.artifactapp.${ID}`,
      },
    });
  });

  it("leaves the icon out when there is none", () => {
    const shortcut = windowsArtifactAppShortcut({
      installId: ID,
      name: "Board",
      launchUrl: URL,
      executablePath,
      iconPath: null,
      appUserModelId,
    });
    expect("icon" in shortcut.options).toBe(false);
    expect("iconIndex" in shortcut.options).toBe(false);
  });

  it.each(hostileLaunches)("rejects %s", (_label, installId, launchUrl) => {
    expect(() =>
      windowsArtifactAppShortcut({
        installId,
        name: "Board",
        launchUrl,
        executablePath,
        iconPath: null,
        appUserModelId,
      }),
    ).toThrow();
  });

  it("rejects an unsanitized name, a bad AppUserModelID and a path with control characters", () => {
    const base = { installId: ID, launchUrl: URL, executablePath, iconPath: null, appUserModelId };
    expect(() => windowsArtifactAppShortcut({ ...base, name: "..\\..\\Startup\\x" })).toThrow();
    expect(() => windowsArtifactAppShortcut({ ...base, name: "CON" })).toThrow();
    expect(() =>
      windowsArtifactAppShortcut({ ...base, name: "Board", appUserModelId: "has space" }),
    ).toThrow();
    expect(() =>
      windowsArtifactAppShortcut({ ...base, name: "Board", appUserModelId: "x".repeat(129) }),
    ).toThrow();
    expect(() =>
      windowsArtifactAppShortcut({ ...base, name: "Board", executablePath: "C:\\a\nb.exe" }),
    ).toThrow();
  });
});

describe("artifactAppInstallFolders", () => {
  const common = {
    homeDir: "/Users/me",
    appDataDir: "C:\\Users\\me\\AppData\\Roaming",
    desktopDir: "C:\\Users\\me\\Desktop",
    displayName: "SpecWithCode",
  };

  it("uses ~/Applications/<name> Apps on macOS", () => {
    expect(artifactAppInstallFolders({ ...common, platform: "darwin" })).toEqual({
      primary: "/Users/me/Applications/SpecWithCode Apps",
      desktop: null,
    });
  });

  it("uses the Start menu programs folder and the Desktop on Windows, with Windows paths", () => {
    expect(artifactAppInstallFolders({ ...common, platform: "win32" })).toEqual({
      primary:
        "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\SpecWithCode Apps",
      desktop: "C:\\Users\\me\\Desktop",
    });
  });

  it("uses ~/.local/share/applications on Linux and other systems", () => {
    for (const platform of ["linux", "freebsd"] as const) {
      expect(artifactAppInstallFolders({ ...common, homeDir: "/home/me", platform })).toEqual({
        primary: "/home/me/.local/share/applications",
        desktop: null,
      });
    }
  });

  it("follows the display name", () => {
    expect(
      artifactAppInstallFolders({ ...common, platform: "darwin", displayName: "SpecWithCode Dev" })
        .primary,
    ).toBe("/Users/me/Applications/SpecWithCode Dev Apps");
  });
});
