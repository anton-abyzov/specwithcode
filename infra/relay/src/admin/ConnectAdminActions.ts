/**
 * What an owner can change from the Connect admin page: one account's machine
 * limit, one machine's link, one phone. Every action writes its record first;
 * an action whose record cannot be written does not run.
 */
import { RelayApi } from "@specweave-studio/contracts/relay";
import {
  RELAY_ADMIN_ACTIONS_PAGE_SIZE,
  RelayAdminAccountNotFoundError,
  type RelayAdminAction,
  RelayAdminActionKind,
  RelayAdminActionOutcome,
  RelayAdminMachineLimit,
  RelayAdminMachineLimitSetting,
  RelayAdminPrincipal,
  RelayAdminTargetNotFoundError,
} from "@specweave-studio/contracts/relayAdmin";
import { desc, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { unlinkEnvironmentRecord } from "../environments/EnvironmentUnlink.ts";
import * as PhoneRemovalApi from "../http/PhoneRemovalApi.ts";
import { relayAdminActions, relayManagedTunnelLimits } from "../persistence/schema.ts";
import { unavailable } from "./ConnectAdmin.ts";
import * as ConnectAdminQueries from "./ConnectAdminQueries.ts";

export class ConnectAdminActionLogError extends Schema.TaggedError<ConnectAdminActionLogError>()(
  "ConnectAdminActionLogError",
  {
    operation: Schema.Literals(["begin", "finish", "set-machine-limit", "list"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Connect admin action record '${this.operation}' failed`;
  }
}

export class ConnectAdminActionLog extends Context.Service<
  ConnectAdminActionLog,
  {
    /** Records an action about to run, as "started". Returns the record's id. */
    readonly begin: (input: {
      readonly ownerUserId: string;
      readonly action: Exclude<RelayAdminActionKind, "set_machine_limit">;
      readonly targetUserId: string;
      readonly targetId: string;
      readonly targetLabel: string;
    }) => Effect.Effect<string, ConnectAdminActionLogError>;
    readonly finish: (
      id: string,
      outcome: Exclude<RelayAdminActionOutcome, "started">,
    ) => Effect.Effect<void, ConnectAdminActionLogError>;
    /**
     * Writes the record and the limit in one D1 batch: both, or neither. The
     * account's next link is checked against the new limit; nothing is unlinked.
     */
    readonly setMachineLimit: (input: {
      readonly ownerUserId: string;
      readonly targetUserId: string;
      readonly before: RelayAdminMachineLimit;
      readonly setting: RelayAdminMachineLimitSetting;
    }) => Effect.Effect<void, ConnectAdminActionLogError>;
    /** The newest records first. */
    readonly list: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<RelayAdminAction>, ConnectAdminActionLogError>;
  }
>()("studio-relay/admin/ConnectAdminActions/ConnectAdminActionLog") {}

const toJson = (value: unknown): string => JSON.stringify(value);

const fromJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const decodeLimit = Schema.decodeUnknownOption(RelayAdminMachineLimit);
const decodeSetting = Schema.decodeUnknownOption(RelayAdminMachineLimitSetting);
const decodeKind = Schema.decodeUnknownOption(RelayAdminActionKind);
const decodeOutcome = Schema.decodeUnknownOption(RelayAdminActionOutcome);

/** A stored row as the page reads it. A row this code cannot read is left out. */
const toAction = (row: typeof relayAdminActions.$inferSelect): ReadonlyArray<RelayAdminAction> => {
  const action = decodeKind(row.action);
  const outcome = decodeOutcome(row.outcome);
  if (Option.isNone(action) || Option.isNone(outcome)) return [];
  const isLimit = action.value === "set_machine_limit";
  return [
    {
      id: row.id,
      ownerUserId: row.ownerUserId,
      action: action.value,
      targetUserId: row.targetUserId,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      limitBefore: isLimit ? Option.getOrNull(decodeLimit(fromJson(row.beforeJson))) : null,
      limitSet: isLimit ? Option.getOrNull(decodeSetting(fromJson(row.afterJson))) : null,
      outcome: outcome.value,
      createdAt: row.createdAt,
    },
  ];
};

export const makeLog = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const fail = (operation: ConnectAdminActionLogError["operation"]) => (cause: unknown) =>
    new ConnectAdminActionLogError({ operation, cause });

  return ConnectAdminActionLog.of({
    begin: Effect.fn("relay.admin.actions.begin")(function* (input) {
      const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(fail("begin")));
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .insert(relayAdminActions)
        .values({
          id,
          ownerUserId: input.ownerUserId,
          action: input.action,
          targetUserId: input.targetUserId,
          targetId: input.targetId,
          targetLabel: input.targetLabel,
          beforeJson: null,
          afterJson: null,
          outcome: "started",
          createdAt: now,
        })
        .pipe(Effect.mapError(fail("begin")));
      return id;
    }),
    finish: Effect.fn("relay.admin.actions.finish")(function* (id, outcome) {
      yield* db
        .update(relayAdminActions)
        .set({ outcome })
        .where(eq(relayAdminActions.id, id))
        .pipe(Effect.mapError(fail("finish")));
    }),
    setMachineLimit: Effect.fn("relay.admin.actions.setMachineLimit")(function* (input) {
      const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(fail("set-machine-limit")));
      const now = DateTime.formatIso(yield* DateTime.now);
      const record = db.insert(relayAdminActions).values({
        id,
        ownerUserId: input.ownerUserId,
        action: "set_machine_limit",
        targetUserId: input.targetUserId,
        targetId: null,
        targetLabel: null,
        beforeJson: toJson(input.before),
        afterJson: toJson(input.setting),
        outcome: "done",
        createdAt: now,
      });
      const { setting } = input;
      const change =
        setting.kind === "default"
          ? db
              .delete(relayManagedTunnelLimits)
              .where(eq(relayManagedTunnelLimits.userId, input.targetUserId))
          : db
              .insert(relayManagedTunnelLimits)
              .values({
                userId: input.targetUserId,
                maxTunnels: setting.kind === "limited" ? setting.maxMachines : 0,
                unlimited: setting.kind === "unlimited",
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: relayManagedTunnelLimits.userId,
                set: {
                  maxTunnels: setting.kind === "limited" ? setting.maxMachines : 0,
                  unlimited: setting.kind === "unlimited",
                  updatedAt: now,
                },
              });
      yield* RelayDb.batch(db, [record, change]).pipe(Effect.mapError(fail("set-machine-limit")));
    }),
    list: Effect.fn("relay.admin.actions.list")(function* (limit) {
      const rows = yield* db
        .select()
        .from(relayAdminActions)
        .orderBy(desc(relayAdminActions.createdAt), desc(relayAdminActions.id))
        .limit(limit)
        .pipe(Effect.mapError(fail("list")));
      return rows.flatMap(toAction);
    }),
  });
});

export const layerLog = Layer.effect(ConnectAdminActionLog, makeLog);

export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "adminActions",
  Effect.fnUntraced(function* (handlers) {
    const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
    const log = yield* ConnectAdminActionLog;
    const config = yield* RelayConfiguration.RelayConfiguration;

    /** The account with its machines and phones, or the 404 the page tells apart. */
    const accountOf = Effect.fnUntraced(function* (userId: string) {
      const found = yield* queries
        .account(userId)
        .pipe(Effect.catch(() => unavailable("persistence_failed")));
      if (found === null) {
        return yield* new RelayAdminAccountNotFoundError({ code: "account_not_found" });
      }
      return found;
    });

    /**
     * Records the action, runs it, and records how it ended. Without the first
     * record nothing runs. A failure part way is recorded and answered 503;
     * the action is safe to send again.
     */
    const recorded = Effect.fnUntraced(function* <A, E, R>(
      record: Parameters<ConnectAdminActionLog["Service"]["begin"]>[0],
      run: Effect.Effect<A, E, R>,
    ) {
      const id = yield* log.begin(record).pipe(Effect.catch(() => unavailable("record_failed")));
      const ran = yield* Effect.exit(run);
      yield* log.finish(id, Exit.isSuccess(ran) ? "done" : "failed").pipe(
        Effect.catch(() =>
          Effect.logWarning("Connect admin could not record how an action ended", {
            action: record.action,
            recordId: id,
          }),
        ),
      );
      if (Exit.isFailure(ran)) {
        yield* Effect.logWarning("Connect admin action failed", {
          action: record.action,
          recordId: id,
        });
        return yield* unavailable("action_failed");
      }
      return ran.value;
    });

    return handlers
      .handle(
        "listActions",
        Effect.fn("relay.api.admin.listActions")(function* () {
          return {
            actions: yield* log
              .list(RELAY_ADMIN_ACTIONS_PAGE_SIZE)
              .pipe(Effect.catch(() => unavailable("persistence_failed"))),
          };
        }),
      )
      .handle(
        "setMachineLimit",
        Effect.fn("relay.api.admin.setMachineLimit")(function* ({ params, payload }) {
          const { userId: ownerUserId } = yield* RelayAdminPrincipal;
          const found = yield* accountOf(params.userId);
          yield* log
            .setMachineLimit({
              ownerUserId,
              targetUserId: params.userId,
              before: found.account.limit,
              setting: payload.limit,
            })
            .pipe(Effect.catch(() => unavailable("record_failed")));
          return { limit: (yield* accountOf(params.userId)).account.limit };
        }),
      )
      .handle(
        "unlinkMachine",
        Effect.fn("relay.api.admin.unlinkMachine")(function* ({ params }) {
          const { userId: ownerUserId } = yield* RelayAdminPrincipal;
          const found = yield* accountOf(params.userId);
          const machine = found.machines.find(
            (candidate) =>
              candidate.environmentId === params.environmentId && candidate.unlinkedAt === null,
          );
          if (machine === undefined) {
            return yield* new RelayAdminTargetNotFoundError({
              code: "target_not_found",
              target: "machine",
            });
          }
          const unlinked = yield* recorded(
            {
              ownerUserId,
              action: "unlink_machine",
              targetUserId: params.userId,
              targetId: machine.environmentId,
              targetLabel: machine.label,
            },
            // The account's own unlink: link and credentials revoked, tunnel released.
            unlinkEnvironmentRecord({
              userId: params.userId,
              environmentId: machine.environmentId,
              managedEndpointNamespace: config.managedEndpointNamespace,
            }),
          );
          return { unlinked };
        }),
      )
      .handle(
        "removePhone",
        Effect.fn("relay.api.admin.removePhone")(function* ({ params }) {
          const { userId: ownerUserId } = yield* RelayAdminPrincipal;
          const found = yield* accountOf(params.userId);
          const phone = found.phones.find((candidate) => candidate.deviceId === params.deviceId);
          if (phone === undefined) {
            return yield* new RelayAdminTargetNotFoundError({
              code: "target_not_found",
              target: "phone",
            });
          }
          const result = yield* recorded(
            {
              ownerUserId,
              action: "remove_phone",
              targetUserId: params.userId,
              targetId: phone.deviceId,
              targetLabel: phone.label,
            },
            // The account's own "Remove phone".
            PhoneRemovalApi.removePhone({ userId: params.userId, deviceId: phone.deviceId }),
          );
          return { removed: result.removed };
        }),
      );
  }),
);
