/**
 * 0898 AC-01 and AC-04: nothing is sent or looked up before opt-in, opt-out
 * deletes the machine's history and retries until the team confirms, TLS
 * only, and the member's verified-skill.com token never goes elsewhere.
 */
import type { TeamUsageConfig, TeamUsageSummary } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  initialTeamUsageState,
  makeTeamUsageReporter,
  type TeamUsageState,
} from "./teamUsageReporterCore.ts";
import {
  teamUsageDeleteRequest,
  teamUsageSendRequest,
  type TeamUsageRequest,
} from "./teamUsageTransport.ts";

const TOKEN = "vsk_member0898";
const hosted = { kind: "hosted" as const, tenantId: "tenant-1" };

function harness(options: { statuses?: number[]; token?: string | undefined } = {}) {
  let now = Date.parse("2026-11-19T10:00:00.000Z");
  let used = 10;
  const sent: TeamUsageRequest[] = [];
  const statuses = [...(options.statuses ?? [])];
  let tokenReads = 0;
  let saved: TeamUsageState = initialTeamUsageState;
  let machineName = "M4";
  const secrets = new Map<string, string>();
  let gate: Promise<void> | undefined;
  let diskFull = false;
  const reporter = makeTeamUsageReporter({
    loadState: Effect.sync(() => saved),
    saveState: (state) =>
      Effect.sync(() => {
        if (diskFull) return false;
        saved = state;
        return true;
      }),
    buildSummary: (config: TeamUsageConfig) =>
      Effect.sync((): TeamUsageSummary => ({
        machineLabel: config.machineLabel ?? machineName,
        at: DateTime.formatIso(DateTime.makeUnsafe(now)),
        accounts: [
          {
            provider: "claudeAgent" as TeamUsageSummary["accounts"][number]["provider"],
            accountLabel: "Claude",
            windows: [
              { kind: "session", remainingPercent: 100 - used, lowestRemainingPercent: 100 - used },
            ],
            limitHits: 0,
            handoffs: 0,
            providerSwitches: 0,
          },
        ],
      })),
    readHostedToken: Effect.sync(() => {
      tokenReads += 1;
      return "token" in options ? options.token : TOKEN;
    }),
    readSelfHostedCredential: (url) => Effect.sync(() => secrets.get(url)),
    writeSelfHostedCredential: (url, value) =>
      Effect.sync(() => {
        if (value === undefined) secrets.delete(url);
        else secrets.set(url, value);
      }),
    send: (request) =>
      Effect.promise(async () => {
        sent.push(request);
        const wait = gate;
        if (wait && request.method === "POST") await wait;
        return statuses.shift() ?? 200;
      }),
    nowMs: Effect.sync(() => now),
  });
  return {
    reporter,
    sent,
    secrets,
    rename: (name: string) => {
      machineName = name;
    },
    setDiskFull: (value: boolean) => {
      diskFull = value;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
    get tokenReads() {
      return tokenReads;
    },
    get state() {
      return saved;
    },
    advance: (ms: number) => {
      now += ms;
    },
    use: (percent: number) => {
      used = percent;
    },
  };
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

describe("team usage opt-in (0898 AC-01)", () => {
  it("sends nothing and reads no token before opt-in", async () => {
    const h = harness();
    await run(h.reporter.tick);
    await run(h.reporter.tick);
    const status = await run(h.reporter.status);
    expect(h.sent).toEqual([]);
    expect(h.tokenReads).toBe(0);
    expect(status.config.enabled).toBe(false);
    expect(status.hostedSignedIn).toBeUndefined();
  });

  it("sends once on opt-in, then at most hourly and only on change", async () => {
    const h = harness();
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    expect(h.sent.map((request) => request.method)).toEqual(["POST"]);
    h.advance(10 * 60_000);
    h.use(30);
    await run(h.reporter.tick);
    expect(h.sent).toHaveLength(1);
    h.advance(60 * 60_000);
    await run(h.reporter.tick);
    expect(h.sent).toHaveLength(2);
    h.advance(61 * 60_000);
    await run(h.reporter.tick);
    expect(h.sent).toHaveLength(2);
  });

  it("opting out stops sending and deletes this machine's history, retried until confirmed", async () => {
    const h = harness({ statuses: [200, 0, 503, 204] });
    await run(
      h.reporter.update({ config: { enabled: true, endpoint: hosted, machineLabel: "Work Mac" } }),
    );
    await run(
      h.reporter.update({ config: { enabled: false, endpoint: hosted, machineLabel: "Work Mac" } }),
    );
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "DELETE"]);
    expect(h.sent[1]!.url).toBe(
      "https://verified-skill.com/api/v1/tenants/tenant-1/usage-summaries?machineLabel=Work+Mac",
    );
    expect((await run(h.reporter.status)).removalPending).toBe("Work Mac");
    await run(h.reporter.tick);
    expect((await run(h.reporter.status)).removalPending).toBe("Work Mac");
    await run(h.reporter.tick);
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "DELETE", "DELETE", "DELETE"]);
    expect((await run(h.reporter.status)).removalPending).toBeUndefined();
    h.advance(3 * 60 * 60_000);
    await run(h.reporter.tick);
    expect(h.sent).toHaveLength(4);
  });

  it("renaming the machine removes the history under the old label", async () => {
    const h = harness();
    await run(
      h.reporter.update({ config: { enabled: true, endpoint: hosted, machineLabel: "Old" } }),
    );
    await run(
      h.reporter.update({ config: { enabled: true, endpoint: hosted, machineLabel: "New" } }),
    );
    expect(h.sent.map((request) => `${request.method} ${request.url.split("?")[1] ?? ""}`)).toEqual(
      ["POST ", "DELETE machineLabel=Old", "POST "],
    );
  });

  it("opting back in before the delete is confirmed waits for the delete", async () => {
    const h = harness({ statuses: [200, 0, 0] });
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    await run(h.reporter.update({ config: { enabled: false, endpoint: hosted } }));
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "DELETE", "DELETE"]);
    await run(h.reporter.tick);
    expect(h.sent.map((request) => request.method)).toEqual([
      "POST",
      "DELETE",
      "DELETE",
      "DELETE",
      "POST",
    ]);
  });

  it("asks for a sign-in instead of sending when there is no vsk_ token", async () => {
    const h = harness({ token: undefined });
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    expect(h.sent).toEqual([]);
    expect((await run(h.reporter.status)).lastError).toBe(
      "Sign in with `vskill auth login` to send to your team.",
    );
  });
});

