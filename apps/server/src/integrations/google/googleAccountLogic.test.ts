import { describe, expect, it } from "@effect/vitest";

import {
  buildAuthorizationUrl,
  buildGmailReplyDraft,
  driveQuery,
  emailFromIdToken,
  EMPTY_GOOGLE_ACCOUNT_STATE,
  googleEndpoints,
  parseCallback,
  projectServices,
  readGmailMessage,
  servicesFromScope,
  summarizeCalendarEvent,
  withProjectAccess,
} from "./googleAccountLogic.ts";

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("sign-in", () => {
  it("asks only for read scopes, offline access and PKCE", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizeUrl: googleEndpoints(undefined).authorize,
        clientId: "123456-abcdefgh.apps.googleusercontent.com",
        redirectUri: "http://127.0.0.1:8319/api/google/oauth/callback",
        services: ["drive", "gmail"],
        state: "state-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("points every endpoint at one test server when overridden", () => {
    expect(googleEndpoints("http://127.0.0.1:9/")).toMatchObject({
      authorize: "http://127.0.0.1:9/o/oauth2/v2/auth",
      token: "http://127.0.0.1:9/token",
      gmail: "http://127.0.0.1:9/gmail/v1",
    });
  });

  it("reads codes and errors from a pasted address or a bare query", () => {
    expect(parseCallback("http://127.0.0.1:8319/api/google/oauth/callback?state=s&code=c")).toEqual(
      {
        type: "code",
        code: "c",
        state: "s",
      },
    );
    expect(parseCallback("?error=access_denied&state=s")).toEqual({
      type: "error",
      error: "access_denied",
      state: "s",
    });
    expect(parseCallback("hello").type).toBe("invalid");
    expect(parseCallback("?code=c").type).toBe("invalid");
  });

  it("keeps only the services Google granted", () => {
    expect(
      servicesFromScope(
        "openid https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
      ),
    ).toEqual(["calendar"]);
  });

  it("reads the email claim from an ID token", () => {
    expect(emailFromIdToken(`h.${encode(JSON.stringify({ email: "me@example.com" }))}.s`)).toBe(
      "me@example.com",
    );
    expect(emailFromIdToken("garbage")).toBeNull();
  });
});

describe("project access", () => {
  it("limits each project to what was granted and drops empty entries", () => {
    const granted = {
      ...EMPTY_GOOGLE_ACCOUNT_STATE,
      services: ["gmail" as const, "calendar" as const],
    };
    const withAccess = withProjectAccess(granted, "p1", ["drive", "gmail"]);
    expect(withAccess.projects).toEqual([{ projectId: "p1", services: ["gmail", "drive"] }]);
    expect(projectServices(withAccess, "p1")).toEqual(["gmail"]);
    expect(projectServices(withAccess, "p2")).toEqual([]);
    expect(withProjectAccess(withAccess, "p1", []).projects).toEqual([]);
  });
});

describe("shapes for agents", () => {
  it("prefers the plain-text body and lists attachments", () => {
    const message = readGmailMessage({
      id: "m1",
      labelIds: ["UNREAD", "INBOX"],
      snippet: "Lunch &amp; plans",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "Subject", value: "Lunch" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: encode("See you at noon.") } },
              { mimeType: "text/html", body: { data: encode("<p>See you</p>") } },
            ],
          },
          { mimeType: "application/pdf", filename: "menu.pdf", body: { size: 1200 } },
        ],
      },
    });
    expect(message).toMatchObject({
      from: "Alice <alice@example.com>",
      subject: "Lunch",
      snippet: "Lunch & plans",
      unread: true,
      body: "See you at noon.",
      attachments: [{ filename: "menu.pdf", mimeType: "application/pdf", size: 1200 }],
    });
  });

  it("turns an HTML-only body into text", () => {
    const message = readGmailMessage({
      id: "m2",
      payload: {
        mimeType: "text/html",
        body: { data: encode("<style>p{}</style><p>Hello</p><p>World &amp; more</p>") },
      },
    });
    expect(message.body).toBe("Hello\nWorld & more");
  });

  it("marks all-day events and the person's response", () => {
    expect(
      summarizeCalendarEvent({
        id: "e1",
        summary: "Holiday",
        start: { date: "2026-10-12" },
        end: { date: "2026-10-13" },
        attendees: [{ email: "me@example.com", self: true, responseStatus: "accepted" }],
      }),
    ).toMatchObject({
      title: "Holiday",
      allDay: true,
      start: "2026-10-12",
      myResponse: "accepted",
    });
  });

  it("escapes text in Drive queries", () => {
    expect(driveQuery({ text: "Bob's plan" })).toBe(
      "trashed = false and fullText contains 'Bob\\'s plan'",
    );
    expect(driveQuery({ modifiedAfter: "2026-10-09T00:00:00.000Z" })).toBe(
      "trashed = false and modifiedTime > '2026-10-09T00:00:00.000Z'",
    );
  });
});

describe("reply drafts", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
  const message = (headers: Record<string, string>) => ({
    id: "m1",
    threadId: "t1",
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });

  it("answers Reply-To, threads under the original and keeps one Re:", () => {
    const draft = buildGmailReplyDraft({
      message: message({
        From: "Ann <ann@example.com>",
        "Reply-To": "team@example.com",
        Subject: "RE: Plans",
        "Message-ID": "<m1@x>",
        References: "<m0@x>",
      }),
      body: "Sounds good.",
      selfEmail: "me@example.com",
    })!;
    expect(draft.to).toBe("team@example.com");
    expect(draft.subject).toBe("RE: Plans");
    const raw = decode(draft.raw);
    expect(raw).toContain("In-Reply-To: <m1@x>\r\n");
    expect(raw).toContain("References: <m0@x> <m1@x>\r\n");
    expect(raw).toContain(Buffer.from("Sounds good.").toString("base64"));
  });

  it("replies to the recipients of the person's own message", () => {
    const draft = buildGmailReplyDraft({
      message: message({ From: "Me <ME@example.com>", To: "bob@example.com", Subject: "Hi" }),
      body: "Following up.",
      selfEmail: "me@example.com",
    })!;
    expect(draft.to).toBe("bob@example.com");
    expect(draft.subject).toBe("Re: Hi");
  });

  it("cannot be made to add headers, and encodes a non-ASCII subject", () => {
    const draft = buildGmailReplyDraft({
      message: message({
        From: "eve@example.com\r\nBcc: everyone@example.com",
        Subject: "Привет\nBcc: x@example.com",
      }),
      body: "Hi",
      selfEmail: null,
    })!;
    const raw = decode(draft.raw);
    expect(raw).not.toMatch(/^Bcc:/mu);
    expect(raw).toContain("Subject: =?UTF-8?B?");
  });

  it("refuses a message that names nobody to reply to", () => {
    expect(buildGmailReplyDraft({ message: message({}), body: "Hi", selfEmail: null })).toBeNull();
  });
});
