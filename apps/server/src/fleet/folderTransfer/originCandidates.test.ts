import { describe, expect, it } from "vite-plus/test";

import { originCandidates } from "./git.ts";

describe("origin candidates", () => {
  it("tries HTTPS after an SSH address and keeps other addresses as they are", () => {
    expect(originCandidates("git@github.com:acme/app.git")).toEqual([
      "git@github.com:acme/app.git",
      "https://github.com/acme/app.git",
    ]);
    expect(originCandidates("ssh://git@github.com/acme/app")).toEqual([
      "ssh://git@github.com/acme/app",
      "https://github.com/acme/app.git",
    ]);
    expect(originCandidates("https://github.com/acme/app.git")).toEqual([
      "https://github.com/acme/app.git",
    ]);
    expect(originCandidates("/srv/git/app.git")).toEqual(["/srv/git/app.git"]);
  });
});