// Lets the runtime run what is ready, without a timer.
const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe("team usage review round 1 (0898)", () => {
  const a = { kind: "selfHosted" as const, url: "https://a.example/usage" };
  const b = { kind: "selfHosted" as const, url: "https://b.example/usage" };

  it("never sends a new endpoint's credential to the old one", async () => {
    const h = harness({ statuses: [200, 200, 200] });
    await run(
      h.reporter.update({
        config: { enabled: true, endpoint: a },
        selfHostedCredential: "secret-a",
      }),
    );
    await run(
      h.reporter.update({
        config: { enabled: true, endpoint: b },
        selfHostedCredential: "secret-b",
      }),
    );
    const byHost = h.sent.map(
      (request) =>
        `${request.method} ${new URL(request.url).host} ${request.headers.Authorization}`,
    );
    expect(byHost).toEqual([
      "POST a.example Bearer secret-a",
      "DELETE a.example Bearer secret-a",
      "POST b.example Bearer secret-b",
    ]);
    // A's credential goes once its history is removed.
    expect([...h.secrets.keys()]).toEqual([b.url]);
  });

  it("refuses a credential with no self-hosted endpoint to bind it to", async () => {
    const h = harness();
    const result = await run(
      h.reporter.update({
        config: { enabled: true, endpoint: hosted },
        selfHostedCredential: "stray",
      }),
    );
    expect(result).toEqual({ ok: false, reason: "Enter the self-hosted endpoint first." });
    expect(h.secrets.size).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("an opt-out waits for a send in flight, so the history stays removed", async () => {
    const h = harness();
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    h.advance(2 * 60 * 60_000);
    h.use(50);
    const release = h.hold();
    const tick = Effect.runPromise(h.reporter.tick);
    await settle();
    let optedOut = false;
    const optOut = Effect.runPromise(
      h.reporter.update({ config: { enabled: false, endpoint: hosted } }),
    ).then(() => {
      optedOut = true;
    });
    await settle();
    expect(optedOut).toBe(false);
    expect(h.sent.map((request) => request.method)).not.toContain("DELETE");
    release();
    await tick;
    await optOut;
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "POST", "DELETE"]);
    h.advance(2 * 60 * 60_000);
    await run(h.reporter.tick);
    expect(h.sent).toHaveLength(3);
  });

  it("a 404 from the team is a refusal, not a confirmed removal", async () => {
    const h = harness({ statuses: [200, 404, 200] });
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    await run(h.reporter.update({ config: { enabled: false, endpoint: hosted } }));
    expect((await run(h.reporter.status)).removalPending).toBe("M4");
    await run(h.reporter.tick);
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "DELETE", "DELETE"]);
    expect((await run(h.reporter.status)).removalPending).toBeUndefined();
  });

  it("a summary whose answer never came is still removed after a rename and opt-out", async () => {
    const h = harness({ statuses: [0, 200, 200] });
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    h.rename("New name");
    await run(h.reporter.update({ config: { enabled: false, endpoint: hosted } }));
    const deleted = h.sent
      .filter((request) => request.method === "DELETE")
      .map((request) => new URL(request.url).searchParams.get("machineLabel"));
    expect(deleted.toSorted()).toEqual(["M4", "New name"]);
  });

  it("an opt-out the machine could not save is not reported as done, and is saved later", async () => {
    const h = harness();
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    h.setDiskFull(true);
    const result = await run(h.reporter.update({ config: { enabled: false, endpoint: hosted } }));
    expect(result.ok).toBe(false);
    expect(h.state.config.enabled).toBe(true);
    // Stopped in memory already: nothing more is sent.
    h.advance(2 * 60 * 60_000);
    h.use(70);
    await run(h.reporter.tick);
    expect(h.sent.filter((request) => request.method === "POST")).toHaveLength(1);
    h.setDiskFull(false);
    await run(h.reporter.tick);
    expect(h.state.config.enabled).toBe(false);
  });

  it("a renamed machine's history under the old name is removed, even after opt-out", async () => {
    const h = harness();
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    h.rename("New name");
    h.advance(2 * 60 * 60_000);
    await run(h.reporter.tick);
    await run(h.reporter.tick);
    const labels = (method: string) =>
      h.sent
        .filter((request) => request.method === method)
        .map(
          (request) =>
            new URL(request.url).searchParams.get("machineLabel") ??
            JSON.parse(request.body!).machineLabel,
        );
    expect(labels("POST")).toEqual(["M4", "New name"]);
    expect(labels("DELETE")).toEqual(["M4"]);
    await run(h.reporter.update({ config: { enabled: false, endpoint: hosted } }));
    expect(labels("DELETE")).toEqual(["M4", "New name"]);
  });
});

