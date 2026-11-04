import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { GoogleAccountError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Approval from "./GmailSendApproval.ts";

const raw = (headers = "", body = "Friday works.") =>
  Buffer.from(
    `From: me@example.com\r\nTo: Ann <ann@example.com>\r\nSubject: =?UTF-8?B?UmU6IEx1bmNo?=\r\nContent-Type: text/plain; charset=UTF-8\r\n${headers}\r\n${body}`,
  ).toString("base64url");
const source: Approval.GmailApprovalSource = {
  draftId: "d1",
  accountKey: "account-credential-fingerprint",
  from: "me@example.com",
  messageId: "m1",
  threadId: "t1",
  raw: raw(),
};
const storage = () => {
  const values = new Map<string, Uint8Array>();
  const layer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name: string) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void values.set(name, value)),
    create: (name: string, value: Uint8Array) =>
      Effect.suspend(() => {
        if (values.has(name))
          return Effect.fail(
            new ServerSecretStore.SecretStorePersistError({ resource: name, cause: "EEXIST" }),
          );
        values.set(name, value);
        return Effect.void;
      }),
    remove: (name: string) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  return { values, layer };
};
const failed = (exit: Exit.Exit<unknown, GoogleAccountError>) =>
  expect(Exit.isFailure(exit)).toBe(true);

describe("complete supported MIME preview", () => {
  it("shows full body beyond the former 1500 limit and all recipients", () => {
    const body = "x".repeat(1800) + "THE END";
    const preview = Approval.previewGmailApproval({
      ...source,
      raw: raw("Cc: cc@example.com\r\nBcc: hidden@example.com\r\n", body),
    });
    expect(preview.body).toBe(body);
    expect(preview.headers).toContain("bcc: hidden@example.com");
    expect(preview.headers).toContain("cc: cc@example.com");
    expect(preview.subject).toBe("Re: Lunch");
  });
  it.each([
    "To: other@example.com\r\n",
    "Bcc: =?UTF-8?B?DQpUbzogdmljdGltQGV4YW1wbGUuY29t?=\r\n",
    "Bcc: hidden@example.com\r\nBcc: another@example.com\r\n",
    "Resent-To: hidden@example.com\r\n",
    "Content-Disposition: attachment; filename=a.txt\r\n",
    "Content-Type: multipart/mixed; boundary=x\r\n",
    "X-Unknown-Routing: hidden@example.com\r\n",
    "Bcc: broken@\r\n",
    "Bcc: group:hidden@example.com;\r\n",
  ])("refuses ambiguous or hidden content: %s", (headers) => {
    expect(() => Approval.previewGmailApproval({ ...source, raw: raw(headers) })).toThrow();
  });
  it("refuses HTML, mismatched sender, malformed encoding and oversized body", () => {
    for (const changed of [
      {
        ...source,
        raw: Buffer.from(
          Buffer.from(source.raw, "base64url").toString().replace("text/plain", "text/html"),
        ).toString("base64url"),
      },
      { ...source, from: "other@example.com" },
      { ...source, raw: "%%%" },
      { ...source, raw: raw("", "x".repeat(20_001)) },
    ])
      expect(() => Approval.previewGmailApproval(changed)).toThrow();
  });
});

it.effect(
  "binds account, full bytes, project/chat and revision, requiring a new proposal after changes",
  () => {
    const store = storage();
    return Effect.gen(function* () {
      const service = yield* Approval.make;
      const approved = yield* service.prepare("p", "chat", source);
      let sends = 0;
      const send = () => Effect.sync(() => ++sends);
      for (const changed of [
        { ...source, raw: raw("Bcc: hidden@example.com\r\n") },
        { ...source, raw: raw("", "changed") },
        { ...source, accountKey: "replacement-account" },
        { ...source, messageId: "m2" },
        { ...source, from: "other@example.com" },
      ]) {
        failed(
          yield* Effect.exit(
            service.consume("p", "chat", "d1", approved.snapshotId, changed, send),
          ),
        );
      }
      failed(
        yield* Effect.exit(
          service.consume("other-project", "chat", "d1", approved.snapshotId, source, send),
        ),
      );
      failed(
        yield* Effect.exit(
          service.consume("p", "other-chat", "d1", approved.snapshotId, source, send),
        ),
      );
      const reproposed = yield* service.prepare("p", "chat", {
        ...source,
        raw: raw("", "new body"),
        messageId: "m2",
      });
      expect(reproposed.snapshotId).not.toBe(approved.snapshotId);
      expect(sends).toBe(0);
    }).pipe(Effect.provide(store.layer));
  },
);

