import { describe, expect, it } from "vite-plus/test";
import {
  ByteTail,
  cleanLogLine,
  parseGitHubActionsJobUrl,
  scrubLogSecrets,
  trimFailureLog,
} from "./gitHubCheckFailureLog.ts";

const repo = { host: "github.com", repository: "acme/web" };

describe("parseGitHubActionsJobUrl", () => {
  it("reads the run and job from an Actions job URL", () => {
    expect(
      parseGitHubActionsJobUrl("https://github.com/acme/web/actions/runs/123/job/456", repo),
    ).toEqual({ runId: "123", jobId: "456" });
    expect(
      parseGitHubActionsJobUrl(
        "https://github.com/Acme/Web/actions/runs/123/jobs/456?pr=7#step:4:12",
        repo,
      ),
    ).toEqual({ runId: "123", jobId: "456" });
  });

  it("reads the job from a check-run URL", () => {
    expect(parseGitHubActionsJobUrl("https://github.com/acme/web/runs/789", repo)).toEqual({
      runId: null,
      jobId: "789",
    });
  });

  it("refuses URLs that are not an Actions job of this repository on this host", () => {
    for (const url of [
      "https://ci.example.com/acme/web/runs/1",
      "https://github.com/other/web/actions/runs/1/job/2",
      "https://github.com/acme/web/actions/runs/1",
      "https://github.com/acme/web/actions/runs/abc/job/2",
      "https://github.com/acme/web/pull/7/checks",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(parseGitHubActionsJobUrl(url, repo)).toBeNull();
    }
  });

  it("matches an Enterprise host", () => {
    expect(
      parseGitHubActionsJobUrl("https://git.corp.dev/acme/web/actions/runs/1/job/2", {
        host: "git.corp.dev",
        repository: "acme/web",
      }),
    ).toEqual({ runId: "1", jobId: "2" });
  });
});

describe("cleanLogLine", () => {
  it("drops gh's job and step columns, the runner timestamp and colour codes", () => {
    expect(
      cleanLogLine(
        "test\tRun tests\t﻿2026-10-15T12:34:56.1234567Z \u001b[31mFAIL\u001b[0m src/a.test.ts\r",
      ),
    ).toBe("FAIL src/a.test.ts");
  });

  it("leaves a plain line alone", () => {
    expect(cleanLogLine("error TS2322: nope")).toBe("error TS2322: nope");
  });
});

describe("trimFailureLog", () => {
  it("keeps a short log whole", () => {
    expect(
      trimFailureLog("job\tstep\t2026-10-15T00:00:00Z a\njob\tstep\t2026-10-15T00:00:00Z b\n"),
    ).toEqual({
      log: "a\nb",
      truncated: false,
    });
  });

  it("keeps the last lines and says it cut", () => {
    const raw = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
    expect(trimFailureLog(raw, { maxLines: 3 })).toEqual({
      log: "line 7\nline 8\nline 9",
      truncated: true,
    });
  });

  it("caps the byte size from the end on a line boundary", () => {
    const raw = Array.from({ length: 50 }, (_, index) => `${"x".repeat(20)} ${index}`).join("\n");
    const result = trimFailureLog(raw, { maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.log ?? "").byteLength).toBeLessThanOrEqual(100);
    expect(result.log?.endsWith(" 49")).toBe(true);
    expect(result.log?.split("\n")[0]).toMatch(/^x{20} \d+$/);
  });

  it("answers null for an empty log and carries an upstream cut", () => {
    expect(trimFailureLog("\n  \n")).toEqual({ log: null, truncated: false });
    expect(trimFailureLog("tail", { alreadyTruncated: true })).toEqual({
      log: "tail",
      truncated: true,
    });
  });

  it("scrubs credentials, including the exact token used", () => {
    const token = "plain-token-value-1234";
    const result = trimFailureLog(
      [
        `using ${token}`,
        `auth ${"ghp"}_abcdefghijklmnopqrstuvwxyz0123`,
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "password=hunter22",
        "clone https://user:s3cret@github.com/acme/web",
      ].join("\n"),
      { knownSecrets: [token] },
    );
    expect(result.log).not.toContain(token);
    expect(result.log).not.toContain("ghp_abc");
    expect(result.log).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.log).not.toContain("hunter22");
    expect(result.log).not.toContain("s3cret");
  });
});

