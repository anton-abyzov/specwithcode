import { describe, expect, it } from "@effect/vitest";
import { ScheduledTaskId } from "@specweave-studio/contracts";

import type { TelegramMessage } from "./TelegramBotApi.ts";
import {
  chunkTelegramText,
  classifyInbound,
  describeFinishedRun,
  EMPTY_TELEGRAM_CHANNEL_STATE,
  makePairingCode,
  readPairingAttempt,
  shouldForwardRun,
  type TelegramChannelState,
} from "./telegramChannelLogic.ts";

const NOW = Date.parse("2026-10-10T06:00:00Z");
const waiting: TelegramChannelState = {
  ...EMPTY_TELEGRAM_CHANNEL_STATE,
  enabled: true,
  projectId: "project-1",
  pairingCode: "ABCDEFGH23",
  pairingCodeExpiresAt: "2026-10-10T06:30:00Z",
};
const paired: TelegramChannelState = {
  ...waiting,
  chatId: 42,
  chatLabel: "Anton",
  pairingCode: null,
  pairingCodeExpiresAt: null,
};
const message = (text: string | undefined, chat: Partial<TelegramMessage["chat"]> = {}) =>
  ({
    message_id: 1,
    chat: { id: 42, type: "private", first_name: "Anton", username: "anton", ...chat },
    ...(text === undefined ? {} : { text }),
  }) satisfies TelegramMessage;

describe("pairing codes", () => {
  it("uses ten characters without look-alike letters", () => {
    const code = makePairingCode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 255]));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/u);
  });

  it("reads deep-link starts, mentions and bare codes", () => {
    expect(readPairingAttempt("/start ABCDEFGH23")).toBe("ABCDEFGH23");
    expect(readPairingAttempt("/start@studio_bot abcdefgh23")).toBe("ABCDEFGH23");
    expect(readPairingAttempt("  ABCDEFGH23 ")).toBe("ABCDEFGH23");
    expect(readPairingAttempt("hello there")).toBeNull();
  });
});

describe("classifyInbound", () => {
  it("pairs a private chat that sends the current code", () => {
    expect(classifyInbound(waiting, message("/start ABCDEFGH23"), NOW)).toEqual({
      type: "pair",
      chatId: 42,
      chatLabel: "Anton (@anton)",
    });
  });

  it("does not pair with a wrong or expired code", () => {
    expect(classifyInbound(waiting, message("/start ZZZZZZZZZZ"), NOW).type).toBe("pairing_hint");
    const expired = { ...waiting, pairingCodeExpiresAt: "2026-10-10T05:59:00Z" };
    expect(classifyInbound(expired, message("/start ABCDEFGH23"), NOW).type).toBe("pairing_hint");
  });

  it("ignores groups, and every other chat once paired", () => {
    expect(
      classifyInbound(waiting, message("/start ABCDEFGH23", { type: "group" }), NOW).type,
    ).toBe("ignore");
    expect(classifyInbound(paired, message("hi", { id: 7 }), NOW).type).toBe("ignore");
  });

  it("routes commands and plain text from the paired chat", () => {
    expect(classifyInbound(paired, message("/help"), NOW).type).toBe("help");
    expect(classifyInbound(paired, message("/status@studio_bot"), NOW).type).toBe("status");
    expect(classifyInbound(paired, message(undefined), NOW).type).toBe("unsupported");
    expect(classifyInbound(paired, message(" book a table for two "), NOW)).toEqual({
      type: "forward",
      chatId: 42,
      text: "book a table for two",
    });
  });
});

describe("shouldForwardRun", () => {
  it("skips only runs the person started at a desk", () => {
    expect(shouldForwardRun({ createdBy: "user", creationSource: "web" })).toBe(false);
    expect(shouldForwardRun({ createdBy: "user", creationSource: "mobile" })).toBe(false);
    expect(shouldForwardRun({ createdBy: "user", creationSource: "server" })).toBe(true);
    expect(shouldForwardRun({ createdBy: "system", creationSource: "server" })).toBe(true);
    expect(shouldForwardRun(undefined)).toBe(true);
  });

  it("forwards a routine's run even when the routine was made at a desk", () => {
    expect(
      shouldForwardRun({
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: ScheduledTaskId.make("task-seo"),
      }),
    ).toBe(true);
  });
});

describe("describeFinishedRun", () => {
  it("sends completed answers and explains failures", () => {
    expect(describeFinishedRun("completed", " Done. ")).toBe("Done.");
    expect(describeFinishedRun("completed", "")).toBeNull();
    expect(describeFinishedRun("failed", null)).toContain("failed");
    expect(describeFinishedRun("interrupted", "partial")).toBeNull();
  });
});

describe("chunkTelegramText", () => {
  it("keeps short text whole", () => {
    expect(chunkTelegramText("hello")).toEqual(["hello"]);
  });

  it("splits long text on paragraph boundaries and numbers the parts", () => {
    const paragraph = "word ".repeat(150).trim();
    const parts = chunkTelegramText([paragraph, paragraph, paragraph].join("\n\n"), 1_000);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(`${paragraph}\n\n(1/3)`);
    expect(parts.every((part) => part.length <= 1_010)).toBe(true);
  });
});
