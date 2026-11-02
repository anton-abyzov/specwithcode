import { describe, expect, it } from "vite-plus/test";

import { secretFileEntries, secretFileEntryProblem } from "./ProjectSecretFilesSettings";

describe("Secret files entries", () => {
  it("reads one entry per line, trimmed and without repeats", () => {
    expect(secretFileEntries(" a.json \n\nconfig/keys/\na.json\n~/.config/x.json")).toEqual([
      "a.json",
      "config/keys/",
      "~/.config/x.json",
    ]);
  });

  it("accepts folder and home entries and explains the ones it cannot use", () => {
    expect(secretFileEntryProblem("/deploy/token.txt")).toBeNull();
    expect(secretFileEntryProblem("~/.config/acme/token.json")).toBeNull();
    expect(secretFileEntryProblem("C:\\keys\\a.pem")).toMatch(/inside the project folder/);
    expect(secretFileEntryProblem("~other/a.pem")).toMatch(/inside the project folder/);
    expect(secretFileEntryProblem("../outside.txt")).toMatch(/cannot leave/);
    expect(secretFileEntryProblem("x".repeat(600))).toMatch(/under 512/);
  });
});
