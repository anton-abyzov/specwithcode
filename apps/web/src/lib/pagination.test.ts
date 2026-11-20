import { describe, expect, it } from "vite-plus/test";

import { pageOfIndex, paginate } from "./pagination";

const numbers = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe("paginate", () => {
  it("slices the page and reports the range against the whole list", () => {
    const page = paginate(numbers(53), 2, 20);
    expect(page.items).toEqual(numbers(40).slice(20));
    expect(page).toMatchObject({ page: 2, pageCount: 3, total: 53, from: 21, to: 40 });
  });

  it("shows a short last page", () => {
    expect(paginate(numbers(53), 3, 20)).toMatchObject({ from: 41, to: 53, page: 3 });
  });

  it("clamps a page past the end to the last page, never to an empty one", () => {
    const page = paginate(numbers(5), 4, 20);
    expect(page.items).toHaveLength(5);
    expect(page).toMatchObject({ page: 1, pageCount: 1, from: 1, to: 5 });
  });

  it("clamps zero, negative and non-numeric pages to the first", () => {
    for (const wanted of [0, -3, Number.NaN])
      expect(paginate(numbers(30), wanted, 10).page).toBe(1);
  });

  it("reports an empty list as one empty page", () => {
    expect(paginate([], 1, 20)).toMatchObject({ page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
  });

  it("never divides by a page size below one", () => {
    expect(paginate(numbers(3), 1, 0)).toMatchObject({ pageSize: 1, pageCount: 3 });
  });
});

describe("pageOfIndex", () => {
  it("finds the page an item sits on", () => {
    expect(pageOfIndex(0, 25)).toBe(1);
    expect(pageOfIndex(24, 25)).toBe(1);
    expect(pageOfIndex(25, 25)).toBe(2);
  });

  it("falls back to the first page for an item that is not listed", () => {
    expect(pageOfIndex(-1, 25)).toBe(1);
  });
});