describe("scrubLogSecrets", () => {
  it.each([
    "Authorization=Bearer\n--token abcdefghijklmnopqrstuvwxyz",
    "Authorization=Bearer\nBasic abcdefghijklmnopqrstuvwxyz",
    "password=Bearer token abcdefghijklmnopqrstuvwxyz",
    "token=--auth-token abcdefghijklmnopqrstuvwxyz",
    "token=x-auth-token abcdefghijklmnopqrstuvwxyz",
  ])("preserves overlapping credential markers until their values are scrubbed: %s", (text) => {
    expect(scrubLogSecrets(text)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    if (text.includes("\n")) expect(scrubLogSecrets(text)).toContain("\n");
  });

  it.each(['"prefix private-suffix"', "'prefix private-suffix'"])(
    "scrubs a quoted scheme value %s",
    (value) => {
      expect(scrubLogSecrets(`token=Bearer ${value}`)).toBe("token=[redacted]");
    },
  );

  it.each(["fixture-value&suffix", "fixture-value#suffix", "fixture-value%26suffix"])(
    "scrubs a whole plain scheme credential containing %s",
    (value) => {
      expect(scrubLogSecrets(`token=Bearer ${value}`)).toBe("token=[redacted]");
    },
  );

  it.each([
    ["?token=Bearer fixture-value%26suffix", "?token=[redacted]"],
    ["?token=Bearer fixture-value&branch=develop", "?token=[redacted]&branch=develop"],
    ["?token=Bearer fixture-value#failure", "?token=[redacted]#failure"],
  ])("scrubs a query scheme value and preserves context in %s", (text, expected) => {
    expect(scrubLogSecrets(text)).toBe(expected);
  });

  it.each(["--token", "--auth-token", "--access-token"])(
    "keeps scrubbing whitespace-separated CLI flag %s",
    (flag) => {
      expect(scrubLogSecrets(`command ${flag} abcdefghijklmnopqrstuvwxyz`)).toBe(
        `command ${flag} [redacted]`,
      );
    },
  );

  it.each(["?token=&branch=develop", "?token=#failure", "?token=\nOperation: git"])(
    "preserves context after an empty query value in %s",
    (text) => {
      expect(scrubLogSecrets(text)).toBe(text);
    },
  );

  it.each(["Authorization: Bearer", "Authorization=Bearer", "token=Bearer", "?token=Bearer"])(
    "scrubs complete scheme credentials after %s",
    (prefix) => {
      expect(scrubLogSecrets(`${prefix} abcdefghijklmnopqrstuvwxyz`)).not.toContain(
        "abcdefghijklmnopqrstuvwxyz",
      );
    },
  );

  it.each([
    '"prefix private-suffix"',
    "'prefix private-suffix'",
    '"prefix&private-suffix"',
    "'prefix#private-suffix'",
  ])("scrubs the complete quoted query secret %s", (secret) => {
    expect(scrubLogSecrets(`https://example.invalid/?password=${secret}&branch=develop`)).toBe(
      "https://example.invalid/?password=[redacted]&branch=develop",
    );
  });

  it.each(["prefix'private-suffix", 'prefix"private-suffix', "prefix<private-suffix"])(
    "scrubs a whole query secret containing %s",
    (secret) => {
      const text = `https://example.invalid/?password=${secret}&branch=develop`;
      expect(scrubLogSecrets(text)).toBe(
        "https://example.invalid/?password=[redacted]&branch=develop",
      );
    },
  );

  it.each([
    ["?token=fixture-query-token", "?token=[redacted]"],
    ["?token=fixture-query-token&branch=develop", "?token=[redacted]&branch=develop"],
    [
      "?branch=develop&token=fixture-query-token&retry=2",
      "?branch=develop&token=[redacted]&retry=2",
    ],
    [
      "?branch=develop&TOKEN=fixture-query-token#failure",
      "?branch=develop&TOKEN=[redacted]#failure",
    ],
    [
      "?token=one%26two&mode=raw&password=three#failure",
      "?token=[redacted]&mode=raw&password=[redacted]#failure",
    ],
  ])("scrubs a bare query token in %s without losing diagnostic context", (query, expected) => {
    const context = " diagnostic-context END-OF-FULL-DIAGNOSTIC";
    expect(scrubLogSecrets(`https://example.invalid/repo${query}${context}`)).toBe(
      `https://example.invalid/repo${expected}${context}`,
    );
  });

  it.each([
    "token=fixture-query-token",
    'token: "fixture-query-token"',
    "TOKEN='fixture-query-token'",
  ])("scrubs a bare token assignment in %s", (assignment) => {
    expect(scrubLogSecrets(`${assignment}; diagnostic-context`)).not.toContain(
      "fixture-query-token",
    );
    expect(scrubLogSecrets(`${assignment}; diagnostic-context`)).toContain("; diagnostic-context");
  });

  it.each(["token=one&two", "token=one#two", "password=one&two", "password=one#two"])(
    "redacts the entire plain assignment %s",
    (assignment) => {
      expect(scrubLogSecrets(assignment)).toBe(`${assignment.split("=")[0]}=[redacted]`);
    },
  );

  it("preserves token-like words and non-secret query fields", () => {
    const text = "?token_type=Bearer&token= fixture-secret-token diagnosticcontextthatshouldstay";
    expect(scrubLogSecrets("?token_type=Bearer&token=")).toBe("?token_type=Bearer&token=");
    expect(scrubLogSecrets(text)).not.toContain("fixture-secret-token");
    expect(scrubLogSecrets(text)).toContain("diagnosticcontextthatshouldstay");
  });

  it("still scrubs authorization schemes and is idempotent", () => {
    const text =
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nAuthorization=Bearer abcdefghijklmnopqrstuvwxyz\n(Basic abcdefghijklmnopqrstuvwxyz)\ntoken abcdefghijklmnopqrstuvwxyz";
    const scrubbed = scrubLogSecrets(text);
    expect(scrubbed).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(scrubLogSecrets(scrubbed)).toBe(scrubbed);
    expect(scrubLogSecrets(scrubLogSecrets("?token=fixture-query-token&branch=develop"))).toBe(
      "?token=[redacted]&branch=develop",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(scrubLogSecrets("expected 2 to equal 3")).toBe("expected 2 to equal 3");
  });
});

describe("ByteTail", () => {
  it("keeps only the end of a stream and drops the partial first line", () => {
    const tail = new ByteTail(12);
    const encoder = new TextEncoder();
    for (const chunk of ["first line\n", "second\n", "third\n"]) tail.push(encoder.encode(chunk));
    expect(tail.overflowed).toBe(true);
    expect(tail.text()).toBe("third\n");
  });

  it("drops a first line the cut split", () => {
    const tail = new ByteTail(8);
    const encoder = new TextEncoder();
    for (const chunk of ["one\ntw", "o\n", "three\n"]) tail.push(encoder.encode(chunk));
    expect(tail.text()).toBe("three\n");
  });

  it("returns everything when nothing overflowed", () => {
    const tail = new ByteTail(1024);
    tail.push(new TextEncoder().encode("a\nb"));
    expect(tail.overflowed).toBe(false);
    expect(tail.text()).toBe("a\nb");
  });
});
