import { describe, expect, it } from "vite-plus/test";

import { threadOpeningRequest } from "./commands.ts";

const message = (
  text: string,
  extra: {
    role?: "user" | "assistant";
    notification?: unknown;
    delegatedCompletion?: unknown;
  } = {},
) => ({ role: extra.role ?? ("user" as const), text, attachments: [], ...extra });

describe("threadOpeningRequest", () => {
  it("is the first request a person or coordinator wrote, not a wake or a reply", () => {
    expect(
      threadOpeningRequest([
        message("Done.", { role: "assistant" }),
        message("Pull request merged", { notification: { title: "PR" } }),
        message("Task finished", { delegatedCompletion: { taskIds: [] } }),
        message("   "),
        message("  Audit EasyChamp end to end  "),
        message("And add tests"),
      ]),
    ).toEqual({ text: "Audit EasyChamp end to end", attachmentCount: 0 });
  });

  it("is null for a thread that never got a request", () => {
    expect(threadOpeningRequest([message("Hi", { role: "assistant" })])).toBeNull();
  });
});
