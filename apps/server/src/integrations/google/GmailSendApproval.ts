/* eslint-disable no-control-regex -- MIME guards intentionally reject invisible control characters. */
// @effect-diagnostics-next-line nodeBuiltinImport:off - pure content digests, never credentials in output.
import * as NodeCrypto from "node:crypto";
import { GoogleAccountError, type ProjectId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import * as GoogleApi from "./GoogleApi.ts";
import { qualifiedId } from "./googleAccountLogic.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const fail = (detail: string) => new GoogleAccountError({ detail });
const unsupported = () =>
  fail(
    "This draft cannot be fully reviewed on a reply card. Review and send it in Gmail instead. Nothing was sent or changed.",
  );
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DAY = 86_400_000;
const Snapshot = Schema.Struct({
  projectId: Schema.String,
  chatId: Schema.String,
  draftId: Schema.String,
  accountKey: Schema.String,
  from: Schema.String,
  messageId: Schema.String,
  threadId: Schema.String,
  raw: Schema.String,
  expiresAt: Schema.Number,
});
type Snapshot = typeof Snapshot.Type;
export type GmailApprovalSource = Omit<Snapshot, "projectId" | "chatId" | "expiresAt">;
export interface GmailApprovalPreview {
  readonly draftId: string;
  readonly snapshotId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Complete decoded supported headers, including Cc, Bcc, Reply-To and threading. */
  readonly headers: string;
}
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value as object).sort()))
    .digest("hex");
export const accountFingerprint = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const content = ({ expiresAt: _expiresAt, ...value }: Snapshot) => value;
const key = (snapshot: Snapshot) => digest(content(snapshot));
const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot));
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const snapshotName = (id: string) => `gmail-approval-v2-${id}`;
const attemptName = (snapshot: Snapshot) => `gmail-attempt-v2-${key(snapshot)}`;

