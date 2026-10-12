import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { sourcePathContext } from "./BrowserImport/Sources.ts";
import {
  ExternalBrowsers,
  buildExternalBrowserLaunch,
  listInstalledExternalBrowsers,
  make,
  openInInstalledBrowser,
  parseExternalWebUrl,
  resolveExternalBrowserTarget,
  type ExternalBrowserLaunch,
  type InstalledExternalBrowser,
} from "./ExternalBrowsers.ts";

const chrome: InstalledExternalBrowser = {
  id: "chrome",
  name: "Chrome",
  launchPath: "/Applications/Google Chrome.app",
  profiles: [
    { directory: "Default", name: "Personal" },
    { directory: "Profile 2", name: "Work", account: "ads@work.example" },
  ],
};

describe("parseExternalWebUrl", () => {
  it("accepts http and https", () => {
    assert.strictEqual(
      parseExternalWebUrl("https://ads.google.com/aw"),
      "https://ads.google.com/aw",
    );
    assert.strictEqual(parseExternalWebUrl("http://localhost:5173"), "http://localhost:5173/");
  });

  it("rejects other schemes, credentials and garbage", () => {
    assert.isNull(parseExternalWebUrl("file:///etc/passwd"));
    assert.isNull(parseExternalWebUrl("javascript:alert(1)"));
    assert.isNull(parseExternalWebUrl("chrome://settings"));
    assert.isNull(parseExternalWebUrl("https://user:pw@example.com"));
    assert.isNull(parseExternalWebUrl("--headless"));
  });
});

describe("buildExternalBrowserLaunch", () => {
  it("uses open -na with the profile flag on macOS", () => {
    assert.deepStrictEqual(
      buildExternalBrowserLaunch({
        platform: "darwin",
        launchPath: "/Applications/Google Chrome.app",
        profileDirectory: "Profile 2",
        url: "https://ads.google.com/",
      }),
      {
        command: "open",
        args: [
          "-na",
          "/Applications/Google Chrome.app",
          "--args",
          "--profile-directory=Profile 2",
          "https://ads.google.com/",
        ],
      },
    );
  });

  it("runs the executable directly elsewhere, without a profile when none is set", () => {
    assert.deepStrictEqual(
      buildExternalBrowserLaunch({
        platform: "win32",
        launchPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        profileDirectory: undefined,
        url: "https://example.com/",
      }),
      {
        command: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: ["https://example.com/"],
      },
    );
    assert.deepStrictEqual(
      buildExternalBrowserLaunch({
        platform: "linux",
        launchPath: "/usr/bin/google-chrome",
        profileDirectory: "Default",
        url: "https://example.com/",
      }).args,
      ["--profile-directory=Default", "https://example.com/"],
    );
  });
});

describe("resolveExternalBrowserTarget", () => {
  it("only resolves enumerated browsers and profiles", () => {
    assert.strictEqual(
      resolveExternalBrowserTarget([chrome], { browserId: "chrome", profileDirectory: "Profile 2" })
        ?.profileDirectory,
      "Profile 2",
    );
    assert.deepStrictEqual(resolveExternalBrowserTarget([chrome], { browserId: "chrome" }), {
      browser: chrome,
    });
    assert.isNull(
      resolveExternalBrowserTarget([chrome], { browserId: "chrome", profileDirectory: "../x" }),
    );
    assert.isNull(resolveExternalBrowserTarget([chrome], { browserId: "brave" }));
  });
});

describe("openInInstalledBrowser", () => {
  const recordingSpawn = () => {
    const launches: ExternalBrowserLaunch[] = [];
    return {
      launches,
      spawn: (launch: ExternalBrowserLaunch) =>
        Effect.sync(() => {
          launches.push(launch);
          return true;
        }),
    };
  };

  it.effect("launches the enumerated profile", () =>
    Effect.gen(function* () {
      const { launches, spawn } = recordingSpawn();
      const opened = yield* openInInstalledBrowser({
        request: {
          url: "https://ads.google.com",
          target: { browserId: "chrome", profileDirectory: "Profile 2" },
        },
        browsers: [chrome],
        platform: "darwin",
        spawn,
      });
      assert.isTrue(opened);
      assert.deepStrictEqual(launches[0]?.args.slice(-2), [
        "--profile-directory=Profile 2",
        "https://ads.google.com/",
      ]);
    }),
  );

  it.effect("refuses unknown profiles and non-web URLs without launching", () =>
    Effect.gen(function* () {
      const { launches, spawn } = recordingSpawn();
      assert.isFalse(
        yield* openInInstalledBrowser({
          request: {
            url: "https://ads.google.com",
            target: { browserId: "chrome", profileDirectory: "Profile 9" },
          },
          browsers: [chrome],
          platform: "darwin",
          spawn,
        }),
      );
      assert.isFalse(
        yield* openInInstalledBrowser({
          request: { url: "file:///etc/hosts", target: { browserId: "chrome" } },
          browsers: [chrome],
          platform: "darwin",
          spawn,
        }),
      );
      assert.lengthOf(launches, 0);
    }),
  );
});

