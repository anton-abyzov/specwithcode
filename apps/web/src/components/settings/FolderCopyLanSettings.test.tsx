import { DEFAULT_SERVER_SETTINGS, folderCopyLanGateOpen } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FOLDER_COPY_LAN_HELP, FolderCopyLanSettingsView } from "./FolderCopyLanSettings";

const render = (open: boolean) =>
  renderToStaticMarkup(
    <FolderCopyLanSettingsView open={open} checked={false} onChange={() => {}} />,
  );

describe("the local network copy setting (1334 S-11)", () => {
  it("is off by default and hidden while the review gate is closed", () => {
    expect(DEFAULT_SERVER_SETTINGS.folderCopyOverLan).toBe(false);
    for (const platform of ["darwin", "win32", "linux"])
      expect(folderCopyLanGateOpen(platform)).toBe(false);
    expect(render(false)).toBe("");
  });

  it("states the three accepted risks in plain words once it shows", () => {
    const html = render(true);
    expect(html).toContain("Copy folders over your local network");
    // R-01: addresses. R-02: observers. R-03: firewall prompt or isolation.
    expect(FOLDER_COPY_LAN_HELP[1]).toContain("private network addresses");
    expect(FOLDER_COPY_LAN_HELP[2]).toContain("Others on the network can see");
    expect(FOLDER_COPY_LAN_HELP[3]).toContain("Refusing the prompt changes no firewall rule");
    for (const line of FOLDER_COPY_LAN_HELP) expect(html).toContain(line.slice(0, 30));
  });
});