function base64(value: string, url = false): Uint8Array {
  if (
    !(
      url
        ? /^[A-Za-z0-9_-]+={0,2}$/u
        : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
    ).test(value)
  )
    throw unsupported();
  const bytes = Buffer.from(value, url ? "base64url" : "base64");
  if (
    bytes.toString(url ? "base64url" : "base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  )
    throw unsupported();
  return bytes;
}
// Validate transfer bytes before decoding; a decoder must never erase an ASCII violation.
// UTF-8 BOM codepoints are preserved explicitly, including in the immutable preview.
function decodeMimeText(bytes: Uint8Array, charset: string): string {
  if (charset.toLowerCase() === "us-ascii" && bytes.some((byte) => byte > 127)) throw unsupported();
  return decoder.decode(bytes);
}
function decodedHeader(value: string): string {
  // RFC2047: linear whitespace between adjacent encoded words is not displayed.
  const adjacent = value.replace(
    /(=\?[^?]+\?[bBqQ]\?[^?]*\?=)[ \t]+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/gu,
    "$1",
  );
  const decoded = adjacent.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/gu,
    (_all, charset: string, encoding: string, data: string) => {
      if (!/^(utf-8|us-ascii)$/iu.test(charset)) throw unsupported();
      if (!data || /[^!-~]/u.test(data)) throw unsupported();
      const bytes =
        encoding.toLowerCase() === "b" ? base64(data) : quotedPrintable(data.replaceAll("_", " "));
      return decodeMimeText(bytes, charset);
    },
  );
  if (decoded.includes("=?") || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(decoded))
    throw unsupported();
  return decoded;
}
function quotedPrintable(value: string): Uint8Array {
  const unfolded = value.replaceAll("=\r\n", "");
  if (/=(?![0-9A-Fa-f]{2})|[^\x09\x0a\x0d\x20-\x7e]/u.test(unfolded)) throw unsupported();
  return Uint8Array.from(
    unfolded.replace(/=([0-9A-Fa-f]{2})/gu, (_all, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
    (c) => c.charCodeAt(0),
  );
}
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
function mailboxes(value: string): string[] {
  return value.split(",").map((part) => {
    const text = part.trim();
    const match = /^(?:[A-Za-z0-9 ._'()-]+|"[^"\\]+")?\s*<([^<>]+)>$/u.exec(text);
    const email = match?.[1] ?? text;
    if (!address.test(email)) throw unsupported();
    return email;
  });
}

/** Deliberately narrow: never hide an attachment, alternate body, routing header, or truncation. */
export function previewGmailApproval(
  source: GmailApprovalSource,
): Omit<GmailApprovalPreview, "snapshotId"> {
  if (source.raw.length > 60_000 || !address.test(source.from)) throw unsupported();
  const mime = decoder.decode(base64(source.raw, true));
  const split = mime.indexOf("\r\n\r\n");
  if (split < 0 || split > 8_000 || /(^|[^\r])\n/u.test(mime.slice(0, split))) throw unsupported();
  const lines = mime
    .slice(0, split)
    .replace(/\r\n[ \t]+/gu, " ")
    .split("\r\n");
  const headers = new Map<string, string>();
  const allowed = new Set([
    "from",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
  ]);
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/u.exec(line);
    if (!match) throw unsupported();
    const name = match[1]!.toLowerCase();
    if (!allowed.has(name) || headers.has(name)) throw unsupported();
    headers.set(name, decodedHeader(match[2]!));
  }
  if (
    !/^text\/plain(?:;\s*charset=(?:"?(?:utf-8|us-ascii)"?))?\s*$/iu.test(
      headers.get("content-type") ?? "text/plain",
    )
  )
    throw unsupported();
  if (headers.has("mime-version") && headers.get("mime-version") !== "1.0") throw unsupported();
  const to = headers.get("to") ?? "";
  if (!to) throw unsupported();
  for (const field of ["to", "cc", "bcc", "reply-to", "from"]) {
    if (headers.has(field)) mailboxes(headers.get(field)!);
  }
  if (headers.has("from")) {
    const from = mailboxes(headers.get("from")!);
    if (from.length !== 1 || from[0]!.toLowerCase() !== source.from.toLowerCase())
      throw unsupported();
  }
  const charset =
    /charset="?([^";\s]+)/iu.exec(headers.get("content-type") ?? "")?.[1]?.toLowerCase() ??
    "us-ascii";
  const encodedBody = mime.slice(split + 4);
  const encoding = headers.get("content-transfer-encoding")?.toLowerCase() ?? "7bit";
  let body: string;
  if (encoding === "base64")
    body = decodeMimeText(base64(encodedBody.replace(/[\r\n]/gu, "")), charset);
  else if (encoding === "quoted-printable")
    body = decodeMimeText(quotedPrintable(encodedBody), charset);
  else if (encoding === "7bit" || encoding === "8bit") {
    if (encoding === "7bit" && /[^\x00-\x7f]/u.test(encodedBody)) throw unsupported();
    body = encodedBody;
  } else throw unsupported();
  if (
    body.length > 20_000 ||
    (charset === "us-ascii" && /[^\x00-\x7f]/u.test(body)) ||
    /\r(?!\n)/u.test(body) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(body)
  )
    throw unsupported();
  return {
    draftId: source.draftId,
    from: source.from,
    to,
    subject: headers.get("subject") ?? "(no subject)",
    body,
    headers: [...headers].map(([name, value]) => `${name}: ${value}`).join("\n"),
  };
}

export class GmailSendApproval extends Context.Service<
  GmailSendApproval,
  {
    readonly prepare: (
      projectId: string,
      chatId: string,
      source: GmailApprovalSource,
    ) => Effect.Effect<GmailApprovalPreview, GoogleAccountError>;
    readonly consume: <A>(
      projectId: string,
      chatId: string,
      draftId: string,
      snapshotId: string,
      current: GmailApprovalSource,
      send: (source: GmailApprovalSource) => Effect.Effect<A, GoogleAccountError>,
    ) => Effect.Effect<A, GoogleAccountError>;
  }
>()("specweave-studio/integrations/google/GmailSendApproval") {}

// Constructed inside the owning GoogleAccountService, using its existing secret-store environment.
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const storeError = () =>
    fail(
      "The durable Gmail approval record could not be verified. Nothing was sent; review the draft in Gmail.",
    );
  const prepare: GmailSendApproval["Service"]["prepare"] = (projectId, chatId, source) =>
    Effect.gen(function* () {
      const preview = yield* Effect.try({
        try: () => previewGmailApproval(source),
        catch: unsupported,
      });
      const now = yield* Clock.currentTimeMillis;
      const snapshot: Snapshot = {
        ...source,
        projectId,
        chatId,
        expiresAt: (Math.floor(now / DAY) + 2) * DAY,
      };
      const snapshotId = digest(snapshot);
      const attempted = yield* secrets.get(attemptName(snapshot)).pipe(Effect.mapError(storeError));
      if (Option.isSome(attempted))
        return yield* fail(
          "This approved copy already has a send attempt. Check Sent in Gmail before taking any further action. The source draft remains.",
        );
      // Identical proposals may safely write the same immutable bytes.
      yield* secrets
        .set(snapshotName(snapshotId), encode(snapshot))
        .pipe(Effect.mapError(storeError));
      return { ...preview, snapshotId };
    });
  const consume: GmailSendApproval["Service"]["consume"] = (
    projectId,
    chatId,
    draftId,
    snapshotId,
    current,
    send,
  ) =>
    Effect.gen(function* () {
      if (!/^[a-f0-9]{64}$/u.test(snapshotId))
        return yield* fail("Show a new reply card; this approval is not an immutable snapshot.");
      const stored = yield* secrets.get(snapshotName(snapshotId)).pipe(Effect.mapError(storeError));
      if (Option.isNone(stored))
        return yield* fail("The approved copy is unavailable. Show a new reply card.");
      const snapshot = yield* Effect.try({
        try: () => decodeSnapshot(decoder.decode(stored.value)),
        catch: storeError,
      });
      const now = yield* Clock.currentTimeMillis;
      if (
        digest(snapshot) !== snapshotId ||
        snapshot.projectId !== projectId ||
        snapshot.chatId !== chatId ||
        snapshot.draftId !== draftId ||
        snapshot.expiresAt <= now
      )
        return yield* fail(
          "This approval is stale or does not match this chat and project. Show a new reply card.",
        );
      yield* Effect.try({ try: () => previewGmailApproval(snapshot), catch: unsupported });
      if (key(snapshot) !== key({ ...current, projectId, chatId, expiresAt: snapshot.expiresAt }))
        return yield* fail(
          "The draft or sending account changed. Nothing was sent. Show a new reply card for the current draft.",
        );
      // Exclusive durable create is the send barrier. Never remove/retry it, including after a crash,
      // lost provider response, failed journal update, or a second process using the same host store.
      yield* secrets
        .create(attemptName(snapshot), encode({ state: "sending", snapshotId, at: now }))
        .pipe(
          Effect.mapError(() =>
            fail(
              "This approved copy already has a send attempt, or its durable record could not be created. Check Sent in Gmail; do not retry automatically. The source draft remains.",
            ),
          ),
        );
      yield* secrets.remove(snapshotName(snapshotId)).pipe(Effect.ignore);
      return yield* send(snapshot).pipe(
        Effect.tap(() =>
          secrets
            .set(attemptName(snapshot), encode({ state: "sent", snapshotId, at: now }))
            .pipe(Effect.ignore),
        ),
        Effect.catch((error) =>
          secrets
            .set(attemptName(snapshot), encode({ state: "ambiguous", snapshotId, at: now }))
            .pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Effect.fail(
                  fail(
                    `Gmail did not confirm the send. It may have sent the approved copy; check Sent in Gmail before any further action. The source draft remains. ${error.detail}`,
                  ),
                ),
              ),
            ),
        ),
      );
    });
  return GmailSendApproval.of({ prepare, consume });
});

