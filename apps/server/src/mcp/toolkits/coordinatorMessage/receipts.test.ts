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
  refusedWith,
  M5,
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
  it.effect("refuses a reply to a message sent under an earlier membership", () =>
    run(
      (receiver) =>
        Effect.gen(function* () {
          const refusal = yield* refusedWith(
            receiver,
            callerFrom(LINUX),
            request({ kind: "reply", replyTo: "message-original" }),
          );
          expect(refusal.status).toBe(409);
          const sent = (yield* records).filter((row) => row.direction === "outgoing");
          expect(Object.fromEntries(sent.map((row) => [row.externalId, row.state]))).toEqual({
            "message-original": "delivered",
            "message-queued": "queued",
          });
        }),
      [
        outgoing("message-original", "finding", { outgoingMembership: "before-rejoin" }),
        outgoing("message-queued", "finding", {
          state: "queued",
          receiverMessageId: "message-original",
        }),
      ],
    ),
  );
  it.effect("a reply from another machine answers nothing", () =>
    run(
      (receiver) =>
        Effect.gen(function* () {
          yield* deliver(
            receiver,
            callerFrom(BUILD_HOST),
            request({ kind: "reply", replyTo: "message-original" }),
          );
          const sent = (yield* records).filter((row) => row.direction === "outgoing");
          expect(sent.map((row) => row.state)).toEqual(["delivered"]);
        }),
      [outgoing("message-original", "finding")],
    ),
  );
  it.effect("refuses a message naming a report that is not on its sender", () =>
    run((receiver) =>
      Effect.gen(function* () {
        const refusal = yield* refusedWith(
          receiver,
          callerFrom(LINUX),
          request({
            refs: [
              {
                kind: "report",
                environmentId: M5,
                path: ".specweave/increments/1427-test/reports/m5.md",
                bytes: 10,
              },
            ],
          }),
        );
        expect(refusal).toMatchObject({ status: 409, code: "invalid" });
        expect(refusal.message).toContain("not on");
        expect(yield* records).toEqual([]);
      }),
    ),
  );
});
