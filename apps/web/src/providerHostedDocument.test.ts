import { describe, expect, it } from "vite-plus/test";

import {
  providerHostedDocument,
  providerHostedDocumentExplanation,
  providerHostedDocumentImportRequest,
  providerHostedDocumentNoun,
} from "./providerHostedDocument";

describe("providerHostedDocument", () => {
  it.each([
    ["https://claude.ai/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H", "Claude", "artifact"],
    ["https://claude.ai/artifact/release-checklist-Xq7Lm2Rt9Vb4Nc8Pd3Kf6H", "Claude", "artifact"],
    ["https://claude.ai/code/artifact/0f6c1e7a-3b0c-4c71-9d2e-6f1f6b1d2c3a", "Claude", "artifact"],
    ["https://claude.ai/public/artifacts/0f6c1e7a-3b0c-4c71", "Claude", "artifact"],
    ["https://claude.ai/chat/0f6c1e7a-3b0c-4c71-9d2e-6f1f6b1d2c3a", "Claude", "chat"],
    ["https://claude.ai/share/0f6c1e7a-3b0c", "Claude", "share"],
    ["https://claude.ai/code/session_01AbCdEf", "Claude", "session"],
    ["https://chatgpt.com/share/68a1b2c3-d4e5", "ChatGPT", "share"],
    ["https://chatgpt.com/c/68a1b2c3-d4e5/", "ChatGPT", "chat"],
    ["https://chat.openai.com/share/68a1b2c3", "ChatGPT", "share"],
    ["https://chatgpt.com/canvas/shared/68a1b2c3", "ChatGPT", "canvas"],
    ["https://chatgpt.com/codex/tasks/task_e_68a1b2c3", "Codex", "task"],
    ["https://gemini.google.com/share/a1b2c3d4", "Gemini", "share"],
    ["https://g.co/gemini/share/a1b2c3d4", "Gemini", "share"],
    ["https://cursor.com/agents/bc-a1b2c3d4", "Cursor", "agent"],
    ["https://app.devin.ai/sessions/a1b2c3d4e5", "Devin", "session"],
  ])("recognizes %s", (url, provider, kind) => {
    expect(providerHostedDocument(url)).toEqual({ provider, kind, url });
  });

  it.each([
    "https://claude.ai",
    "https://claude.ai/chrome",
    "https://claude.ai/download",
    "https://claude.ai/settings/connectors",
    "https://www.anthropic.com/claude",
    "https://chatgpt.com/",
    "https://github.com/anton-abyzov/specwithcode/pull/327",
    "https://example.com/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H",
    "/Users/me/report.md",
    "studio://thread/thread%3Aabc",
    "not a url",
    "",
  ])("leaves %s alone", (url) => {
    expect(providerHostedDocument(url)).toBeNull();
  });

  it("explains where the page lives and drafts a request to save it as a report", () => {
    const document = providerHostedDocument("https://claude.ai/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H")!;
    expect(providerHostedDocumentNoun(document)).toBe("a Claude artifact");
    expect(providerHostedDocumentExplanation(document)).toContain(
      "opens only for the account that made it",
    );
    expect(providerHostedDocumentImportRequest(document, "Plan [v2]")).toBe(
      "Save [Plan \\[v2\\]](https://claude.ai/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H) into this project's reports with studio_report_save: read it with your access to Claude, keep its source and original link, and link the saved file here instead of the Claude page.",
    );
  });
});
