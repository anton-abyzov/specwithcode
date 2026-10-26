import { describe, expect, it } from "vite-plus/test";

import {
  findSquashedText,
  reportFileName,
  reportIncrementCandidates,
  reportKey,
  reportKeyFromFileName,
  reportSummary,
  reportThreadKey,
  reportTitle,
  reportWordCount,
  squashedTextMessage,
} from "./threadReport.ts";

describe("thread report helpers", () => {
  it("keys a report by thread and normalized text", () => {
    expect(reportKey("t1", "Body\r\n")).toBe(reportKey("t1", "  Body"));
    expect(reportKey("t1", "Body")).not.toBe(reportKey("t2", "Body"));
    expect(reportKey("t1", "Body")).not.toBe(reportKey("t1", "Other"));
    expect(reportKey("t1", "Body").startsWith(`${reportThreadKey("t1")}-`)).toBe(true);
  });

  it("titles a report by its heading, its first line, or the fallback", () => {
    expect(reportTitle("## **Budget** review\n\nBody", "Thread")).toBe("Budget review");
    expect(reportTitle("Tests pass.\n\nMore", "Thread")).toBe("Tests pass");
    expect(reportTitle(`${"word ".repeat(30)}`, "Review cycle 2")).toBe("Review cycle 2");
    expect(reportTitle("", "")).toBe("Report");
    expect(reportTitle("- Finding 1\n- Finding 2", "Review 0973")).toBe("Review 0973");
    expect(reportTitle("| a | b |\n| --- | --- |", "Audit")).toBe("Audit");
    expect(reportTitle("Ran the migration.\n\n```bash\n# run it\nnpm run migrate\n```", "T")).toBe(
      "Ran the migration",
    );
  });

  it("summarizes the first prose paragraph as plain text", () => {
    const text = [
      "# Title",
      "",
      "```ts",
      "const x = 1;",
      "",
      "const y = 2;",
      "```",
      "",
      "No **critical** findings; see [the PR](https://example.com).",
    ].join("\n");
    expect(reportSummary(text)).toBe("No critical findings; see the PR.");
    expect(reportSummary(`${"a".repeat(400)}`, 20)).toHaveLength(20);
  });

  it("counts words", () => {
    expect(reportWordCount("# Hi there\n\n- one, two | 3")).toBe(5);
  });

  it("finds increment candidates in the title, branch and named folders", () => {
    expect(
      reportIncrementCandidates({
        title: "Review cycle 2 of 0973",
        branch: "inc/0974-export",
        text: "Saved in .specweave/increments/0975-csv and 1999 rows.",
      }),
    ).toEqual([
      { kind: "number", value: "0973" },
      { kind: "folder", value: "0974-export" },
      { kind: "folder", value: "0975-csv", fromText: true },
    ]);
  });

  it("finds increment numbers and folders past 9999", () => {
    expect(
      reportIncrementCandidates({
        title: "Review 10001",
        branch: "inc/10002-export",
        text: "Saved in .specweave/increments/10003-csv.",
      }),
    ).toEqual([
      { kind: "number", value: "10001" },
      { kind: "folder", value: "10002-export" },
      { kind: "folder", value: "10003-csv", fromText: true },
    ]);
  });

  it("finds SpecWeave's lettered increment folders, matched to disk without case", () => {
    expect(
      reportIncrementCandidates({
        title: "Follow-up",
        branch: "inc/0657E-dark-theme-followup",
        text: "Saved in .specweave/increments/0713B-production-rollout.",
      }),
    ).toEqual([
      { kind: "folder", value: "0657e-dark-theme-followup" },
      { kind: "folder", value: "0713b-production-rollout", fromText: true },
    ]);
  });

  it("names files by day, title and key, and reads the key back", () => {
    const name = reportFileName({
      savedAt: "2026-10-12T07:30:00.000Z",
      title: "Review: cycle 2 of 0973!",
      threadId: "t1",
      text: "Body",
    });
    expect(name).toBe(`2026-10-12-review-cycle-2-of-0973-${reportKey("t1", "Body")}.md`);
    expect(reportKeyFromFileName(name)).toBe(reportKey("t1", "Body"));
    expect(reportKeyFromFileName("spec.md")).toBeNull();
  });
});

