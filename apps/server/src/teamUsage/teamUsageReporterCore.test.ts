/**
 * 0898 AC-01 and AC-04: nothing is sent or looked up before opt-in, opt-out
 * deletes the machine's history and retries until the team confirms, TLS
 * only, and the member's verified-skill.com token never goes elsewhere.
 */
import type { TeamUsageConfig, TeamUsageSummary } from "@specweave-studio/contracts";
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
  const reporter = makeTeamUsageReporter({
    loadState: Effect.sync(() => saved),
    saveState: (state) =>
      Effect.sync(() => {
        saved = state;
      }),
    buildSummary: (config: TeamUsageConfig) =>
      Effect.sync(
        (): TeamUsageSummary => ({
          machineLabel: config.machineLabel ?? "M4",
          at: new Date(now).toISOString(),
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
        }),
      ),
    readHostedToken: Effect.sync(() => {
      tokenReads += 1;
      return "token" in options ? options.token : TOKEN;
    }),
    readSelfHostedCredential: Effect.succeed(undefined),
    writeSelfHostedCredential: () => Effect.void,
    send: (request) =>
      Effect.sync(() => {
        sent.push(request);
        return statuses.shift() ?? 200;
      }),
    nowMs: Effect.sync(() => now),
  });
  return {
    reporter,
    sent,
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
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted, machineLabel: "Work Mac" } }));
    await run(h.reporter.update({ config: { enabled: false, endpoint: hosted, machineLabel: "Work Mac" } }));
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
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted, machineLabel: "Old" } }));
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted, machineLabel: "New" } }));
    expect(h.sent.map((request) => `${request.method} ${request.url.split("?")[1] ?? ""}`)).toEqual([
      "POST ",
      "DELETE machineLabel=Old",
      "POST ",
    ]);
  });

  it("opting back in before the delete is confirmed waits for the delete", async () => {
    const h = harness({ statuses: [200, 0, 0] });
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    await run(h.reporter.update({ config: { enabled: false, endpoint: hosted } }));
    await run(h.reporter.update({ config: { enabled: true, endpoint: hosted } }));
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "DELETE", "DELETE"]);
    await run(h.reporter.tick);
    expect(h.sent.map((request) => request.method)).toEqual(["POST", "DELETE", "DELETE", "DELETE", "POST"]);
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

describe("team usage transport (0898 AC-04)", () => {
  const summary: TeamUsageSummary = { machineLabel: "M4", at: "2026-11-19T10:00:00.000Z", accounts: [] };

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
