import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  type CopilotGhTokenResult,
  type CopilotUserResponse,
  COPILOT_USAGE_CACHE_TTL_MS,
  COPILOT_USAGE_UNAVAILABLE_TTL_MS,
  copilotUserResponseToLimits,
  makeCachedCopilotUsageLimits,
  parseCopilotLastLoggedInUser,
  readCopilotSignedInLogin,
  readCopilotUsage,
  readCopilotAccountStamp,
  readCopilotUsageLimits,
  resolveCopilotHome,
  resolveGhHostsFile,
} from "./copilotUsageLimits.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const checkedAt = "2026-11-04T12:00:00.000Z";

const quota = (input: Record<string, unknown>) => ({
  entitlement: 0,
  remaining: 0,
  percent_remaining: 100,
  unlimited: false,
  has_quota: false,
  overage_permitted: false,
  timestamp_utc: "2026-11-04T11:59:00.000Z",
  ...input,
});

const proResponse: CopilotUserResponse = {
  login: "octocat",
  copilot_plan: "individual",
  access_type_sku: "monthly_subscriber",
  quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
  quota_snapshots: {
    chat: quota({ unlimited: true, entitlement: 0, remaining: 0 }),
    completions: quota({ unlimited: true }),
    premium_interactions: quota({
      entitlement: 300,
      remaining: 225,
      percent_remaining: 75,
      has_quota: true,
    }),
  },
};

