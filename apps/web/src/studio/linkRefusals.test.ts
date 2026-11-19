import { afterEach, describe, expect, it } from "vite-plus/test";

import { copyProblemWords } from "../components/studio/handoffCopyNotices";
import { de } from "../i18n/phrases/de";
import { es } from "../i18n/phrases/es";
import { fr } from "../i18n/phrases/fr";
import { ja } from "../i18n/phrases/ja";
import { ko } from "../i18n/phrases/ko";
import { pt } from "../i18n/phrases/pt";
import { ru } from "../i18n/phrases/ru";
import { zh } from "../i18n/phrases/zh";
import {
  forgetLinkRefusal,
  linkRefusal,
  rememberLinkRefusal,
  resetLinkRefusalsForTest,
} from "./linkRefusals";
import { LINK_REFUSAL_TEXT, LINK_REFUSAL_WORDS, linkReasonEnglish } from "./projectLink";

afterEach(() => resetLinkRefusalsForTest());

describe("why a copy was not linked", () => {
  const reason = { text: "Project notes differ on {machine}.", values: { machine: "rackF" } };

  it("is kept for the exact two projects, and for no other pair", () => {
    rememberLinkRefusal("laptopE:p", "rackF:q", reason);
    expect(linkRefusal("laptopE:p", "rackF:q")).toEqual(reason);
    expect(linkRefusal("laptopE:p", "rackF:other")).toBeUndefined();
    expect(linkRefusal("laptopE:other", "rackF:q")).toBeUndefined();
    expect(linkRefusal("rackF:q", "laptopE:p")).toBeUndefined();
  });

  it("is forgotten once the two are linked, whichever of them stays", () => {
    rememberLinkRefusal("laptopE:p", "rackF:q", reason);
    forgetLinkRefusal("rackF:q", "laptopE:p");
    expect(linkRefusal("laptopE:p", "rackF:q")).toBeUndefined();
  });
});

describe("reasons this window composes", () => {
  const catalogs = { de, es, fr, ja, ko, pt, ru, zh };
  const check = (repo: string, ok: boolean) => ({ repo, ok }) as never;
  const composed = [
    ...Object.values(LINK_REFUSAL_WORDS),
    "Project notes differ on {machine}.",
    "The copy's repository does not match the source.",
    copyProblemWords({ unstable: ["a.txt"], checks: [] } as never, "laptopE")!.text,
    copyProblemWords({ unstable: [], checks: [check(".", false)] }, "laptopE")!.text,
    copyProblemWords({ unstable: [], checks: [check("apps/site", false)] }, "laptopE")!.text,
    copyProblemWords(
      { unstable: [], checks: [check(".", false), check("apps/site", false)] },
      "laptopE",
    )!.text,
    "A move to another machine is not finished. Finish or cancel it, then add a machine.",
    "A copy to {machine} is not finished. Finish or cancel it, then add another machine.",
    "A copy is not finished. Finish or cancel it, then add another machine.",
    "Open the unfinished copy",
    "Finish handoff",
  ];

  it("are sentences with values, never English put together here", () => {
    expect(copyProblemWords({ unstable: ["a.txt"], checks: [] } as never, "laptopE")).toEqual({
      text: "some files changed on {source} while copying",
      values: { source: "laptopE" },
    });
    expect(copyProblemWords({ unstable: [], checks: [] } as never, "laptopE")).toBeNull();
    // The English a place not translated yet shows is the same sentence, filled in.
    expect(LINK_REFUSAL_TEXT.paused("rackF")).toBe(
      "The project on rackF is paused. Resume it first.",
    );
    expect(
      linkReasonEnglish({
        text: "Project notes differ on {machine}.",
        values: { machine: "rackF" },
      }),
    ).toBe("Project notes differ on rackF.");
  });

  it.each(Object.entries(catalogs))("are all said in %s, with their values", (_name, catalog) => {
    for (const text of composed) {
      const said = catalog[text];
      expect(said, text).toBeTruthy();
      for (const slot of text.match(/\{\w+\}/g) ?? []) expect(said, text).toContain(slot);
    }
  });
});
