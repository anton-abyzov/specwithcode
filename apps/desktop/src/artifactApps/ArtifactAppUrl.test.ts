import { describe, expect, it } from "vite-plus/test";

import {
  ARTIFACT_APP_ROUTE,
  ARTIFACT_APP_WINDOW_ARGUMENT,
  artifactAppLaunchUrl,
  artifactAppUserModelId,
  artifactAppWindowUrl,
  findArtifactAppLaunchInArgv,
  isArtifactAppInstallId,
  newArtifactAppInstallId,
  parseArtifactAppLaunchUrl,
} from "./ArtifactAppUrl.ts";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const SCHEME = "studio";

describe("newArtifactAppInstallId", () => {
  it("returns 32 lowercase hex characters from 16 random bytes", () => {
    const id = newArtifactAppInstallId((size) => new Uint8Array(size).fill(0xab));
    expect(id).toBe("ab".repeat(16));
    expect(isArtifactAppInstallId(newArtifactAppInstallId())).toBe(true);
  });

  it("differs between calls with the default source", () => {
    expect(newArtifactAppInstallId()).not.toBe(newArtifactAppInstallId());
  });

  it("rejects a source returning the wrong size", () => {
    expect(() => newArtifactAppInstallId(() => new Uint8Array(8))).toThrow();
  });
});

describe("isArtifactAppInstallId", () => {
  it.each([
    [ID, true],
    [ID.toUpperCase(), false],
    [ID.slice(0, 31), false],
    [`${ID}0`, false],
    [`${ID.slice(0, 31)}g`, false],
    [42, false],
    [null, false],
  ])("%s -> %s", (value, expected) => {
    expect(isArtifactAppInstallId(value)).toBe(expected);
  });
});

describe("artifactAppLaunchUrl", () => {
  it("builds the canonical URL", () => {
    expect(ARTIFACT_APP_ROUTE).toBe("artifact-app");
    expect(artifactAppLaunchUrl(SCHEME, ID)).toBe(`studio://app/artifact-app/${ID}`);
  });

  it("throws on a bad id or scheme", () => {
    expect(() => artifactAppLaunchUrl(SCHEME, ID.toUpperCase())).toThrow();
    expect(() => artifactAppLaunchUrl(SCHEME, "../etc")).toThrow();
    expect(() => artifactAppLaunchUrl("Studio", ID)).toThrow();
    expect(() => artifactAppLaunchUrl("stu'dio", ID)).toThrow();
    expect(() => artifactAppLaunchUrl("", ID)).toThrow();
  });
});

describe("parseArtifactAppLaunchUrl", () => {
  it("accepts the canonical URL and one trailing slash", () => {
    expect(parseArtifactAppLaunchUrl(`studio://app/artifact-app/${ID}`, SCHEME)).toBe(ID);
    expect(parseArtifactAppLaunchUrl(`studio://app/artifact-app/${ID}/`, SCHEME)).toBe(ID);
  });

  it.each([
    ["another scheme", `https://app/artifact-app/${ID}`],
    ["a scheme prefix", `xstudio://app/artifact-app/${ID}`],
    ["an uppercase scheme", `STUDIO://app/artifact-app/${ID}`],
    ["an uppercase host", `studio://APP/artifact-app/${ID}`],
    ["another host", `studio://evil/artifact-app/${ID}`],
    ["credentials", `studio://user@app/artifact-app/${ID}`],
    ["an at sign before the host", `studio://@app/artifact-app/${ID}`],
    ["a port", `studio://app:80/artifact-app/${ID}`],
    ["an empty port", `studio://app:/artifact-app/${ID}`],
    ["a query", `studio://app/artifact-app/${ID}?x=1`],
    ["an empty query", `studio://app/artifact-app/${ID}?`],
    ["a hash", `studio://app/artifact-app/${ID}#x`],
    ["an empty hash", `studio://app/artifact-app/${ID}#`],
    ["extra path", `studio://app/artifact-app/${ID}/more`],
    ["two trailing slashes", `studio://app/artifact-app/${ID}//`],
    ["a leading path", `studio://app/x/artifact-app/${ID}`],
    ["dot segments", `studio://app/artifact-app/../artifact-app/${ID}`],
    ["an encoded id", `studio://app/artifact-app/%30${ID.slice(1)}`],
    ["uppercase hex", `studio://app/artifact-app/${ID.toUpperCase()}`],
    ["31 characters", `studio://app/artifact-app/${ID.slice(0, 31)}`],
    ["33 characters", `studio://app/artifact-app/${ID}0`],
    ["a tab", `studio://app/artifact-app/\t${ID}`],
    ["a newline", `studio://app/artifact-app/${ID}\n`],
    ["leading space", ` studio://app/artifact-app/${ID}`],
    ["a single slash", `studio:/app/artifact-app/${ID}`],
    ["a route variant", `studio://app/Artifact-App/${ID}`],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseArtifactAppLaunchUrl(value, SCHEME)).toBeNull();
  });

  it("never throws on odd input", () => {
    expect(parseArtifactAppLaunchUrl(undefined as unknown as string, SCHEME)).toBeNull();
    expect(parseArtifactAppLaunchUrl(`studio://app/artifact-app/${ID}`, "bad scheme")).toBeNull();
  });
});