describe("copilotUserResponseToLimits", () => {
  it("maps premium requests to a monthly window", () => {
    const limits = copilotUserResponseToLimits({
      response: proResponse,
      checkedAt,
      expectedLogin: "OctoCat",
    });
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "premium_interactions",
        kind: "monthly",
        label: "Premium requests",
        usedPercent: 25,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
    expect(limits.subscriptionKey).toMatch(/^copilot:sha256:[a-f0-9]{64}$/u);
  });

  it("keeps Copilot runnable when premium requests are spent", () => {
    const spent = copilotUserResponseToLimits({
      response: {
        ...proResponse,
        quota_snapshots: {
          ...proResponse.quota_snapshots,
          premium_interactions: quota({
            entitlement: 300,
            remaining: 0,
            percent_remaining: 0,
            has_quota: true,
          }),
        },
      },
      checkedAt,
    });
    expect(spent.windows[0]?.usedPercent).toBe(100);
    expect(spent.ordinaryUsageAllowed).toBe(true);
    const room = copilotUserResponseToLimits({ response: proResponse, checkedAt });
    expect(room.ordinaryUsageAllowed).toBeUndefined();
  });

  it("falls back to the chat allowance when there is no premium entitlement", () => {
    const limits = copilotUserResponseToLimits({
      response: {
        login: "octocat",
        copilot_plan: "free",
        quota_reset_date_utc: "2026-12-01",
        quota_snapshots: {
          chat: quota({ entitlement: 50, remaining: 10, percent_remaining: 20, has_quota: true }),
          completions: quota({ entitlement: 2000, remaining: 2000 }),
          premium_interactions: quota({ entitlement: 0, remaining: 0, percent_remaining: 0 }),
        },
      },
      checkedAt,
    });
    expect(limits.windows).toEqual([
      {
        id: "chat",
        kind: "monthly",
        label: "Chat",
        usedPercent: 80,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
  });

  it("publishes no spent window for an unlimited quota", () => {
    const limits = copilotUserResponseToLimits({
      response: {
        ...proResponse,
        quota_snapshots: {
          ...proResponse.quota_snapshots,
          premium_interactions: quota({ unlimited: true, percent_remaining: 0 }),
        },
      },
      checkedAt,
    });
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([]);
  });

  it("does not publish a read for another account than the Copilot sign-in", () => {
    const limits = copilotUserResponseToLimits({
      response: proResponse,
      checkedAt,
      expectedLogin: "someone-else",
    });
    expect(limits.windows).toEqual([]);
    expect(limits.subscriptionKey).toBeUndefined();
    expect(limits.unavailable?.reason).toBe("unsupported");
  });

  it("reports no usage when the account has no quota", () => {
    for (const response of [
      { login: "octocat" },
      { login: "octocat", quota_snapshots: null },
      {
        login: "octocat",
        quota_snapshots: { premium_interactions: quota({}), chat: quota({}) },
      },
    ] satisfies ReadonlyArray<CopilotUserResponse>) {
      const limits = copilotUserResponseToLimits({ response, checkedAt });
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }
  });
});

describe("parseCopilotLastLoggedInUser", () => {
  it("reads the sign-in from a config file with comments", () => {
    const text = `// User settings belong in settings.json.
// This file is managed automatically.
{
  "firstLaunchAt": "2026-10-01T00:00:00.000Z",
  "loggedInUsers": [{ "host": "https://github.com", "login": "first" }],
  "lastLoggedInUser": {
    "host": "https://github.com",
    "login": "octocat"
  },
  "trustedFolders": ["/tmp",],
}`;
    expect(parseCopilotLastLoggedInUser(text)).toEqual({ host: "github.com", login: "octocat" });
    expect(parseCopilotLastLoggedInUser("{}")).toBeUndefined();
  });
});

describe("readCopilotUsageLimits", () => {
  const respond = (body: unknown, status = 200) =>
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      ),
    );

  it.effect("reads the Copilot CLI login's token from gh and checks the account", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-usage-" });
      yield* fileSystem.makeDirectory(`${home}/.copilot`);
      yield* fileSystem.writeFileString(
        `${home}/.copilot/config.json`,
        `// managed\n{ "lastLoggedInUser": { "host": "https://github.com", "login": "octocat" } }`,
      );
      const asked: string[] = [];
      const gh = (login: string | undefined) => {
        asked.push(login ?? "(active)");
        return Effect.succeed<CopilotGhTokenResult>({ _tag: "token", token: "test-token" });
      };
      const read = (body: unknown) =>
        readCopilotUsageLimits(
          { instanceEnvironment: {}, processEnvironment: { HOME: home } },
          gh,
        ).pipe(Effect.provideService(HttpClient.HttpClient, respond(body)));

      const matching = yield* read(proResponse);
      expect(asked).toEqual(["octocat"]);
      expect(matching.windows.map((window) => window.id)).toEqual(["premium_interactions"]);

      const other = yield* read({ ...proResponse, login: "someone-else" });
      expect(other.windows).toEqual([]);
      expect(other.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains when gh holds no login for the Copilot account", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-usage-" });
      yield* fileSystem.makeDirectory(`${home}/.copilot`);
      yield* fileSystem.writeFileString(
        `${home}/.copilot/config.json`,
        `{ "lastLoggedInUser": { "host": "https://github.com", "login": "octocat" } }`,
      );
      const limits = yield* readCopilotUsageLimits(
        { instanceEnvironment: {}, processEnvironment: { HOME: home } },
        () => Effect.succeed<CopilotGhTokenResult>({ _tag: "notSignedIn" }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond({}, 500)));
      expect(limits.unavailable).toEqual({
        reason: "unsupported",
        message: "Sign in to the GitHub CLI as octocat to read Copilot usage (gh auth login).",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses gh's active account when the Copilot CLI has no stored sign-in", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-usage-" });
      const asked: Array<string | undefined> = [];
      const limits = yield* readCopilotUsageLimits(
        { instanceEnvironment: {}, processEnvironment: { HOME: home } },
        (login) => {
          asked.push(login);
          return Effect.succeed<CopilotGhTokenResult>({ _tag: "token", token: "test-token" });
        },
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond(proResponse)));
      expect(asked).toEqual([undefined]);
      expect(limits.windows.map((window) => window.id)).toEqual(["premium_interactions"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a token the server's environment hands the Copilot CLI", () =>
    Effect.gen(function* () {
      const limits = yield* readCopilotUsageLimits(
        { instanceEnvironment: {}, processEnvironment: { HOME: "/none", GH_TOKEN: "test-token" } },
        () => Effect.die("gh must not run when the environment sets a token"),
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond(proResponse)));
      expect(limits.windows).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the instance's token and reports a failed request as a failed probe", () =>
    Effect.gen(function* () {
      const gh = () => Effect.die("gh must not run when the environment sets a token");
      const read = (client: HttpClient.HttpClient) =>
        readCopilotUsageLimits(
          {
            instanceEnvironment: { GH_TOKEN: "test-token" },
            processEnvironment: { HOME: "/none" },
          },
          gh,
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect((yield* read(respond(proResponse))).windows).toHaveLength(1);
      expect((yield* read(respond({}, 500))).unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Copilot signed-in login", () => {
  const respond = (body: unknown, status = 200) =>
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      ),
    );
  const writeConfig = (home: string, folder: string, login: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(`${home}/${folder}`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${home}/${folder}/config.json`,
        `// managed\n{ "lastLoggedInUser": { "host": "https://github.com", "login": "${login}" } }`,
      );
    });

  it("resolves the instance's COPILOT_HOME before the default folder", () => {
    const path = { join: (...segments: ReadonlyArray<string>) => segments.join("/") };
    expect(
      resolveCopilotHome({ instanceEnvironment: {}, processEnvironment: { HOME: "/h" } }, path),
    ).toBe("/h/.copilot");
    // An instance's value gets the same expansion the CLI's launch environment
    // gives it (mergeProviderInstanceEnvironment), whatever HOME says.
    expect(
      resolveCopilotHome(
        {
          instanceEnvironment: { COPILOT_HOME: "~/.copilot-work" },
          processEnvironment: { HOME: "/h", COPILOT_HOME: "/other" },
        },
        path,
      ),
    ).toBe(
      mergeProviderInstanceEnvironment(
        [{ name: "COPILOT_HOME", value: "~/.copilot-work", sensitive: false }],
        {},
      ).COPILOT_HOME,
    );
    expect(
      resolveCopilotHome(
        { instanceEnvironment: { COPILOT_HOME: "~" }, processEnvironment: { HOME: "/h" } },
        path,
      ),
    ).toBe(expandHomePath("~"));
    expect(
      resolveCopilotHome(
        {
          instanceEnvironment: { COPILOT_HOME: "/work/.copilot" },
          processEnvironment: { HOME: "/h", COPILOT_HOME: "/other" },
        },
        path,
      ),
    ).toBe("/work/.copilot");
    // A server-level value the merge passes through unexpanded resolves
    // against the HOME the CLI runs with.
    expect(
      resolveCopilotHome(
        { instanceEnvironment: {}, processEnvironment: { HOME: "/h", COPILOT_HOME: "~" } },
        path,
      ),
    ).toBe("/h");
    expect(
      resolveCopilotHome(
        {
          instanceEnvironment: {},
          processEnvironment: { HOME: "/h", COPILOT_HOME: "~\\.copilot-work" },
        },
        path,
      ),
    ).toBe("/h/.copilot-work");
    expect(
      resolveCopilotHome(
        { instanceEnvironment: {}, processEnvironment: { HOME: "/h", COPILOT_HOME: "/abs" } },
        path,
      ),
    ).toBe("/abs");
  });

  it("finds gh's sign-in file where gh does", () => {
    const path = { join: (...segments: ReadonlyArray<string>) => segments.join("/") };
    expect(resolveGhHostsFile({ HOME: "/h" }, path, "darwin")).toBe("/h/.config/gh/hosts.yml");
    expect(resolveGhHostsFile({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, path, "linux")).toBe(
      "/x/gh/hosts.yml",
    );
    expect(
      resolveGhHostsFile({ HOME: "/h", XDG_CONFIG_HOME: "/x", GH_CONFIG_DIR: "/g" }, path, "linux"),
    ).toBe("/g/hosts.yml");
    expect(resolveGhHostsFile({ HOME: "/h", APPDATA: "C:/AppData" }, path, "win32")).toBe(
      "C:/AppData/GitHub CLI/hosts.yml",
    );
  });

  it.effect("stamps gh's sign-in so a gh account switch changes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "copilot-gh-stamp-" });
      const input = {
        instanceEnvironment: {},
        processEnvironment: { HOME: dir, GH_CONFIG_DIR: dir },
      };
      expect(yield* readCopilotAccountStamp(input)).toBe("gh:none");
      yield* fs.writeFileString(`${dir}/hosts.yml`, "github.com:\n  user: octocat\n");
      const first = yield* readCopilotAccountStamp(input);
      yield* fs.writeFileString(
        `${dir}/hosts.yml`,
        "github.com:\n  user: hubot-the-second-account\n",
      );
      const second = yield* readCopilotAccountStamp(input);
      expect(first).not.toBe("gh:none");
      expect(second).not.toBe(first);
      // A token in the environment fixes the account for the instance's lifetime.
      expect(
        yield* readCopilotAccountStamp({
          instanceEnvironment: { COPILOT_GITHUB_TOKEN: "t" },
          processEnvironment: { HOME: dir, GH_CONFIG_DIR: dir },
        }),
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads each instance's login from its own COPILOT_HOME", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-login-" });
      yield* writeConfig(home, ".copilot", "personal");
      yield* writeConfig(home, ".copilot-work", "work-account");

      const first = yield* readCopilotSignedInLogin({
        instanceEnvironment: {},
        processEnvironment: { HOME: home },
      });
      const second = yield* readCopilotSignedInLogin({
        instanceEnvironment: { COPILOT_HOME: `${home}/.copilot-work` },
        processEnvironment: { HOME: home, COPILOT_HOME: `${home}/.copilot-work` },
      });
      const missing = yield* readCopilotSignedInLogin({
        instanceEnvironment: { COPILOT_HOME: `${home}/.copilot-none` },
        processEnvironment: { HOME: home },
      });
      expect(first).toEqual({ login: "personal", fromEnvironmentToken: false });
      expect(second).toEqual({ login: "work-account", fromEnvironmentToken: false });
      expect(missing).toEqual({ login: undefined, fromEnvironmentToken: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the login to the usage read when a token is in the environment", () =>
    Effect.gen(function* () {
      const input = {
        instanceEnvironment: { GH_TOKEN: "test-token" },
        processEnvironment: { HOME: "/none" },
      };
      expect(yield* readCopilotSignedInLogin(input)).toEqual({
        login: undefined,
        fromEnvironmentToken: true,
      });
      const reading = yield* readCopilotUsage(input, () =>
        Effect.die("gh must not run when the environment sets a token"),
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond(proResponse)));
      expect(reading.login).toBe("octocat");
      expect(reading.limits.windows).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the stored login when usage cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-login-" });
      yield* writeConfig(home, ".copilot", "octocat");
      const input = { instanceEnvironment: {}, processEnvironment: { HOME: home } };
      const missingGh = yield* readCopilotUsage(input, () =>
        Effect.succeed<CopilotGhTokenResult>({ _tag: "missing" }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond({}, 500)));
      expect(missingGh.login).toBe("octocat");
      const otherAccount = yield* readCopilotUsage(input, () =>
        Effect.succeed<CopilotGhTokenResult>({ _tag: "token", token: "test-token" }),
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respond({ ...proResponse, login: "someone-else" }),
        ),
      );
      expect(otherAccount.login).toBe("octocat");
      const failed = yield* readCopilotUsage(input, () =>
        Effect.succeed<CopilotGhTokenResult>({ _tag: "token", token: "test-token" }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, respond({}, 500)));
      expect(failed.login).toBe("octocat");
      expect(failed.limits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("makeCachedCopilotUsageLimits", () => {
  const counted = <A>(calls: Ref.Ref<number>, value: A) =>
    Ref.update(calls, (count) => count + 1).pipe(Effect.as(value));

  it.effect("caches a reading that carries a login", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cached = yield* makeCachedCopilotUsageLimits(
        counted(calls, { limits: { checkedAt, windows: [] }, login: "octocat" }),
      );
      expect((yield* cached.get("octocat")).login).toBe("octocat");
      yield* cached.get("octocat");
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reads afresh for another sign-in and never returns its reading", () =>
    Effect.gen(function* () {
      const login = yield* Ref.make("octocat");
      const read = Ref.get(login).pipe(
        Effect.map((current) => ({ limits: { checkedAt, windows: [] }, login: current })),
      );
      const cached = yield* makeCachedCopilotUsageLimits(read);
      expect((yield* cached.get("octocat")).login).toBe("octocat");
      yield* Ref.set(login, "hubot");
      expect((yield* cached.get("hubot")).login).toBe("hubot");
    }).pipe(Effect.scoped),
  );

  it.effect("reuses a reading without usage for a minute, then reads again", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cached = yield* makeCachedCopilotUsageLimits(
        counted(calls, {
          checkedAt,
          windows: [],
          unavailable: { reason: "unsupported" as const },
        }),
      );
      yield* cached.get("octocat");
      yield* cached.get("octocat");
      expect(yield* Ref.get(calls)).toBe(1);
      yield* TestClock.adjust(COPILOT_USAGE_UNAVAILABLE_TTL_MS);
      yield* cached.get("octocat");
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a reading with usage for its full lifetime", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cached = yield* makeCachedCopilotUsageLimits(
        counted(calls, { checkedAt, windows: [] }),
      );
      yield* cached.get("octocat");
      yield* TestClock.adjust(COPILOT_USAGE_UNAVAILABLE_TTL_MS);
      yield* cached.get("octocat");
      expect(yield* Ref.get(calls)).toBe(1);
      yield* TestClock.adjust(COPILOT_USAGE_CACHE_TTL_MS);
      yield* cached.get("octocat");
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("drops the cached reading on invalidation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cached = yield* makeCachedCopilotUsageLimits(
        counted(calls, { checkedAt, windows: [] }),
      );
      yield* cached.get("octocat");
      yield* cached.invalidate;
      yield* cached.get("octocat");
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes a read the caller stopped waiting for, and starts no second one", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const slow = Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Effect.sleep("15 seconds")),
        Effect.as({ checkedAt, windows: [] }),
      );
      const cached = yield* makeCachedCopilotUsageLimits(slow);
      const first = yield* cached
        .get("octocat")
        .pipe(Effect.timeoutOption("6 seconds"), Effect.forkChild);
      yield* TestClock.adjust("6 seconds");
      expect(Option.isNone(yield* Fiber.join(first))).toBe(true);
      // A check while the read still runs waits on it instead of starting another.
      const second = yield* cached
        .get("octocat")
        .pipe(Effect.timeoutOption("6 seconds"), Effect.forkChild);
      yield* TestClock.adjust("6 seconds");
      expect(Option.isNone(yield* Fiber.join(second))).toBe(true);
      expect(yield* Ref.get(calls)).toBe(1);
      yield* TestClock.adjust("6 seconds");
      // The read finished in the background and filled the cache.
      expect(yield* cached.get("octocat")).toEqual({ checkedAt, windows: [] });
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.scoped),
  );
  it.effect("frees the slot when a read dies, so the next check reads again", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const read = Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 1 ? Effect.die("boom") : Effect.succeed({ checkedAt, windows: [] }),
        ),
      );
      const cached = yield* makeCachedCopilotUsageLimits(read);
      const first = yield* cached.get("octocat").pipe(Effect.exit);
      expect(first._tag).toBe("Failure");
      // Not stuck waiting on the dead read: a new read runs and fills the cache.
      const second = yield* cached.get("octocat").pipe(Effect.timeoutOption("1 second"));
      expect(second).toEqual(Option.some({ checkedAt, windows: [] }));
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("never lets an older read replace a newer reading", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      // The first read (octocat) is slow; the second (hubot) is quick; any later one dies.
      const read = Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 1
            ? Effect.sleep("10 seconds").pipe(
                Effect.as({ limits: { checkedAt, windows: [] }, login: "octocat" }),
              )
            : count === 2
              ? Effect.sleep("1 second").pipe(
                  Effect.as({ limits: { checkedAt, windows: [] }, login: "hubot" }),
                )
              : Effect.die("must not read again"),
        ),
      );
      const cached = yield* makeCachedCopilotUsageLimits(read);
      const slow = yield* cached.get("octocat").pipe(Effect.forkChild);
      const fast = yield* cached.get("hubot").pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fast)).login).toBe("hubot");
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(slow)).login).toBe("octocat");
      // The newer reading stays; the older read finishing later does not evict it.
      expect((yield* cached.get("hubot")).login).toBe("hubot");
    }).pipe(Effect.scoped),
  );
});
