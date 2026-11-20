import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BUILD_HOST,
  LINUX,
  callerFrom,
  deliver,
  request,
  run,
  outgoing,
  records,
} from "../../../project/CoordinatorMessageReceiver.testkit.ts";
const access = (peer: string) => ({
  operate: false,
  sessionId: `session-${peer}`,
  device: {},
  credentialExpiresAt: 8.64e15,
});
describe("coordinator message receipts", () => {
  it.effect("reports an admitted message only to its sender", () =>
    run((receiver) =>
      Effect.gen(function* () {
        const input = request();
        yield* deliver(receiver, callerFrom(LINUX), input);
        const receipt = yield* receiver.receipt(callerFrom(LINUX), input, access(LINUX));
        expect(receipt.state).toBe("settling");
        const other = yield* receiver
          .receipt(callerFrom(BUILD_HOST), input, access(BUILD_HOST))
          .pipe(Effect.flip);
        expect(other.code).toBe("not_found");
      }),
    ),
  );
  it.effect("refuses a receipt when the presented credential has expired", () =>
    run((receiver) =>
      Effect.gen(function* () {
        const input = request();
        yield* deliver(receiver, callerFrom(LINUX), input);
        const error = yield* receiver
          .receipt(callerFrom(LINUX), input, { ...access(LINUX), credentialExpiresAt: 0 })
          .pipe(Effect.flip);
        expect(error.code).toBe("needs_grant");
      }),
    ),
  );
  it.effect("a reply marks the original and merged outgoing rows answered", () =>
    run(
      (receiver) =>
        Effect.gen(function* () {
          const answer = yield* deliver(
            receiver,
            callerFrom(LINUX),
            request({ kind: "reply", replyTo: "message-original" }),
          );
          expect(answer.ok).toBe(true);
          const sent = (yield* records).filter((row) => row.direction === "outgoing");
          expect(sent.map((row) => row.state)).toEqual(["answered", "answered"]);
        }),
      [
        outgoing("message-original", "finding"),
        outgoing("message-merged", "finding", { receiverMessageId: "message-original" }),
      ],
    ),
  );
  it.effect("a report read refuses a path the message never named", () =>
    run(
      (receiver) =>
        Effect.gen(function* () {
          const input = request({}, { messageId: "message-report-owner" });
          const error = yield* receiver
            .read(
              callerFrom(LINUX),
              { ...input, path: ".specweave/increments/1427-test/reports/private.md", offset: 0 },
              access(LINUX),
            )
            .pipe(Effect.flip);
          expect(error.code).toBe("needs_grant");
        }),
      [outgoing("message-report-owner", "finding")],
    ),
  );
});
