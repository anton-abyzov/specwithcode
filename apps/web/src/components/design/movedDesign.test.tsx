// @vitest-environment jsdom
import { DesignError } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const { movedDesignKey, useMovedDesignRedirect } = await import("./movedDesign");

const moved = new DesignError({
  code: "not_found",
  detail: "Moved to Atlas web.",
  movedTo: {
    owner: { kind: "project", projectId: "atlas-web" as never },
    designId: "d_pricing" as never,
  },
});
const gone = new DesignError({ code: "not_found", detail: "No such design." });

describe("movedDesignKey", () => {
  it("reads the new key from get or watch, keeping the design id", () => {
    expect(movedDesignKey(moved)).toBe("p.atlas-web.d_pricing");
    expect(movedDesignKey(null, moved)).toBe("p.atlas-web.d_pricing");
  });

  it("is null for a design that is gone, or for any other failure", () => {
    expect(movedDesignKey(gone, null)).toBeNull();
    expect(movedDesignKey(new Error("socket closed"), undefined)).toBeNull();
    expect(movedDesignKey()).toBeNull();
  });
});

describe("useMovedDesignRedirect", () => {
  let container: HTMLDivElement;
  let root: Root;
  function Probe({ movedKey }: { movedKey: string | null }) {
    useMovedDesignRedirect(movedKey);
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
    navigate.mockClear();
  });
  afterEach(() => act(() => root.unmount()));

  it("replaces the old link with the moved design's route", () => {
    act(() => root.render(<Probe movedKey={null} />));
    expect(navigate).not.toHaveBeenCalled();
    act(() => root.render(<Probe movedKey={movedDesignKey(moved)} />));
    expect(navigate).toHaveBeenCalledWith({
      to: "/design/$designKey",
      params: { designKey: "p.atlas-web.d_pricing" },
      replace: true,
    });
  });
});