it.effect("posts immutable approved bytes even if the source changes during the request", () => {
  const store = storage();
  return Effect.gen(function* () {
    const service = yield* Approval.make;
    let mutable = source;
    const card = yield* service.prepare("p", "chat", mutable);
    const sent = yield* service.consume("p", "chat", "d1", card.snapshotId, mutable, (approved) =>
      Effect.sync(() => {
        mutable = {
          ...source,
          raw: raw("Bcc: later-edit@example.com\r\n", "edited during request"),
        };
        return approved.raw;
      }),
    );
    expect(sent).toBe(source.raw);
    expect(mutable.raw).not.toBe(sent);
    // New service instance models a restart; it sees the durable attempt barrier.
    const restarted = yield* Approval.make;
    failed(
      yield* Effect.exit(
        restarted.consume("p", "chat", "d1", card.snapshotId, source, () =>
          Effect.succeed("duplicate"),
        ),
      ),
    );
    failed(yield* Effect.exit(restarted.prepare("p", "chat", source)));
  }).pipe(Effect.provide(store.layer));
});

it.effect("ambiguous response persists a no-retry barrier and scrubs the raw snapshot", () => {
  const store = storage();
  return Effect.gen(function* () {
    const service = yield* Approval.make;
    const card = yield* service.prepare("p", "chat", source);
    let sends = 0;
    const post = () =>
      Effect.suspend(() => {
        sends++;
        return Effect.fail(new GoogleAccountError({ detail: "response lost" }));
      });
    failed(yield* Effect.exit(service.consume("p", "chat", "d1", card.snapshotId, source, post)));
    const restarted = yield* Approval.make;
    failed(yield* Effect.exit(restarted.consume("p", "chat", "d1", card.snapshotId, source, post)));
    expect(sends).toBe(1);
    expect([...store.values.keys()].some((name) => name.startsWith("gmail-approval"))).toBe(false);
    expect(new TextDecoder().decode([...store.values.values()][0])).toContain('"ambiguous"');
  }).pipe(Effect.provide(store.layer));
});

it.effect("detects stored snapshot mutation and refuses before external I/O", () => {
  const store = storage();
  return Effect.gen(function* () {
    const service = yield* Approval.make;
    const card = yield* service.prepare("p", "chat", source);
    const name = `gmail-approval-v2-${card.snapshotId}`;
    const text = new TextDecoder().decode(store.values.get(name));
    store.values.set(
      name,
      new TextEncoder().encode(text.replace(source.raw, raw("Bcc: injected@example.com\r\n"))),
    );
    failed(
      yield* Effect.exit(
        service.consume("p", "chat", "d1", card.snapshotId, source, () =>
          Effect.die("must not send"),
        ),
      ),
    );
  }).pipe(Effect.provide(store.layer));
});

