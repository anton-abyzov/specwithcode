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
  const reason = { text: "Project notes differ on {machine}.", values: { machine: "m5" } };

  it("is kept for the exact two projects, and for no other pair", () => {
    rememberLinkRefusal("m4:p", "m5:q", reason);
    expect(linkRefusal("m4:p", "m5:q")).toEqual(reason);
    expect(linkRefusal("m4:p", "m5:other")).toBeUndefined();
    expect(linkRefusal("m4:other", "m5:q")).toBeUndefined();
    expect(linkRefusal("m5:q", "m4:p")).toBeUndefined();
  });

  it("is forgotten once the two are linked, whichever of them stays", () => {
    rememberLinkRefusal("m4:p", "m5:q", reason);
    forgetLinkRefusal("m5:q", "m4:p");
    expect(linkRefusal("m4:p", "m5:q")).toBeUndefined();
  });
});

describe("reasons this window composes", () => {
  const catalogs = { de, es, fr, ja, ko, pt, ru, zh };
  const check = (repo: string, ok: boolean) => ({ repo, ok }) as never;
  const composed = [
    ...Object.values(LINK_REFUSAL_WORDS),
    "Project notes differ on {machine}.",
    "The copy's repository does not match the source.",
    copyProblemWords({ unstable: ["a.txt"], checks: [] } as never, "m4")!.text,
    copyProblemWords({ unstable: [], checks: [check(".", false)] }, "m4")!.text,
    copyProblemWords({ unstable: [], checks: [check("apps/site", false)] }, "m4")!.text,
    copyProblemWords(
      { unstable: [], checks: [check(".", false), check("apps/site", false)] },
      "m4",
    )!.text,
    "A move to another machine is not finished. Finish or cancel it, then add a machine.",
  ];

  it("are sentences with values, never English put together here", () => {
    expect(copyProblemWords({ unstable: ["a.txt"], checks: [] } as never, "m4")).toEqual({
      text: "some files changed on {source} while copying",
      values: { source: "m4" },
    });
    expect(copyProblemWords({ unstable: [], checks: [] } as never, "m4")).toBeNull();
    // The English a place not translated yet shows is the same sentence, filled in.
    expect(LINK_REFUSAL_TEXT.paused("m5")).toBe("The project on m5 is paused. Resume it first.");
    expect(
      linkReasonEnglish({ text: "Project notes differ on {machine}.", values: { machine: "m5" } }),
    ).toBe("Project notes differ on m5.");
  });

  it.each(Object.entries(catalogs))("are all said in %s, with their values", (_name, catalog) => {
    for (const text of composed) {
      const said = catalog[text];
      expect(said, text).toBeTruthy();
      for (const slot of text.match(/\{\w+\}/g) ?? []) expect(said, text).toContain(slot);
    }
  });
});
