import type { DesktopCommandLineToolState } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CommandLineToolView } from "./CommandLineCard";

const base: DesktopCommandLineToolState = {
  platform: "darwin",
  unavailable: null,
  commandPath: "/Users/ada/.local/bin/specwithcode",
  binDirectory: "/Users/ada/.local/bin",
  install: "none",
  pointsAt: null,
  version: null,
  appVersion: "1.0.310",
  onPath: "yes",
  shadowedBy: null,
  startupFile: "/Users/ada/.zprofile",
  pathLine: 'export PATH="$HOME/.local/bin:$PATH" # Added by SpecWithCode',
  startupLineAdded: false,
};

const render = (
  state: Partial<DesktopCommandLineToolState> | null,
  extra: { error?: string; variant?: "card" | "offer" } = {},
) =>
  renderToStaticMarkup(
    <CommandLineToolView
      variant={extra.variant ?? "offer"}
      state={state === null ? null : { ...base, ...state }}
      pending={false}
      error={extra.error ?? null}
      onAction={() => {}}
      onOpenDocs={() => {}}
    />,
  );

describe("CommandLineToolView", () => {
  it("explains the command and what installing changes before the click", () => {
    const html = render({});
    expect(html).toContain("Not installed.");
    expect(html).toContain("Install command-line tool");
    expect(html).toContain("needs no separate sign-in");
    expect(html).toContain("Installing adds /Users/ada/.local/bin/specwithcode");
    expect(html).toContain("What is this?");
    expect(html).not.toContain(">Remove<");
  });

  it("shows the installed version and where, with Remove", () => {
    const html = render({ install: "installed", version: "1.0.310", pointsAt: "/x" });
    expect(html).toContain("Installed, matches this app (1.0.310).");
    expect(html).toContain("/Users/ada/.local/bin/specwithcode");
    expect(html).toContain(">Remove<");
    expect(html).not.toContain("Install command-line tool");
  });

  it("says when the command is older than the app", () => {
    expect(render({ install: "installed", version: "1.0.300" })).toContain(
      "Installed, version 1.0.300; this app is 1.0.310.",
    );
  });

  it("offers the startup-file edit and the exact line when the folder is not on PATH", () => {
    const html = render({ install: "installed", version: "1.0.310", onPath: "no" });
    expect(html).toContain("/Users/ada/.local/bin is not on your terminal&#x27;s PATH yet");
    expect(html).toContain("Add it to /Users/ada/.zprofile");
    expect(html).toContain(
      "export PATH=&quot;$HOME/.local/bin:$PATH&quot; # Added by SpecWithCode",
    );
  });

  it("only shows the line for a shell the app does not know", () => {
    const html = render({ install: "installed", onPath: "no", startupFile: null });
    expect(html).not.toContain("Add it to");
    expect(html).toContain("# Added by SpecWithCode");
  });

  it("tells Windows users to open a new terminal instead of editing files", () => {
    const html = render({
      platform: "win32",
      install: "installed",
      onPath: "no",
      pathLine: null,
      startupFile: null,
    });
    expect(html).toContain("Open a new terminal window to use it.");
  });

  it("offers Repair for a command that points into a deleted app", () => {
    const html = render({
      install: "broken",
      pointsAt: "/Users/ada/Downloads/SpecWithCode.app/Contents/Resources/cli/specwithcode",
    });
    expect(html).toContain("points at a copy of the app that is gone");
    expect(html).toContain(">Repair<");
    expect(html).toContain(">Remove<");
  });

  it("offers Use this copy when the command runs another copy", () => {
    const html = render({
      install: "other-copy",
      pointsAt: "/Users/ada/Applications/SpecWithCode.app",
    });
    expect(html).toContain(
      "it runs another copy of the app at /Users/ada/Applications/SpecWithCode.app",
    );
    expect(html).toContain("Use this copy");
  });

  it("never offers to replace a managed wrapper or another file", () => {
    for (const install of ["blocked-managed", "blocked-other"] as const) {
      const html = render({ install });
      expect(html).not.toContain("Install command-line tool");
      expect(html).not.toContain(">Remove<");
    }
    expect(render({ install: "blocked-managed" })).toContain(
      "command-line install of SpecWithCode",
    );
  });

  it("names another specwithcode earlier on PATH", () => {
    expect(
      render({ install: "installed", shadowedBy: "/opt/homebrew/bin/specwithcode" }),
    ).toContain(
      "A different specwithcode at /opt/homebrew/bin/specwithcode comes first on your PATH",
    );
  });

  it("refuses from a disk image with the reason and no button", () => {
    const html = render({ unavailable: "temporary-location" });
    expect(html).toContain("Move SpecWithCode to Applications");
    expect(html).not.toContain("Install command-line tool");
  });

  it("shows an action's error", () => {
    expect(render({}, { error: "EACCES" })).toContain("EACCES");
  });

  it("renders as a Settings section in the card variant", () => {
    const html = render({}, { variant: "card" });
    expect(html).toContain("data-command-line-card");
    expect(html).toContain("Command line");
  });

  it("says it is checking before the first answer", () => {
    expect(render(null)).toContain("Checking");
  });
});