it.effect(
  "real exclusive secret-store claims allow only one concurrent send across service instances",
  () =>
    Effect.gen(function* () {
      const one = yield* Approval.make;
      const two = yield* Approval.make;
      const card = yield* one.prepare("p", "chat", source);
      let sends = 0;
      const send = () => Effect.sync(() => ++sends);
      const outcomes = yield* Effect.all(
        [
          Effect.exit(one.consume("p", "chat", "d1", card.snapshotId, source, send)),
          Effect.exit(two.consume("p", "chat", "d1", card.snapshotId, source, send)),
        ],
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(sends).toBe(1);
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "gmail-approval-test-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("interrupted send retains its durable sending marker across restart", () => {
  const store = storage();
  return Effect.gen(function* () {
    const service = yield* Approval.make;
    const card = yield* service.prepare("p", "chat", source);
    failed(
      yield* Effect.exit(
        service.consume("p", "chat", "d1", card.snapshotId, source, () => Effect.interrupt),
      ),
    );
    const restarted = yield* Approval.make;
    failed(yield* Effect.exit(restarted.prepare("p", "chat", source)));
    expect(new TextDecoder().decode([...store.values.values()][0])).toContain('"sending"');
  }).pipe(Effect.provide(store.layer));
});

it.effect("refuses expired approvals before sending", () => {
  const store = storage();
  return Effect.gen(function* () {
    const service = yield* Approval.make;
    const card = yield* service.prepare("p", "chat", source);
    yield* TestClock.adjust("3 days");
    failed(
      yield* Effect.exit(
        service.consume("p", "chat", "d1", card.snapshotId, source, () =>
          Effect.die("expired send"),
        ),
      ),
    );
  }).pipe(Effect.provide(store.layer));
});

it("honors ASCII charset declarations and defaults across transfer encodings", () => {
  const encoded = (type: string, encoding: string, body: string) =>
    Buffer.from(
      `To: ann@example.com\r\n${type ? `Content-Type: ${type}\r\n` : ""}Content-Transfer-Encoding: ${encoding}\r\n\r\n${body}`,
    ).toString("base64url");
  for (const type of ["text/plain; charset=us-ascii", "text/plain", ""]) {
    for (const [encoding, body] of [
      ["base64", "Y2Fmw6k="],
      ["quoted-printable", "caf=C3=A9"],
      ["8bit", "café"],
    ]) {
      expect(() =>
        Approval.previewGmailApproval({ ...source, raw: encoded(type, encoding!, body!) }),
      ).toThrow();
    }
    expect(
      Approval.previewGmailApproval({ ...source, raw: encoded(type, "base64", "SGVsbG8=") }).body,
    ).toBe("Hello");
  }
  for (const [encoding, body] of [
    ["base64", "Y2Fmw6k="],
    ["quoted-printable", "caf=C3=A9"],
    ["8bit", "café"],
  ]) {
    expect(
      Approval.previewGmailApproval({
        ...source,
        raw: encoded("text/plain; charset=UTF-8", encoding!, body!),
      }).body,
    ).toBe("café");
  }
  expect(() =>
    Approval.previewGmailApproval({
      ...source,
      raw: Buffer.from(
        "To: ann@example.com\r\nSubject: =?us-ascii?B?Y2Fmw6k=?=\r\n\r\nHi",
      ).toString("base64url"),
    }),
  ).toThrow();
  expect(() =>
    Approval.previewGmailApproval({ ...source, raw: raw("", "before\rafter") }),
  ).toThrow();
});

it("joins adjacent folded and mixed RFC2047 words without inventing spaces", () => {
  const subject = (value: string) =>
    Approval.previewGmailApproval({
      ...source,
      raw: Buffer.from(`To: ann@example.com\r\nSubject: ${value}\r\n\r\nHi`).toString("base64url"),
    }).subject;
  expect(subject("=?UTF-8?B?UGF5?= =?UTF-8?B?bWVudA==?=")).toBe("Payment");
  expect(subject("=?UTF-8?B?UGF5?=\r\n \t=?UTF-8?Q?ment?=")).toBe("Payment");
  expect(subject("Before =?UTF-8?B?UGF5?= =?UTF-8?Q?ment?= after")).toBe("Before Payment after");
  expect(subject("=?UTF-8?Q?Pay_?= =?UTF-8?Q?ment?=")).toBe("Pay ment");
});

it("rejects a UTF8 BOM in ASCII transfer bytes before decoding and preserves explicit UTF8 codepoints", () => {
  const encoded = (type: string, encoding: string, body: string) =>
    Buffer.from(
      `To: ann@example.com\r\n${type ? `Content-Type: ${type}\r\n` : ""}Content-Transfer-Encoding: ${encoding}\r\n\r\n${body}`,
    ).toString("base64url");
  for (const type of ["text/plain; charset=us-ascii", "text/plain", ""]) {
    for (const [encoding, body] of [
      ["base64", "77u/SGVsbG8="],
      ["quoted-printable", "=EF=BB=BFHello"],
      ["8bit", "\ufeffHello"],
    ])
      expect(() =>
        Approval.previewGmailApproval({ ...source, raw: encoded(type, encoding!, body!) }),
      ).toThrow();
  }
  for (const [encoding, body] of [
    ["base64", "77u/SGVsbG8="],
    ["quoted-printable", "=EF=BB=BFHello"],
    ["8bit", "\ufeffHello"],
  ])
    expect(
      Approval.previewGmailApproval({
        ...source,
        raw: encoded("text/plain; charset=UTF-8", encoding!, body!),
      }).body,
    ).toBe("\ufeffHello");
  expect(() =>
    Approval.previewGmailApproval({
      ...source,
      raw: Buffer.from(
        "To: ann@example.com\r\nSubject: =?us-ascii?B?77u/SGVsbG8=?=\r\n\r\nHi",
      ).toString("base64url"),
    }),
  ).toThrow();
  expect(() =>
    Approval.previewGmailApproval({
      ...source,
      raw: Buffer.from("\ufeff" + Buffer.from(source.raw, "base64url").toString()).toString(
        "base64url",
      ),
    }),
  ).toThrow();
});
