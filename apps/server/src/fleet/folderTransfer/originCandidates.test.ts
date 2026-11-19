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

  it("tries HTTPS for the standard SSH port only", () => {
    expect(originCandidates("ssh://git@github.com:22/acme/app.git")).toEqual([
      "ssh://git@github.com:22/acme/app.git",
      "https://github.com/acme/app.git",
    ]);
    expect(originCandidates("ssh://git@git.example.com:2222/acme/app.git")).toEqual([
      "ssh://git@git.example.com:2222/acme/app.git",
    ]);
    expect(originCandidates("ssh://git@bitbucket.example.com:7999/proj/app.git")).toEqual([
      "ssh://git@bitbucket.example.com:7999/proj/app.git",
    ]);
  });
});