describe("findArtifactAppLaunchInArgv", () => {
  it("finds the first well-formed launch URL", () => {
    const argv = [
      "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode",
      "--flag",
      `studio://app/artifact-app/${ID.toUpperCase()}`,
      `--studio-artifact-app=${OTHER_ID}`,
      `https://app/artifact-app/${OTHER_ID}`,
      `studio://app/artifact-app/${ID}`,
      `studio://app/artifact-app/${OTHER_ID}`,
    ];
    expect(findArtifactAppLaunchInArgv(argv, SCHEME)).toBe(ID);
  });

  it("returns null when no argument is a launch URL", () => {
    expect(
      findArtifactAppLaunchInArgv(
        ["electron", `studio://app/artifact-app/${ID}?q`, `studio://app/artifact-app/${ID}/x`],
        SCHEME,
      ),
    ).toBeNull();
    expect(findArtifactAppLaunchInArgv([], SCHEME)).toBeNull();
  });
});

describe("artifactAppWindowUrl", () => {
  it("names the renderer argument for the install", () => {
    expect(ARTIFACT_APP_WINDOW_ARGUMENT).toBe("--studio-artifact-app=");
  });

  it("adds the hash route to the packaged URL", () => {
    expect(artifactAppWindowUrl("studio://app/", ID)).toBe(`studio://app/#/artifact-app/${ID}`);
  });

  it("handles a dev server URL without a trailing slash and drops an old hash", () => {
    expect(artifactAppWindowUrl("http://localhost:5733", ID)).toBe(
      `http://localhost:5733/#/artifact-app/${ID}`,
    );
    expect(artifactAppWindowUrl("http://localhost:5733/#/old", ID)).toBe(
      `http://localhost:5733/#/artifact-app/${ID}`,
    );
  });

  it("throws on a bad id", () => {
    expect(() => artifactAppWindowUrl("studio://app/", "nope")).toThrow();
  });
});

describe("artifactAppUserModelId", () => {
  it("appends the install id to the base", () => {
    expect(artifactAppUserModelId("com.specweave.studio", ID)).toBe(
      `com.specweave.studio.artifactapp.${ID}`,
    );
  });

  it("cuts the base, never the install id, to stay within 128 characters", () => {
    const base = "x".repeat(120);
    const first = artifactAppUserModelId(base, ID);
    const second = artifactAppUserModelId(base, OTHER_ID);
    expect(first).toHaveLength(128);
    expect(first.endsWith(`.artifactapp.${ID}`)).toBe(true);
    expect(second.endsWith(`.artifactapp.${OTHER_ID}`)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("throws on a bad id", () => {
    expect(() => artifactAppUserModelId("com.specweave.studio", "x")).toThrow();
  });
});
