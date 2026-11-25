import { assert, describe, it } from "@effect/vitest";

import {
  admitArtifactAppNotification,
  artifactAppConsentDialog,
  artifactAppPageFileName,
  artifactAppVersionUrl,
  isArtifactAppAcceleratorFree,
  normalizeArtifactAppAccelerator,
  readArtifactAppManifest,
  readArtifactAppPowerRequest,
} from "./ArtifactAppPowers.ts";

const page = (manifest: string, type = "application/specwithcode-app+json") =>
  `<!doctype html><html><head><script type="${type}">${manifest}</script></head><body>x</body></html>`;

describe("readArtifactAppManifest", () => {
  it("reads the declared powers in a fixed order", () => {
    assert.deepEqual(readArtifactAppManifest(page('{"permissions":["tray","notifications"]}')), [
      "notifications",
      "tray",
    ]);
    assert.deepEqual(
      readArtifactAppManifest(
        `<SCRIPT id="m" type='application/specwithcode-app+json' data-x="1">\n{"permissions":["always-on-top","global-shortcuts"]}\n</SCRIPT >`,
      ),
      ["always-on-top", "global-shortcuts"],
    );
  });

  it("ignores unknown names and duplicates", () => {
    assert.deepEqual(
      readArtifactAppManifest(
        page('{"permissions":["tray","tray","files","run-programs","Notifications",7,null,{}]}'),
      ),
      ["tray"],
    );
  });

  it("declares nothing for a missing, malformed or misplaced manifest", () => {
    for (const html of [
      "",
      "<html><body>no manifest</body></html>",
      page("{not json"),
      page(""),
      page("[]"),
      page('"tray"'),
      page("null"),
      page('{"permissions":"tray"}'),
      page('{"permissions":{"tray":true}}'),
      page('{"powers":["tray"]}'),
      page(`{"permissions":[${Array.from({ length: 65 }, () => '"tray"').join(",")}]}`),
      page(`{"permissions":["tray"],"pad":"${"x".repeat(17_000)}"}`),
      // Another type, or a type that only contains the manifest's.
      page('{"permissions":["tray"]}', "application/json"),
      page('{"permissions":["tray"]}', "application/specwithcode-app+json2"),
      page('{"permissions":["tray"]}', "x-application/specwithcode-app+json"),
    ]) {
      assert.deepEqual(readArtifactAppManifest(html), [], html.slice(0, 120));
    }
  });

  it("reads only the first manifest", () => {
    assert.deepEqual(
      readArtifactAppManifest(
        `${page('{"permissions":["tray"]}')}${page('{"permissions":["notifications"]}')}`,
      ),
      ["tray"],
    );
  });
});

describe("artifactAppConsentDialog", () => {
  it("lists the powers in plain words and defaults to Cancel", () => {
    const dialog = artifactAppConsentDialog({
      name: "Bonsai",
      powers: ["notifications", "tray", "always-on-top", "global-shortcuts"],
      platform: "darwin",
    });
    assert.equal(dialog.message, "Allow Bonsai to do this on your computer?");
    assert.deepEqual(dialog.buttons, ["Allow", "Cancel"]);
    assert.equal(dialog.defaultId, 1);
    assert.equal(dialog.cancelId, 1);
    for (const words of [
      "Show notifications",
      "Add an item to the menu bar",
      "Keep its window above other windows",
      "Respond to keyboard shortcuts while you use other apps",
      "asks again when the page changes",
    ]) {
      assert.include(dialog.detail, words);
    }
    assert.include(
      artifactAppConsentDialog({ name: "B", powers: ["tray"], platform: "win32" }).detail,
      "Add an item to the system tray",
    );
  });
});

