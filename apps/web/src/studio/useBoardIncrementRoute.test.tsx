// @vitest-environment jsdom
import { act, Activity, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const router = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: ({ select }: { select: (search: Record<string, unknown>) => unknown }) =>
    select(router.search),
  useNavigate: () => router.navigate,
}));

const { useBoardIncrementRoute } = await import("./useBoardIncrementRoute");

type Route = ReturnType<typeof useBoardIncrementRoute>;

describe("useBoardIncrementRoute", () => {
  let root: Root;
  let container: HTMLDivElement;
  let route: Route;
  const show = vi.fn();

  function Probe({ available, shown }: { available: boolean; shown: boolean }) {
    "use no memo";
    const current = useBoardIncrementRoute({ available, shown, show });
    useEffect(() => {
      route = current;
    });
    return null;
  }
  const render = (search: Record<string, unknown>, pane: { available: boolean; shown: boolean }) =>
    act(async () => {
      router.search = search;
      root.render(<Probe {...pane} />);
    });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    router.search = {};
    router.navigate.mockClear();
    show.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("reads the open increment from the page's search and ignores anything else", async () => {
    await render({ increment: "0040-search" }, { available: true, shown: true });
    expect(route.incrementId).toBe("0040-search");
    await render({ increment: "../etc" }, { available: true, shown: true });
    expect(route.incrementId).toBeNull();
    await render({}, { available: true, shown: true });
    expect(route.incrementId).toBeNull();
  });

  it("brings up the Board tab for a link that names an increment", async () => {
    await render({ increment: "0040-search" }, { available: true, shown: false });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("waits until the project is known to have a board", async () => {
    await render({ increment: "0040-search" }, { available: false, shown: false });
    expect(show).not.toHaveBeenCalled();
    await render({ increment: "0040-search" }, { available: true, shown: false });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("leaves someone who moved to another tab where they are", async () => {
    await render({ increment: "0040-search" }, { available: true, shown: false });
    await render({ increment: "0040-search" }, { available: true, shown: true });
    // They pick another tab; the increment is still named in the address.
    await render({ increment: "0040-search" }, { available: true, shown: false });
    expect(show).toHaveBeenCalledTimes(1);
    // Another link, another increment: the board comes up again.
    await render({ increment: "0041-export" }, { available: true, shown: false });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("does nothing when a card is opened on the board that is already up", async () => {
    await render({}, { available: true, shown: true });
    await render({ increment: "0040-search" }, { available: true, shown: true });
    expect(show).not.toHaveBeenCalled();
  });

  it("brings the board up again when back returns to the same increment", async () => {
    await render({ increment: "0040-search" }, { available: true, shown: false });
    await render({}, { available: true, shown: false });
    await render({ increment: "0040-search" }, { available: true, shown: false });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("brings the board up again when a kept page is shown again", async () => {
    const page = (mode: "visible" | "hidden", shown: boolean) =>
      act(async () => {
        router.search = { increment: "0040-search" };
        root.render(
          <Activity mode={mode}>
            <Probe available shown={shown} />
          </Activity>,
        );
      });
    await page("visible", false);
    expect(show).toHaveBeenCalledTimes(1);
    await page("visible", true);
    // Another project is opened and its panel is left on another tab; this page is kept, hidden.
    await page("hidden", false);
    await page("visible", false);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("opens with a history entry, walks and closes by replacing it", async () => {
    await render({ thread: "t1", increment: "0040-search" }, { available: true, shown: true });
    const rewrite = () => {
      const options = router.navigate.mock.calls.at(-1)![0] as {
        to: string;
        replace?: boolean;
        search: (previous: Record<string, unknown>) => Record<string, unknown>;
      };
      return { ...options, result: options.search(router.search) };
    };
    route.open("0041-export");
    expect(rewrite()).toMatchObject({
      to: ".",
      result: { thread: "t1", increment: "0041-export" },
    });
    expect(rewrite().replace).toBeUndefined();
    route.open("0042-chart", { replace: true });
    expect(rewrite()).toMatchObject({ replace: true, result: { increment: "0042-chart" } });
    route.open(null, { replace: true });
    expect(rewrite()).toMatchObject({ replace: true });
    expect(rewrite().result).toEqual({ thread: "t1" });
  });
});