/** The Google account service supplies callbacks under its account mutation lock. */
export const makeSending = (access: {
  readonly exclusive: <A>(
    effect: Effect.Effect<A, GoogleAccountError>,
  ) => Effect.Effect<A, GoogleAccountError>;
  readonly authorize: (
    projectId: ProjectId,
    draftId: string,
  ) => Effect.Effect<
    {
      readonly accountId: string;
      readonly email: string;
      readonly id: string;
      readonly token: Redacted.Redacted<string>;
      readonly accountKey: string;
    },
    GoogleAccountError
  >;
}) =>
  Effect.gen(function* () {
    const approvals = yield* make;
    const api = yield* GoogleApi.GoogleApi;
    const apiError = (error: GoogleApi.GoogleApiError) => fail(error.message);
    const source = (projectId: ProjectId, draftId: string) =>
      Effect.gen(function* () {
        const identity = yield* access.authorize(projectId, draftId);
        const draft = (yield* api
          .getJson({
            operation: "Gmail approval snapshot",
            url: `${api.endpoints.gmail}/users/me/drafts/${identity.id}`,
            query: { format: "raw" },
            accessToken: identity.token,
          })
          .pipe(Effect.mapError(apiError))) as {
          id?: string;
          message?: { id?: string; threadId?: string; raw?: string };
        };
        if (draft.id !== identity.id || !draft.message?.id || !draft.message.raw)
          return yield* fail("Gmail did not return a complete draft snapshot.");
        return {
          identity,
          source: {
            draftId: qualifiedId(identity.accountId, identity.id),
            accountKey: identity.accountKey,
            from: identity.email,
            messageId: draft.message.id,
            threadId: draft.message.threadId ?? "",
            raw: draft.message.raw,
          },
        };
      });
    const gmailPrepareSend = (projectId: ProjectId, chatId: string, draftId: string) =>
      access.exclusive(
        Effect.gen(function* () {
          const loaded = yield* source(projectId, draftId);
          return yield* approvals.prepare(projectId, chatId, loaded.source);
        }),
      );
    const gmailSendDraft = (
      projectId: ProjectId,
      draftId: string,
      chatId: string,
      snapshotId: string,
    ) =>
      access.exclusive(
        Effect.gen(function* () {
          const loaded = yield* source(projectId, draftId);
          return yield* approvals.consume(
            projectId,
            chatId,
            draftId,
            snapshotId,
            loaded.source,
            (approved) =>
              Effect.gen(function* () {
                // The captured token and raw bytes cannot switch accounts or revisions mid-request.
                // Never use the general read wrapper here: write attempts must not auto-retry.
                const sent = (yield* api
                  .postJson({
                    operation: "Gmail send approved copy",
                    url: `${api.endpoints.gmail}/users/me/messages/send`,
                    body: {
                      raw: approved.raw,
                      ...(approved.threadId ? { threadId: approved.threadId } : {}),
                    },
                    accessToken: loaded.identity.token,
                  })
                  .pipe(Effect.mapError(apiError))) as { id?: string; threadId?: string };
                if (typeof sent.id !== "string" || !/^[A-Za-z0-9_-]+$/u.test(sent.id))
                  return yield* fail("Gmail returned no sent message id.");
                return {
                  sent: true as const,
                  sourceDraftRetained: true as const,
                  from: loaded.identity.email,
                  messageId: qualifiedId(loaded.identity.accountId, sent.id),
                  threadId: typeof sent.threadId === "string" ? sent.threadId : null,
                };
              }),
          );
        }),
      );
    return { gmailPrepareSend, gmailSendDraft };
  });
