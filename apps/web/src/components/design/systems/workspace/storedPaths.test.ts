import { describe, expect, it } from "vite-plus/test";

import { uniquePath } from "./storedPaths";

describe("uniquePath", () => {
  it("numbers a name taken under another case, as a Mac disk keeps only one", () => {
    const taken = new Set(["assets/Brand/logo.png", "assets/Brand/Logo 2.png"]);
    expect(uniquePath("assets/Brand/LOGO.png", taken)).toBe("assets/Brand/LOGO 3.png");
    expect(uniquePath("assets/Brand/mark.png", taken)).toBe("assets/Brand/mark.png");
  });
});
