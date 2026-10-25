// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import {
  ROW_MODEL_FITS,
  measureRowModelFitWidths,
  rowModelRoom,
  rowModelShows,
  type RowModelPart,
} from "./rowModelFit";

function sized<T extends HTMLElement>(element: T, width: number, left = 0): T {
  element.getBoundingClientRect = () =>
    ({ width, left, right: left + width, top: 0, bottom: 18, height: 18 }) as DOMRect;
  Object.defineProperty(element, "scrollWidth", { value: width, configurable: true });
  Object.defineProperty(element, "clientWidth", { value: width, configurable: true });
  return element;
}

function part(name: RowModelPart, width: number) {
  const span = sized(document.createElement("span"), width);
  span.dataset.rowPart = name;
  return span;
}

describe("rowModelShows", () => {
  it("gives up the provider word and nothing else", () => {
    expect(ROW_MODEL_FITS.filter((fit) => rowModelShows(fit, "provider"))).toEqual(["full"]);
  });
});

describe("measureRowModelFitWidths", () => {
  it("costs the provider word its natural width and one gap of the row it sits in", () => {
    const badge = sized(document.createElement("span"), 200);
    badge.style.columnGap = "5px";
    badge.style.display = "inline-flex";
    badge.append(part("provider", 40), sized(document.createElement("span"), 60));
    expect(measureRowModelFitWidths(badge)).toEqual({ full: 200, model: 155 });
  });

  it("measures what the line squeezed at its natural width", () => {
    // The line squeezed the unit to 120: the running name shows 40 of its 70, and 20
    // more overflow the unit's clipped box. Read as rendered, `full` (the fit that
    // squeezed it) would always seem to fit.
    const badge = sized(document.createElement("span"), 120);
    Object.defineProperty(badge, "scrollWidth", { value: 140 });
    badge.style.columnGap = "5px";
    badge.style.display = "inline-flex";
    const name = sized(document.createElement("span"), 40);
    name.className = "sws-model-name";
    Object.defineProperty(name, "scrollWidth", { value: 70 });
    badge.append(part("provider", 30), name);
    // In flow: the provider word (30 + 5), so 85 always shows, plus the 20 clipped and
    // the name's hidden 30.
    expect(measureRowModelFitWidths(badge)).toEqual({ full: 170, model: 135 });
  });

  it("measures nothing for a unit with no optional parts", () => {
    expect(measureRowModelFitWidths(sized(document.createElement("span"), 90))).toBeNull();
  });
});

describe("rowModelRoom", () => {
  it("leaves the line's plan and PR their room, but not the machine name", () => {
    const host = sized(document.createElement("div"), 300);
    const lead = document.createElement("span");
    const badge = sized(document.createElement("span"), 120, 100);
    lead.append(badge);
    const rest = document.createElement("span");
    rest.style.display = "flex";
    rest.style.flexWrap = "wrap";
    const machine = sized(document.createElement("span"), 90);
    machine.className = "sws-thread-machine";
    rest.append(
      sized(document.createElement("span"), 60),
      sized(document.createElement("span"), 45),
      machine,
    );
    host.append(lead, rest);
    document.body.append(host);
    // 300 wide, the unit starts at 100, and the plan (60) and PR (45) follow it.
    expect(rowModelRoom(badge, host)).toBe(95);
    host.remove();
  });
});

describe("rowModelRoom with a hover action", () => {
  const line = (chips: number[]) => {
    const host = sized(document.createElement("div"), 300);
    host.style.setProperty("--sws-row-action-reserve", "48px");
    const badge = sized(document.createElement("span"), 120, 100);
    host.append(badge, ...chips.map((width) => sized(document.createElement("span"), width)));
    document.body.append(host);
    return { host, badge };
  };

  it("keeps the action's room clear when nothing follows the unit", () => {
    const { host, badge } = line([]);
    expect(rowModelRoom(badge, host)).toBe(152);
    host.remove();
  });

  it("counts the chips instead when they ask for more than the action", () => {
    const { host, badge } = line([60]);
    expect(rowModelRoom(badge, host)).toBe(140);
    host.remove();
  });
});

describe("rowModelRoom on a wrapping line", () => {
  // The thread header's chips: the unit and each chip are items of one wrapping line.
  const header = (chips: number[]) => {
    const host = sized(document.createElement("div"), 220);
    host.style.display = "flex";
    host.style.flexWrap = "wrap";
    host.style.columnGap = "4px";
    const badge = sized(document.createElement("span"), 131);
    host.append(badge, ...chips.map((width) => sized(document.createElement("span"), width)));
    document.body.append(host);
    return { host, badge };
  };

  it("leaves no room for chips that wrap away even beside the leanest fit", () => {
    // Beside the 131 px `model` fit, the 100 px routing chip does not fit in 220, so it
    // wraps away and takes the PR with it: the whole line is the unit's.
    const { host, badge } = header([100, 50]);
    expect(rowModelRoom(badge, host, 131)).toBe(220);
    host.remove();
  });

  it("keeps the room for the chips that stay on the line", () => {
    // The 50 px PR fits beside the `model` fit; the 100 px chip after it does not.
    const { host, badge } = header([50, 100]);
    expect(rowModelRoom(badge, host, 131)).toBe(166);
    host.remove();
  });

  it("counts every chip when the leanest fit is unknown", () => {
    const { host, badge } = header([50, 100]);
    expect(rowModelRoom(badge, host)).toBe(62);
    host.remove();
  });
});
