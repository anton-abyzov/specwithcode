import type { FolderCopyStatus } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { statusProgressView } from "../../studio/copyProgress";
import { CopyProgressPanel, CopyRouteLine } from "./CopyProgressPanel";

const status = (transport?: FolderCopyStatus["transport"]) =>
  ({
    state: "transferring",
    progress: {
      phase: "files",
      bytesDone: 10,
      bytesTotal: 20,
      bytesLocal: 0,
      filesDone: 1,
      filesTotal: 2,
    },
    ...(transport ? { transport } : {}),
  }) as unknown as FolderCopyStatus;

const view = (transport?: FolderCopyStatus["transport"]) =>
  statusProgressView(status(transport), "Source", "Target");

describe("the path line of a copy (1334 S-11)", () => {
  it("says which route the file contents took", () => {
    const line = (transport: FolderCopyStatus["transport"]) =>
      renderToStaticMarkup(<CopyRouteLine view={view(transport)} />);
    expect(line({ path: "lan", bytesLan: 10, bytesConnect: 0 })).toContain(
      "Over your local network",
    );
    expect(line({ path: "connect", bytesLan: 0, bytesConnect: 10 })).toContain(
      "Over SpecWithCode Connect",
    );
    expect(line({ path: "mixed", bytesLan: 4, bytesConnect: 6 })).toContain(
      "Partly over your local network, the rest over SpecWithCode Connect",
    );
  });

  it("is absent for a machine that reports no route", () => {
    expect(renderToStaticMarkup(<CopyRouteLine view={view()} />)).toBe("");
  });

  it("shows inside the running copy's panel", () => {
    const html = renderToStaticMarkup(
      <CopyProgressPanel
        view={view({ path: "lan", bytesLan: 10, bytesConnect: 0 })!}
        sourceLabel="Source"
        targetLabel="Target"
      />,
    );
    expect(html).toContain('data-slot="copy-route"');
    expect(html).toContain("Over your local network");
  });
});
