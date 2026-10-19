import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./cursorUsageLimits.ts";

const withNodeServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it("adds the billing-cycle length to monthly windows", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleStart: "1787284386000",
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 10 },
      },
      checkedAt,
      { isMerged: false, planInfo: { includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY" } },
    );
    expect(limits.windows).toEqual([
      {
        id: "totalPercentUsed",
        kind: "monthly",
        label: "Overall",
        usedPercent: 10,
        resetsAt: "2026-09-20T03:53:06.000Z",
        windowDurationMins: 43200,
      },
    ]);
  });

  it("shows one weekly included pool for X Subscription accounts", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleStart: "1787284386000",
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 37.5, autoPercentUsed: 20, apiPercentUsed: 90 },
      },
      checkedAt,
      {
        isMerged: true,
        planInfo: {
          includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY",
          includedUsageResetsAt: "1789000000000",
        },
      },
    );
    expect(limits.windows).toEqual([
      {
        id: "includedPool",
        kind: "weekly",
        label: "Included usage",
        usedPercent: 37.5,
        resetsAt: "2026-09-10T00:26:40.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("keeps the legacy pools but resets them weekly when only the period is weekly", () => {
    const limits = cursorUsageResponseToLimits(
      { planUsage: { autoPercentUsed: 20, apiPercentUsed: 90 } },
      checkedAt,
      { planInfo: { includedUsagePeriod: 2, includedUsageResetsAt: 1789000000000 } },
    );
    expect(
      limits.windows.map((window) => [window.id, window.kind, window.resetsAt]).toSorted(),
    ).toEqual([
      ["apiPercentUsed", "weekly", "2026-09-10T00:26:40.000Z"],
      ["autoPercentUsed", "weekly", "2026-09-10T00:26:40.000Z"],
    ]);
  });

  it("treats a weekly period as weekly even without a reset date", () => {
    const limits = cursorUsageResponseToLimits(
      { billingCycleEnd: "1789876386000", planUsage: { totalPercentUsed: 12 } },
      checkedAt,
      { isMerged: true, planInfo: { includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY" } },
    );
    expect(limits.windows).toEqual([
      {
        id: "includedPool",
        kind: "weekly",
        label: "Included usage",
        usedPercent: 12,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("keeps the split pools for an enterprise plan flagged as merged", () => {
    const limits = cursorUsageResponseToLimits(
      { planUsage: { autoPercentUsed: 20, apiPercentUsed: 90 } },
      checkedAt,
      { isMerged: true, planInfo: { planName: "Enterprise" } },
    );
    expect(limits.windows.map((window) => window.id).toSorted()).toEqual([
      "apiPercentUsed",
      "autoPercentUsed",
    ]);
  });

  it.effect("asks for plan details and keeps the monthly view when they are unavailable", () =>
    Effect.gen(function* () {
      const legacy = [
        ["autoPercentUsed", "monthly"],
        ["totalPercentUsed", "monthly"],
      ];
      for (const [planInfo, expected] of [
        [new Response("unknown method", { status: 404 }), legacy],
        [Response.json({ isMerged: "yes" }), legacy],
        [
          Response.json({
            isMerged: true,
            planInfo: {
              includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY",
              includedUsageResetsAt: "1789000000000",
            },
          }),
          [["includedPool", "weekly"]],
        ],
      ] as const) {
        const requested: string[] = [];
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "token" }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requested.push(request.url);
                expect(request.headers.authorization).toBe("Bearer token");
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    request.url.endsWith("/GetPlanInfo")
                      ? planInfo
                      : Response.json({
                          billingCycleEnd: "1789876386000",
                          planUsage: { totalPercentUsed: 50, autoPercentUsed: 40 },
                        }),
                  ),
                );
              }),
            ),
          ),
        );
        expect(requested.toSorted()).toEqual([
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
        ]);
        expect(limits.windows.map((window) => [window.id, window.kind]).toSorted()).toEqual(
          expected,
        );
      }
    }),
  );

  it.effect("reads the instance's credentials and endpoint even when usage enabled is false", () =>
    Effect.gen(function* () {
      yield* withNodeServices(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(directory, "cursor"));
          yield* fs.writeFileString(
            path.join(directory, "cursor", "auth.json"),
            '{"accessToken":"instance-token"}',
          );
          const client = HttpClient.make((request) => {
            expect([
              "https://cursor.example/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
              "https://cursor.example/aiserver.v1.DashboardService/GetPlanInfo",
            ]).toContain(request.url);
            expect(request.method).toBe("POST");
            expect(request.headers.authorization).toBe("Bearer instance-token");
            expect(request.headers["connect-protocol-version"]).toBe("1");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ enabled: false, planUsage: { totalPercentUsed: 42 } }),
              ),
            );
          });
          yield* fs.makeDirectory(path.join(directory, ".cursor"));
          yield* fs.writeFileString(
            path.join(directory, ".cursor", "auth.json"),
            '{"accessToken":"instance-token"}',
          );
          for (const platform of ["linux", "darwin"] as const) {
            const limits = yield* readCursorUsageLimits(
              { apiEndpoint: "https://cursor.example/" },
              { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
            ).pipe(
              Effect.provideService(HostProcessPlatform, platform),
              Effect.provideService(HttpClient.HttpClient, client),
            );
            expect(limits.windows[0]?.usedPercent).toBe(42);
          }
        }).pipe(Effect.scoped),
      );
    }),
  );

  it.effect(
    "never reads stale files for keychain or memory logins, but accepts an explicit auth token",
    () =>
      Effect.gen(function* () {
        for (const platform of ["linux", "darwin"] as const) {
          for (const token of [undefined, "explicit-token"]) {
            const limits = yield* withNodeServices(
              readCursorUsageLimits(
                { apiEndpoint: "" },
                {
                  AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
                  ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
                },
                false,
                async () => {
                  throw new Error("must not read Keychain before opt-in");
                },
              ).pipe(
                Effect.provideService(HostProcessPlatform, platform),
                Effect.provideService(
                  FileSystem.FileSystem,
                  FileSystem.makeNoop({
                    readFileString: () => Effect.die("must not read an unrelated credential file"),
                  }),
                ),
                Effect.provideService(
                  HttpClient.HttpClient,
                  HttpClient.make((request) => {
                    expect(token).toBe("explicit-token");
                    expect(request.headers.authorization).toBe("Bearer explicit-token");
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        Response.json({ planUsage: { totalPercentUsed: 10 } }),
                      ),
                    );
                  }),
                ),
              ),
            );
            if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
            else expect(limits.unavailable?.reason).toBe("unsupported");
          }
        }
      }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "private-token" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("private response", { status: 401 }),
                ),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("does not use a stored login for an explicit API key", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "different-account" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request usage")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("reads the default macOS Cursor login from Keychain for limits", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true, async () => "keychain-token").pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => Effect.die("must not read a stale credential file"),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.headers.authorization).toBe("Bearer keychain-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 42 } }),
                ),
              );
            }),
          ),
        ),
      );
      expect(limits.windows[0]?.usedPercent).toBe(42);
    }),
  );

  it.effect("reports a Keychain initialization failure without failing the provider refresh", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true, async () => {
          throw new Error("Keychain initialization failed");
        }).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request limits without a login")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("does not read Keychain or send its token to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", {}],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000" }],
        ["https://cursor-proxy.example", {}],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example" }],
      ] as const) {
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint }, environment, true, async () => {
            throw new Error("must not read Keychain for a custom endpoint");
          }).pipe(
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not send a Keychain credential to a proxy")),
            ),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
  const usageClient = (loginEmail: string | undefined, requested: string[] = []) =>
    HttpClient.make((request) => {
      requested.push(request.url);
      const body = request.url.endsWith("/GetEmail")
        ? Response.json(loginEmail === undefined ? {} : { email: loginEmail })
        : request.url.endsWith("/GetPlanInfo")
          ? Response.json({})
          : Response.json({ planUsage: { totalPercentUsed: 25 } });
      return Effect.succeed(HttpClientResponse.fromWeb(request, body));
    });

  it.effect("shows a signed-in instance's limits only when the CLI login is the same account", () =>
    Effect.gen(function* () {
      for (const [instanceEmail, loginEmail, shown] of [
        ["Alice@Example.com", "alice@example.com", true],
        ["alice@example.com", "bob@example.com", false],
        ["alice@example.com", undefined, false],
        [undefined, "alice@example.com", false],
      ] as const) {
        const requested: string[] = [];
        const limits = yield* withNodeServices(
          readCursorUsageLimits(
            { apiEndpoint: "" },
            { CURSOR_AUTH_TOKEN: "cli-token" },
            false,
            undefined,
            { email: instanceEmail },
          ).pipe(Effect.provideService(HttpClient.HttpClient, usageClient(loginEmail, requested))),
        );
        expect(limits.windows.length > 0).toBe(shown);
        if (!shown) {
          expect(limits.unavailable?.reason).toBe("unsupported");
          expect(requested.some((url) => url.endsWith("/GetCurrentPeriodUsage"))).toBe(false);
        }
        if (instanceEmail !== undefined) {
          expect(requested[0]).toBe("https://api2.cursor.sh/aiserver.v1.AuthService/GetEmail");
        }
        if (instanceEmail !== undefined && !shown) {
          expect(limits.unavailable?.message).toContain(
            loginEmail === undefined ? "Could not confirm" : "not the account",
          );
        }
      }
    }),
  );

  it.effect("skips the account check for a configured token without an instance sign-in", () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "token" }).pipe(
          Effect.provideService(HttpClient.HttpClient, usageClient(undefined, requested)),
        ),
      );
      expect(limits.windows[0]?.usedPercent).toBe(25);
      expect(requested.some((url) => url.endsWith("/GetEmail"))).toBe(false);
    }),
  );

  it.live(
    "keeps the monthly view when plan details never arrive",
    () =>
      Effect.gen(function* () {
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "token" }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                request.url.endsWith("/GetPlanInfo")
                  ? Effect.never
                  : Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        Response.json({ planUsage: { totalPercentUsed: 30 } }),
                      ),
                    ),
              ),
            ),
          ),
        );
        expect(limits.windows.map((window) => [window.id, window.kind])).toEqual([
          ["totalPercentUsed", "monthly"],
        ]);
      }),
    10_000,
  );
});