describe("readArtifactAppPowerRequest", () => {
  it("reads each request with the power it needs", () => {
    assert.deepEqual(readArtifactAppPowerRequest("app/notify", { title: " Hi ", body: "There" }), {
      power: "notifications",
      method: "app/notify",
      title: "Hi",
      body: "There",
    });
    assert.deepEqual(
      readArtifactAppPowerRequest("app/tray/set", {
        title: "5m",
        tooltip: "Break timer",
        items: [{ id: "start", label: "Start" }],
      }),
      {
        power: "tray",
        method: "app/tray/set",
        title: "5m",
        tooltip: "Break timer",
        items: [{ id: "start", label: "Start" }],
      },
    );
    assert.deepEqual(readArtifactAppPowerRequest("app/window/always-on-top", { on: true }), {
      power: "always-on-top",
      method: "app/window/always-on-top",
      on: true,
    });
    assert.deepEqual(
      readArtifactAppPowerRequest("app/shortcut/register", { accelerator: "Ctrl+Alt+K" }),
      { power: "global-shortcuts", method: "app/shortcut/register", accelerator: "Ctrl+Alt+K" },
    );
  });

  it("strips control characters from text a menu or notification shows", () => {
    const request = readArtifactAppPowerRequest("app/notify", {
      title: "A\u0000\nB",
      body: "line\r\nnext end",
    });
    assert.deepEqual(request && request.power === "notifications" ? request : null, {
      power: "notifications",
      method: "app/notify",
      title: "A B",
      body: "line next end",
    });
  });

  it("refuses unknown methods and malformed parameters", () => {
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `i${index}`, label: "x" }));
    for (const [method, params] of [
      ["app/files/read", { path: "/etc/passwd" }],
      ["app/run", { command: "ls" }],
      ["ui/open-link", { url: "https://example.com" }],
      ["app/notify", undefined],
      ["app/notify", null],
      ["app/notify", []],
      ["app/notify", { title: "", body: "x" }],
      ["app/notify", { title: 1, body: "x" }],
      ["app/notify", { title: "x" }],
      ["app/notify", { title: "x".repeat(121), body: "" }],
      ["app/notify", { title: "x", body: "y".repeat(501) }],
      ["app/tray/set", { items: [] }],
      ["app/tray/set", { tooltip: "t" }],
      ["app/tray/set", { tooltip: "t", items: items(13) }],
      [
        "app/tray/set",
        {
          tooltip: "t",
          items: [
            { id: "a", label: "x" },
            { id: "a", label: "y" },
          ],
        },
      ],
      ["app/tray/set", { tooltip: "t", items: [{ id: "", label: "x" }] }],
      ["app/tray/set", { tooltip: "t", items: [{ id: "a" }] }],
      ["app/tray/set", { tooltip: "t", title: 5, items: [] }],
      ["app/tray/set", { tooltip: "t", title: "x".repeat(25), items: [] }],
      ["app/window/always-on-top", { on: "yes" }],
      ["app/window/always-on-top", {}],
      ["app/shortcut/register", { accelerator: "" }],
      ["app/shortcut/register", { accelerator: 5 }],
      ["app/shortcut/register", { accelerator: "x".repeat(65) }],
    ] as const) {
      assert.isUndefined(readArtifactAppPowerRequest(method, params), `${method}`);
    }
    assert.equal(
      readArtifactAppPowerRequest("app/tray/set", { tooltip: "t", items: items(12) })?.power,
      "tray",
    );
  });
});

describe("normalizeArtifactAppAccelerator", () => {
  it("spells an accelerator one way per platform", () => {
    assert.equal(normalizeArtifactAppAccelerator("CmdOrCtrl+Shift+b", "darwin"), "Command+Shift+B");
    assert.equal(
      normalizeArtifactAppAccelerator("shift+CommandOrControl+B", "win32"),
      "Control+Shift+B",
    );
    assert.equal(normalizeArtifactAppAccelerator("Option+Ctrl+F5", "linux"), "Control+Alt+F5");
    assert.equal(normalizeArtifactAppAccelerator("Meta+Alt+Space", "darwin"), "Command+Alt+Space");
    assert.equal(normalizeArtifactAppAccelerator("Super+Alt+esc", "linux"), "Alt+Super+Escape");
  });

  it("refuses anything that could capture typing or is not an accelerator", () => {
    for (const accelerator of [
      "",
      "A",
      "Shift+A",
      "F5",
      "Space",
      // One modifier is every app's editing shortcut.
      "Ctrl+C",
      "CmdOrCtrl+V",
      "Alt+Tab",
      // Shift alone never counts.
      "Shift+Shift+A",
      "Ctrl+Ctrl+A",
      "Ctrl+Alt",
      "Ctrl+Alt+",
      "Ctrl+Alt+AB",
      "Ctrl+Alt+A+B",
      "Ctrl+Alt+F25",
      "Ctrl+Alt+VolumeUp",
      "Ctrl+Alt+MediaPlayPause",
      "Ctrl+Alt+PrintScreen",
      "Ctrl + Alt + A",
      "Hyper+Alt+A",
      "x".repeat(65),
    ]) {
      assert.isNull(normalizeArtifactAppAccelerator(accelerator, "linux"), accelerator);
    }
    // Command is a macOS key; two spellings of one modifier are one modifier.
    assert.isNull(normalizeArtifactAppAccelerator("Cmd+Alt+A", "win32"));
    assert.isNull(normalizeArtifactAppAccelerator("Cmd+Meta+A", "darwin"));
    assert.isNull(normalizeArtifactAppAccelerator("CmdOrCtrl+Ctrl+A", "win32"));
  });
});

