import { describe, expect, it } from "vite-plus/test";

import { isLinuxDesktopName, withLinuxDesktopName } from "./LinuxWindowIdentity.ts";

const PAGE = "specwithcode-app-0123456789abcdef0123456789abcdef.desktop";

describe("withLinuxDesktopName", () => {
  it("constructs with the given entry and puts the app's own back", () => {
    const env: NodeJS.ProcessEnv = { CHROME_DESKTOP: "com.specweave.SpecWeaveStudio.desktop" };
    const seen = withLinuxDesktopName(PAGE, () => env.CHROME_DESKTOP, env);
    expect(seen).toBe(PAGE);
    expect(env.CHROME_DESKTOP).toBe("com.specweave.SpecWeaveStudio.desktop");
  });

  it("puts the app's own back when construction throws", () => {
    const env: NodeJS.ProcessEnv = { CHROME_DESKTOP: "com.specweave.SpecWeaveStudio.desktop" };
    expect(() =>
      withLinuxDesktopName(
        PAGE,
        () => {
          throw new Error("no window");
        },
        env,
      ),
    ).toThrow("no window");
    expect(env.CHROME_DESKTOP).toBe("com.specweave.SpecWeaveStudio.desktop");
  });

  it("leaves the variable unset when it was unset", () => {
    const env: NodeJS.ProcessEnv = {};
    withLinuxDesktopName(PAGE, () => undefined, env);
    expect("CHROME_DESKTOP" in env).toBe(false);
  });

  it("refuses a name that is not a desktop entry file name", () => {
    const env: NodeJS.ProcessEnv = { CHROME_DESKTOP: "app.desktop" };
    let constructed = false;
    for (const name of ["", "page", "../x.desktop", "a b.desktop", "x.desktop\n"]) {
      expect(isLinuxDesktopName(name)).toBe(false);
      expect(() =>
        withLinuxDesktopName(
          name,
          () => {
            constructed = true;
          },
          env,
        ),
      ).toThrow("Invalid desktop entry name.");
    }
    expect(constructed).toBe(false);
    expect(env.CHROME_DESKTOP).toBe("app.desktop");
  });
});