describe("reportTitle for labeled reports", () => {
  it("uses the fallback when the report opens with a labeled part", () => {
    expect(
      reportTitle("**Outcome:** Rows show the harness.\n\n**Blockers:** none.", "Harness"),
    ).toBe("Harness");
    expect(reportTitle("Outcome: Rows show the harness.", "Harness")).toBe("Harness");
    expect(reportTitle("Rows show the harness.", "Harness")).toBe("Rows show the harness");
  });
});

// A worker's report to the EasyChamp coordinator, October 25, 2026.
const REPORT =
  "Owneranswersresolvedidentity; no renewedquestion. Actualdashboardheadlesssignin+directMongo worked,all7executed(6PASS,1FAIL) exposed realUTCdaybug UI20vsMongo11 acrossmidnight. Ownread-onlySSHtunnelstopped,ephemeralstateprivate600thenretired,no sessionvalueslogs/Git/receipts. SourcePR21 https://github.com/anton-abyzov/ec-scrapers-dashboard/pull/21 exact09d2a75df492b63413cf2e2327e97ef5c5f8800e fixesauth/sessionStorage/failclosedmissinginputs/no-skippedgreen andUTCdayKPI, preservesall7assertions;72worker+20UI+13boundarytests/buildPASS. Neednormalreviewedmerge/deploythenactualall7livePASS; notclaimingcomplete yet.";

describe("findSquashedText", () => {
  it("finds a report whose words run together", () => {
    expect(findSquashedText(REPORT)?.samples).toEqual([
      "Owneranswersresolvedidentity",
      "Actualdashboardheadlesssignin+directMong…",
      "Ownread-onlySSHtunnelstopped,ephemeralst…",
    ]);
  });

  it("finds a run-together paragraph after a readable one", () => {
    const text = `The audit is done and the pull request is open for review.\n\n${REPORT}`;
    expect(findSquashedText(text)).not.toBeNull();
  });

  it("counts words joined by invisible characters as run together", () => {
    const words = REPORT.replaceAll(" ", "​");
    expect(findSquashedText(words)).not.toBeNull();
  });

  it("passes a technical report with hashes, paths, links and identifiers", () => {
    const text = [
      "Fixed the worker messages. `studio_thread_send` passed the text through unchanged, so the model wrote it that way.",
      "PR [#812](https://github.com/anton-abyzov/specwithcode/pull/812) at 09d2a75df492b63413cf2e2327e97ef5c5f8800e passes 72 worker, 20 UI and 13 boundary tests in apps/server/src/mcp/toolkits/orchestrator/handlers.ts.",
      "OrchestratorMcpThreadSendInput, ProjectCoordinatorService and WorkerMessagePresentation are unchanged.",
      "Report: /Users/you/.local/share/easychamp/dashboard-auth-20261025/iac-contract-review.md, also https://example.com/averyveryverylongpathsegmentwithoutspaces.",
      "Long words such as internationalization, characteristically and counterrevolutionary are fine.",
    ].join("\n\n");
    expect(findSquashedText(text)).toBeNull();
  });

  it("passes dense German compounds", () => {
    const text =
      "Die Datenschutzgrundverordnung verlangt eine Auftragsverarbeitungsvereinbarung mit jedem Dienstleister. Ich habe die Softwareentwicklung im Projekt geprüft und die Geschwindigkeitsbegrenzung der Schnittstelle dokumentiert.";
    expect(findSquashedText(text)).toBeNull();
  });

  it("leaves code blocks, code spans and short messages alone", () => {
    const code =
      "```\nconstaverylongidentifierwithoutanycapitals = anotherverylongidentifierwithoutcapitals;\n```";
    expect(findSquashedText(`Here is the change:\n\n${code}`)).toBeNull();
    expect(
      findSquashedText(
        "Set `averylongidentifierwithoutanycapitals` and `anotherverylongidentifierhere` in the config file.",
      ),
    ).toBeNull();
    expect(findSquashedText("Doneallteststpassed")).toBeNull();
  });

  it("tells the sender what to fix, quoting what it wrote", () => {
    const message = squashedTextMessage(findSquashedText(REPORT)!);
    expect(message).toContain('"Owneranswersresolvedidentity"');
    expect(message).toContain("a space between every word");
    expect(message).toContain("put it in a file and send its path");
  });
});
