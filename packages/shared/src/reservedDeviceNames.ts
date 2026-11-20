/**
 * Words the device lists use for the owner and the update. A device may never take one as its
 * own name, however it spells it: extra spaces, punctuation, accents, full-width or Cyrillic and
 * Greek look-alike letters all fold to the same skeleton (1327).
 */
const RESERVED_SKELETONS = ["thismachine", "theupdate", "anotherdevice"] as const;

const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  с: "c",
  ԁ: "d",
  е: "e",
  ё: "e",
  һ: "h",
  н: "h",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  ӏ: "l",
  м: "m",
  о: "o",
  р: "p",
  ԛ: "q",
  ѕ: "s",
  т: "t",
  у: "y",
  ԝ: "w",
  х: "x",
  α: "a",
  β: "b",
  ε: "e",
  η: "h",
  ι: "i",
  κ: "k",
  μ: "m",
  ν: "n",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "y",
  χ: "x",
  ı: "i",
  ł: "l",
  ø: "o",
  "0": "o",
  "1": "l",
  "3": "e",
};

const skeleton = (name: string): string =>
  Array.from(
    name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase(),
    (char) => LOOK_ALIKES[char] ?? char,
  )
    .join("")
    .replace(/[^a-z]/g, "");

/** Whether a self-reported device name spells one of the lists' own words. */
export const isReservedDeviceName = (name: string): boolean => {
  const folded = skeleton(name);
  return RESERVED_SKELETONS.some((reserved) => folded.includes(reserved));
};