describe("team usage transport (0898 AC-04)", () => {
  const summary: TeamUsageSummary = {
    machineLabel: "M4",
    at: "2026-11-19T10:00:00.000Z",
    accounts: [],
  };

  it("refuses plain http and addresses with credentials in them", () => {
    expect(
      teamUsageSendRequest(
        { kind: "selfHosted", url: "http://team.example/usage" },
        { hostedToken: TOKEN, selfHostedCredential: "team-secret" },
        summary,
      ),
    ).toEqual({ ok: false, reason: "The team endpoint must use https://." });
    expect(
      teamUsageSendRequest(
        { kind: "selfHosted", url: "https://user:pw@team.example/usage" },
        { hostedToken: TOKEN, selfHostedCredential: "team-secret" },
        summary,
      ).ok,
    ).toBe(false);
  });

  it("sends a self-hosted endpoint its own credential, never the vsk_ token", () => {
    const result = teamUsageSendRequest(
      { kind: "selfHosted", url: "https://team.example/usage" },
      { hostedToken: TOKEN, selfHostedCredential: "team-secret" },
      summary,
    );
    expect(result.ok && result.request.headers.Authorization).toBe("Bearer team-secret");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(
      teamUsageSendRequest(
        { kind: "selfHosted", url: "https://team.example/usage" },
        { hostedToken: TOKEN, selfHostedCredential: undefined },
        summary,
      ),
    ).toEqual({ ok: false, reason: "Add the self-hosted endpoint's credential." });
    expect(
      teamUsageDeleteRequest(
        { kind: "selfHosted", url: "https://team.example/usage" },
        { hostedToken: undefined, selfHostedCredential: TOKEN },
        "M4",
      ),
    ).toEqual({ ok: false, reason: "A verified-skill.com token is never sent to another host." });
  });

  it("keeps the hosted tenant one path segment on verified-skill.com", () => {
    for (const tenantId of ["..", "../../evil?x=", "a/b", "a?b", "a#b"])
      expect(
        teamUsageSendRequest(
          { kind: "hosted", tenantId },
          { hostedToken: TOKEN, selfHostedCredential: undefined },
          summary,
        ),
      ).toEqual({ ok: false, reason: "Pick your org again." });
  });
});
