import { describe, expect, it } from "vite-plus/test";

import { maskEmail } from "./maskEmail.ts";

describe("maskEmail", () => {
  it("keeps two letters at each end of a long name and the whole domain", () => {
    expect(maskEmail("antonabyzov@gmail.com")).toBe("an••••ov@gmail.com");
    expect(maskEmail("marketing@easychamp.com")).toBe("ma••••ng@easychamp.com");
  });

  it("shows one character of a 1 or 2 character name", () => {
    expect(maskEmail("a@gmail.com")).toBe("a••••@gmail.com");
    expect(maskEmail("an@gmail.com")).toBe("a••••@gmail.com");
  });

  it("shows the first and last character of a 3 to 5 character name", () => {
    expect(maskEmail("bob@gmail.com")).toBe("b••••b@gmail.com");
    expect(maskEmail("anton@gmail.com")).toBe("a••••n@gmail.com");
    expect(maskEmail("abcdef@gmail.com")).toBe("ab••••ef@gmail.com");
  });

  it("uses the same mask whatever the name's length", () => {
    expect(maskEmail("abcdefghijklmnopqrstuvwxyz@x.io")).toBe("ab••••yz@x.io");
  });

  it("masks a plus tag with the name", () => {
    expect(maskEmail("anton+work@gmail.com")).toBe("an••••rk@gmail.com");
    expect(maskEmail("a+b@gmail.com")).toBe("a••••b@gmail.com");
  });

  it("keeps subdomains and a mixed-case domain as they are", () => {
    expect(maskEmail("jane.doe@mail.eng.example.co.uk")).toBe("ja••••oe@mail.eng.example.co.uk");
    expect(maskEmail("Jane@Example.COM")).toBe("J••••e@Example.COM");
  });

  it("trims surrounding space", () => {
    expect(maskEmail("  antonabyzov@gmail.com \n")).toBe("an••••ov@gmail.com");
  });

  it("splits on the last @ of a quoted name", () => {
    expect(maskEmail('"a@b"@example.com')).toBe('"••••"@example.com');
  });

  it("counts characters, not UTF-16 units", () => {
    expect(maskEmail("😀ab@x.io")).toBe("😀••••b@x.io");
  });

  it("returns null for anything that is not an email", () => {
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
    expect(maskEmail("   ")).toBeNull();
    expect(maskEmail("octocat")).toBeNull();
    expect(maskEmail("@gmail.com")).toBeNull();
    expect(maskEmail("anton@")).toBeNull();
    expect(maskEmail("anton abyzov@gmail.com")).toBeNull();
  });
});