describe("isArtifactAppAcceleratorFree", () => {
  const free = (canonical: string, appAccelerators: ReadonlyArray<string> = []) =>
    isArtifactAppAcceleratorFree({ canonical, platform: "darwin", appAccelerators });

  it("keeps system combinations and the app's own accelerators", () => {
    assert.isTrue(free("Command+Shift+B"));
    assert.isFalse(free("Command+Shift+4"));
    assert.isFalse(free("Command+Alt+Escape"));
    assert.isFalse(free("Command+Shift+B", ["CmdOrCtrl+Shift+B"]));
    assert.isFalse(free("Command+Shift+B", ["Shift+Command+b"]));
    // Accelerators a page could never spell do not match anything.
    assert.isTrue(free("Command+Shift+B", ["CmdOrCtrl+B", "F11", "not an accelerator"]));
  });
});

describe("admitArtifactAppNotification", () => {
  it("admits ten in a minute and the next only after the oldest ages out", () => {
    let sent: ReadonlyArray<number> = [];
    for (let index = 0; index < 10; index += 1) {
      const result = admitArtifactAppNotification(sent, 1_000 + index);
      assert.isTrue(result.admitted);
      sent = result.sent;
    }
    assert.isFalse(admitArtifactAppNotification(sent, 2_000).admitted);
    assert.isFalse(admitArtifactAppNotification(sent, 60_999).admitted);
    assert.isTrue(admitArtifactAppNotification(sent, 61_000).admitted);
  });

  it("does not open the window when the clock goes backwards", () => {
    const sent = Array.from({ length: 10 }, () => 100_000);
    assert.isFalse(admitArtifactAppNotification(sent, 0).admitted);
    assert.isFalse(admitArtifactAppNotification(sent, Number.NaN).admitted);
  });
});

describe("artifactAppPageFileName", () => {
  it("accepts only the id html_render mints", () => {
    const id = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
    assert.equal(artifactAppPageFileName(id), `${id}.html`);
    for (const bad of [
      "",
      "attachment-1",
      "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e",
      "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-png",
      "../thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
      "a/b-0f8fad5b-d9cb-469f-a165-70867728950e-html",
      "a\\b-0f8fad5b-d9cb-469f-a165-70867728950e-html",
      "a.b-0f8fad5b-d9cb-469f-a165-70867728950e-html",
      "thread-1-0F8FAD5B-d9cb-469f-a165-70867728950e-html",
      `${id}\n`,
      `${id}.html`,
      `${id}\u0000`,
    ]) {
      assert.isNull(artifactAppPageFileName(bad), JSON.stringify(bad));
    }
  });
});

describe("artifactAppVersionUrl", () => {
  it("keeps a web address without its fragment and refuses everything else", () => {
    assert.equal(
      artifactAppVersionUrl("http://127.0.0.1:3773/assets/a?token=t#theme=1"),
      "http://127.0.0.1:3773/assets/a?token=t",
    );
    for (const bad of [
      "",
      "not a url",
      "file:///etc/passwd",
      "studio://app/",
      "data:text/html,x",
      "blob:null/1",
      "javascript:alert(1)",
      "about:blank",
      "https://user:pass@example.com/",
      "https://user@example.com/",
    ]) {
      assert.isNull(artifactAppVersionUrl(bad), bad);
    }
  });
});
