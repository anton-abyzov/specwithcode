import { describe, expect, it } from "vite-plus/test";
import { DateTime } from "effect";
import { ThreadId } from "@specweave-studio/contracts";
import { prepareProjectMarkdown } from "./projectWorkspaceModel";
import { epochMillis, linkedThreadIds, newThreadsByMessage } from "./projectThreadMentions";

const at = (time: string) => DateTime.makeUnsafe(`2026-10-11T${time}Z`);
const old = { id: ThreadId.make("old"), title: "Skills panel", createdAt: "2026-10-10T09:00:00Z" };
const started = {
  id: ThreadId.make("new"),
  title: "Skills consolidation and tutorials",
  createdAt: "2026-10-11T05:00:04Z",
};
const threads = [old, started];
const linked = (text: string) => linkedThreadIds(prepareProjectMarkdown(text, threads));

describe("thread mentions in the coordinator conversation", () => {
  it("reads each prepared thread link once, in order", () => {
    expect(
      linked(
        "[Skills consolidation](studio://thread/new) follows [Skills panel](studio://thread/old) and [again](studio://thread/new).",
      ),
    ).toEqual(["new", "old"]);
    expect(linked("No [links](https://example.com) to threads.")).toEqual([]);
  });

  it("cards a thread the coordinator started in this turn and links one that existed", () => {
    const cards = newThreadsByMessage(
      [
        { id: "ask", role: "user", linked: [], createdAt: at("05:00:00") },
        {
          id: "ack",
          role: "assistant",
          linked: linked(
            "Started [Skills consolidation](studio://thread/new); it builds on [Skills panel](studio://thread/old).",
          ),
          createdAt: at("05:00:05"),
          updatedAt: at("05:00:06"),
        },
        {
          id: "later",
          role: "assistant",
          linked: linked("[Skills consolidation](studio://thread/new) is still working."),
          createdAt: at("05:00:07"),
          updatedAt: at("05:00:08"),
        },
      ],
      threads,
    );
    expect([...cards]).toEqual([["ack", ["new"]]]);
  });

  it("links a thread mentioned again in a later turn", () => {
    const cards = newThreadsByMessage(
      [
        { id: "next", role: "user", linked: [], createdAt: at("06:00:00") },
        {
          id: "status",
          role: "assistant",
          linked: ["new"],
          createdAt: at("06:00:02"),
          updatedAt: at("06:00:03"),
        },
      ],
      threads,
    );
    expect(cards.size).toBe(0);
  });

  it("calls nothing new when the turn's opening message or the times are missing", () => {
    expect(
      newThreadsByMessage(
        [{ id: "ack", role: "assistant", linked: ["new"], createdAt: at("05:00:05") }],
        threads,
      ).size,
    ).toBe(0);
    expect(
      newThreadsByMessage(
        [
          { id: "ask", role: "user", linked: [] },
          { id: "ack", role: "assistant", linked: ["new"] },
        ],
        threads,
      ).size,
    ).toBe(0);
  });

  it("reads host DateTimes, ISO strings and Dates, and nothing else", () => {
    const ms = Date.parse("2026-10-11T05:00:00Z");
    expect(epochMillis(at("05:00:00"))).toBe(ms);
    expect(epochMillis("2026-10-11T05:00:00Z")).toBe(ms);
    expect(epochMillis(new Date(ms))).toBe(ms);
    expect(epochMillis("not a time")).toBeNull();
    expect(epochMillis(undefined)).toBeNull();
  });
});
