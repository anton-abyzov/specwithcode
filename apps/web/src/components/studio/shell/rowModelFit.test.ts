// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import {
  HEADER_MODEL_FITS,
  ROW_MODEL_FITS,
  decideRowModelFit,
  headerFloorRoom,
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
    expect(ROW_MODEL_FITS.every((fit) => rowModelShows(fit, "name"))).toBe(true);
  });

  it("lets the header's chip leave its name out last", () => {
    expect(HEADER_MODEL_FITS.filter((fit) => rowModelShows(fit, "name"))).toEqual([
      "full",
      "model",
      "name",
    ]);
  });
});

describe("measureRowModelFitWidths", () => {
  it("costs the provider word its natural width and one gap of the row it sits in", () => {
    const badge = sized(document.createElement("span"), 200);
    badge.style.columnGap = "5px";
    badge.style.display = "inline-flex";
    badge.append(part("provider", 40), sized(document.createElement("span"), 60));
    expect(measureRowModelFitWidths(badge)).toEqual({
      full: 200,
      model: 155,
      name: 155,
      mark: 155,
    });
  });

  it("counts a long name's first 3 em at `name` and none of it at `mark`", () => {
    const badge = sized(document.createElement("span"), 200);
    badge.style.columnGap = "5px";
    badge.style.display = "inline-flex";
    badge.style.fontSize = "12px";
    const name = part("name", 100);
    name.style.fontSize = "12px";
    badge.append(part("provider", 40), name);
    // 200 rendered, less the provider (40 + 5) and the name (100 + 5): 50 always shows.
    expect(measureRowModelFitWidths(badge)).toEqual({
      full: 200,
      model: 155,
      name: 50 + 36 + 5,
      mark: 50,
    });
  });

  it("keeps a short name whole at `name`", () => {
    const badge = sized(document.createElement("span"), 100);
    badge.style.columnGap = "5px";
    badge.style.display = "inline-flex";
    const name = part("name", 60);
    name.style.fontSize = "12px";
    badge.append(name);
    // 60 is under twice 3 em, so its first characters would not tell the model apart.
    expect(measureRowModelFitWidths(badge)).toEqual({ full: 100, model: 100, name: 100, mark: 35 });
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
    expect(measureRowModelFitWidths(badge)).toEqual({
      full: 170,
      model: 135,
      name: 135,
      mark: 135,
    });
  });

  it("measures nothing for a unit with no optional parts", () => {
    expect(measureRowModelFitWidths(sized(document.createElement("span"), 90))).toBeNull();
  });
});

describe("rowModelRoom", () => {
  it("leaves the line's plan and PR their room, but not a long error", () => {
    const host = sized(document.createElement("div"), 300);
    const lead = document.createElement("span");
    const badge = sized(document.createElement("span"), 120, 100);
    lead.append(badge);
    const rest = document.createElement("span");
    rest.style.display = "flex";
    rest.style.flexWrap = "wrap";
    const machine = sized(document.createElement("span"), 90);
    machine.className = "sws-thread-error";
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

describe("decideRowModelFit", () => {
  // A chips line (the size container) in the header's title row: title, line, subagents.
  const line = (header: boolean, chips: number[] = [], text = 300, width = 200) => {
    const row = sized(document.createElement("div"), text);
    row.style.display = "flex";
    row.style.columnGap = "8px";
    const title = sized(document.createElement("h2"), 0);
    title.style.flexShrink = "1";
    title.style.minWidth = "0px";
    title.style.fontSize = "13px";
    Object.defineProperty(title, "scrollWidth", { value: 350, configurable: true });
    const host = sized(document.createElement("span"), width);
    host.style.containerType = "inline-size";
    host.style.display = "flex";
    host.style.flexWrap = "wrap";
    host.style.columnGap = "4px";
    const subagents = sized(document.createElement("button"), 49);
    subagents.style.flexShrink = "0";
    // The unit: provider word 40, name 60 (3 em 36), always 34 (mark, glyph, padding), so
    // full 144, model 99, name 75 and mark 34.
    const badge = sized(document.createElement("span"), 34 + 40 + 60 + 10);
    badge.style.display = "inline-flex";
    badge.style.columnGap = "5px";
    badge.style.fontSize = "12px";
    if (header) badge.dataset.rowLine = "header";
    const name = part("name", 60);
    if (!header) delete name.dataset.rowPart;
    badge.append(part("provider", 40), name);
    host.append(badge, ...chips.map((width) => sized(document.createElement("span"), width)));
    row.append(title, host, subagents);
    document.body.append(row);
    return { row, host, badge };
  };

  it("gives a row only the row fits, and no floor", () => {
    // 60 px holds no fit with a name; a row still keeps its name, the header leaves it out.
    const rowLine = line(false, [], 300, 60);
    const decision = decideRowModelFit(rowLine.badge, null);
    expect(decision).toEqual({ fit: "model", floor: null });
    rowLine.row.remove();
    const headerLine = line(true, [], 300, 60);
    expect(decideRowModelFit(headerLine.badge, null)?.fit).toBe("mark");
    headerLine.row.remove();
  });

  it("keeps the header's line at least as wide as its leanest chip", () => {
    const { row, badge } = line(true);
    expect(decideRowModelFit(badge, null)?.floor).toBe(34);
    row.remove();
  });

  it("never lets the floor take the title's first 3 em", () => {
    // 100 px of row, less the 49 px subagents chip, two 8 px gaps and 39 px of title.
    const { row, host, badge } = line(true, [], 100);
    expect(headerFloorRoom(host)).toBe(100 - 49 - 16 - 39);
    expect(decideRowModelFit(badge, null)?.floor).toBe(0);
    row.remove();
  });

  it("wraps the chips after the chip away before its name gives way", () => {
    // Beside the whole name (99 px at `model`), a 70 px PR chip does not fit in 150, so it
    // leaves the line and the chip shows in full, instead of keeping the PR beside a
    // trimmed name.
    const { row, badge } = line(true, [70], 300, 150);
    expect(decideRowModelFit(badge, null)?.fit).toBe("full");
    row.remove();
  });
});