/** A scratch home with Chrome "installed" and two profiles in Local State. */
const withChromeHome = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-external-browsers-" });
  const applications = path.join(home, "Applications");
  yield* fileSystem.makeDirectory(path.join(applications, "Google Chrome.app"), {
    recursive: true,
  });
  const userData = path.join(home, "Library", "Application Support", "Google", "Chrome");
  yield* fileSystem.makeDirectory(userData, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(userData, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Personal" },
          "Profile 2": { name: "Work", user_name: "ads@work.example" },
          "../escape": { name: "Bad" },
        },
      },
    }),
  );
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcessEnvironment, { HOME: home }),
    Effect.provideService(HostProcessPlatform, "darwin"),
  );
  return { home, applications, context };
});

describe("listInstalledExternalBrowsers", () => {
  it.effect("finds installed browsers and their declared profiles", () =>
    Effect.gen(function* () {
      const { applications, context } = yield* withChromeHome();
      const browsers = yield* listInstalledExternalBrowsers(context, {}, [applications]);
      assert.lengthOf(browsers, 1);
      assert.strictEqual(browsers[0]?.id, "chrome");
      assert.strictEqual(browsers[0]?.launchPath, `${applications}/Google Chrome.app`);
      assert.deepStrictEqual(browsers[0]?.profiles, [
        { directory: "Default", name: "Personal" },
        { directory: "Profile 2", name: "Work", account: "ads@work.example" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("finds nothing when no browser is installed", () =>
    Effect.gen(function* () {
      const { home, context } = yield* withChromeHome();
      assert.deepStrictEqual(
        yield* listInstalledExternalBrowsers(context, {}, [`${home}/Nothing`]),
        [],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("ExternalBrowsers.openLink", () => {
  const layerFor = (input: {
    readonly settings: ClientSettings;
    readonly applications: string;
    readonly home: string;
    readonly launches: ExternalBrowserLaunch[];
    readonly shellOpened: string[];
  }) =>
    Layer.effect(
      ExternalBrowsers,
      make({
        applicationRoots: [input.applications],
        spawn: (launch) =>
          Effect.sync(() => {
            input.launches.push(launch);
            return true;
          }),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronShell.ElectronShell, {
            openExternal: (url) =>
              Effect.sync(() => {
                input.shellOpened.push(String(url));
                return true;
              }),
            openSystemSettings: () => Effect.succeed(false),
            copyText: () => Effect.void,
          }),
          Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
            get: Effect.succeedSome(input.settings),
          } as unknown as DesktopClientSettings.DesktopClientSettings["Service"]),
          Layer.succeed(HostProcessEnvironment, { HOME: input.home }),
          Layer.succeed(HostProcessPlatform, "darwin"),
        ),
      ),
    );

  it.effect("sends links to the chosen profile and others to the default browser", () =>
    Effect.gen(function* () {
      const { home, applications } = yield* withChromeHome();
      const launches: ExternalBrowserLaunch[] = [];
      const shellOpened: string[] = [];
      const settings: ClientSettings = {
        ...DEFAULT_CLIENT_SETTINGS,
        browserLinkTarget: "system",
        browserExternalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
      };
      yield* Effect.gen(function* () {
        const externalBrowsers = yield* ExternalBrowsers;
        assert.isTrue(yield* externalBrowsers.openLink("https://ads.google.com"));
        assert.isTrue(yield* externalBrowsers.openLink("mailto:me@example.com"));
        const listed = yield* externalBrowsers.list;
        assert.notProperty(listed[0] ?? {}, "launchPath");
      }).pipe(Effect.provide(layerFor({ settings, applications, home, launches, shellOpened })));
      assert.lengthOf(launches, 1);
      assert.strictEqual(launches[0]?.args.at(-1), "https://ads.google.com/");
      assert.deepStrictEqual(shellOpened, ["mailto:me@example.com"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("falls back to the default browser when the profile is gone", () =>
    Effect.gen(function* () {
      const { home, applications } = yield* withChromeHome();
      const launches: ExternalBrowserLaunch[] = [];
      const shellOpened: string[] = [];
      const settings: ClientSettings = {
        ...DEFAULT_CLIENT_SETTINGS,
        browserExternalTarget: { browserId: "chrome", profileDirectory: "Profile 7" },
      };
      yield* Effect.gen(function* () {
        const externalBrowsers = yield* ExternalBrowsers;
        assert.isTrue(yield* externalBrowsers.openLink("https://example.com"));
      }).pipe(Effect.provide(layerFor({ settings, applications, home, launches, shellOpened })));
      assert.lengthOf(launches, 0);
      assert.deepStrictEqual(shellOpened, ["https://example.com"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
