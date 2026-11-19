import { assert, it } from "@effect/vitest";
import {
  applyProjectContextLineDiff,
  projectContextLineDiff,
} from "./ProjectContextLineDiff.ts";

const roundTrip = (previous: string, next: string) => {
  const diff = projectContextLineDiff(previous, next);
  assert.equal(applyProjectContextLineDiff(previous, diff), next);
  return diff;
};

it("is empty for equal text and sends only the changed line of a long index", () => {
  const index = Array.from({ length: 200 }, (_, n) => `- [Fact ${n}](fact-${n}.md) - detail ${n}`);
  const previous = index.join("\n");
  assert.equal(projectContextLineDiff(previous, previous), "");
  const next = [...index.slice(0, 120), "- [Fact 120](fact-120.md) - corrected", ...index.slice(121)];
  const diff = roundTrip(previous, next.join("\n"));
  assert.equal(
    diff,
    "@@ -121,1 +121,1 @@\n-- [Fact 120](fact-120.md) - detail 120\n+- [Fact 120](fact-120.md) - corrected",
  );
});

it("round-trips insertions, deletions, moves and edge lines", () => {
  const cases: Array<[string, string]> = [
    ["", "one"],
    ["one", ""],
    ["a\nb\nc", "x\na\nb\nc"],
    ["a\nb\nc", "a\nb\nc\nx"],
    ["a\nb\nc\nd", "a\nd"],
    ["a\nb\nc\nd", "d\nc\nb\na"],
    ["a\n\nb\n", "a\nb\n\n"],
    ["same\nline\nsame\nline", "line\nsame\nline\nsame\nnew"],
  ];
  for (const [previous, next] of cases) roundTrip(previous, next);
});

it("round-trips random edits", () => {
  let seed = 7;
  const random = (limit: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  for (let trial = 0; trial < 300; trial++) {
    const previous = Array.from({ length: random(30) }, () => `line ${random(8)}`);
    const next = [...previous];
    for (let edit = random(6); edit > 0; edit--) {
      const at = random(next.length + 1);
      if (random(2) === 0) next.splice(at, 1);
      else next.splice(at, 0, `new ${random(8)}`);
    }
    roundTrip(previous.join("\n"), next.join("\n"));
  }
});

it("refuses a diff that does not fit the previous text", () => {
  const diff = projectContextLineDiff("a\nb", "a\nc");
  assert.throws(() => applyProjectContextLineDiff("a\nz", diff));
});
