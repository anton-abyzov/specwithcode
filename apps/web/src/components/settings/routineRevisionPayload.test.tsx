/**
 * What Settings > Routines sends when a person turns a routine on or off, or
 * deletes one or all finished ones: the revision the row showed, so the
 * routine's runner refuses a change made against a copy that went stale.
 */
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
} from "@specweave-studio/contracts";

const mock = vi.hoisted(() => ({
  sent: [] as Array<{ command: string; value: unknown }>,
  tasks: [] as ReadonlyArray<unknown>,
}));
const pass = vi.hoisted(() => (props: { children?: ReactNode }) => props.children ?? null);

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@tanstack/react-router", () => ({ Link: pass }));
vi.mock("../../i18n", () => ({ useTx: () => (text: string) => text }));
vi.mock("../../i18n/rich", () => ({ renderRich: (text: string) => text }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: () => Promise.resolve(true) }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mock.tasks }, error: null, refresh: () => {} }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../providerInstances", () => ({
  applyProviderInstanceSettings: () => [],
  deriveProviderInstanceEntries: () => [],
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    upsertScheduledTask: { permissionAtom: () => null },
    providersValueAtom: () => null,
    scheduledTasksLive: () => null,
    setScheduledTaskEnabled: "setScheduledTaskEnabled",
    runScheduledTaskNow: "runScheduledTaskNow",
    deleteScheduledTask: "deleteScheduledTask",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (value: unknown) => {
    mock.sent.push({ command, value });
    return Promise.resolve({ _tag: "Success" });
  },
}));
vi.mock("../../teamRules/useTeamRules", () => ({ useTeamRules: () => ({ summary: null }) }));
vi.mock("../../teamRules/teamRulesView", () => ({ teamRulesReachLock: () => null }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../ui/badge", () => ({ Badge: pass }));
vi.mock("../ui/label", () => ({ Label: pass }));
vi.mock("../ui/dialog", () => ({
  Dialog: pass,
  DialogDescription: pass,
  DialogFooter: pass,
  DialogHeader: pass,
  DialogPanel: pass,
  DialogPopup: pass,
  DialogTitle: pass,
}));
vi.mock("../ui/input-group", () => ({
  InputGroup: pass,
  InputGroupAddon: () => null,
  InputGroupInput: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: () => null,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("../ui/toast", () => ({ stackedThreadToast: () => ({}), toastManager: { add: () => {} } }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: pass,
  MenuPopup: pass,
  MenuSeparator: () => null,
  MenuTrigger: () => null,
  MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button data-menu-item onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/switch", () => ({
  Switch: (props: { onCheckedChange?: () => void }) => (
    <button data-switch onClick={props.onCheckedChange} />
  ),
}));
vi.mock("./ArchivedDisclosure", () => ({ ArchivedDisclosure: pass }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: { kind: "global" } }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control, children }: { control?: ReactNode; children?: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  ),
  SettingsSection: pass,
  TeamRulesLabel: pass,
  useRelativeTimeTick: () => {},
}));
vi.mock("./scheduledTasksSettings.logic", async (original) => ({
  ...(await original<typeof import("./scheduledTasksSettings.logic")>()),
  matchesScheduledTaskScope: () => true,
}));

import { RoutineList } from "./RoutineList";
import { ScheduledTaskRow } from "./ScheduledTaskRow";

const environmentId = EnvironmentId.make("machine-a");

function task(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: ScheduledTaskId.make(id),
    title: id,
    prompt: `Prompt for ${id}`,
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("app"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    ...overrides,
  };
}

let rendered: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => rendered?.unmount());
  rendered = null;
  mock.sent.length = 0;
  mock.tasks = [];
});

const click = async (
  find: (root: ReactTestRenderer["root"]) => { props: { onClick?: () => void } },
) => {
  await act(async () => {
    find(rendered!.root).props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("Settings > Routines commands", () => {
  it("turns a routine off against the revision its row showed", async () => {
    act(() => {
      rendered = create(
        <ScheduledTaskRow
          environmentId={environmentId}
          task={task("daily", { revision: 7 })}
          onEdit={() => {}}
        />,
      );
    });
    await click((root) => root.findByProps({ "data-switch": true }));
    expect(mock.sent).toEqual([
      {
        command: "setScheduledTaskEnabled",
        value: { environmentId, input: { id: "daily", enabled: false, expectedRevision: 7 } },
      },
    ]);
  });

  it("names the definition its row showed, on a machine that only keeps a copy", async () => {
    act(() => {
      rendered = create(
        <ScheduledTaskRow
          environmentId={environmentId}
          task={task("daily", { revision: 7, definitionHash: "seen" })}
          onEdit={() => {}}
        />,
      );
    });
    await click((root) => root.findByProps({ "data-switch": true }));
    expect(mock.sent).toEqual([
      {
        command: "setScheduledTaskEnabled",
        value: {
          environmentId,
          input: { id: "daily", enabled: false, expectedRevision: 7, expectedDefinition: "seen" },
        },
      },
    ]);
  });

  it("deletes a routine against the revision its row showed", async () => {
    act(() => {
      rendered = create(
        <ScheduledTaskRow
          environmentId={environmentId}
          task={task("daily", { revision: 7 })}
          onEdit={() => {}}
        />,
      );
    });
    await click((root) => root.findAllByProps({ "data-menu-item": true }).at(-1)!);
    expect(mock.sent).toEqual([
      {
        command: "deleteScheduledTask",
        value: { environmentId, input: { id: "daily", expectedRevision: 7 } },
      },
    ]);
  });

  it("deletes every finished routine against the revision each row showed", async () => {
    const finished = {
      enabled: false,
      schedule: { type: "once", at: "2026-10-02T00:00:00.000Z" },
      lastRunAt: "2026-10-02T00:00:00.000Z",
      lastRunStatus: "succeeded",
    } satisfies Partial<ScheduledTask>;
    mock.tasks = [
      task("first", { ...finished, revision: 3 }),
      task("second", { ...finished, revision: 5 }),
    ];
    await act(async () => {
      rendered = create(
        <RoutineList
          environments={[
            {
              environmentId,
              label: "Machine A",
              connection: { phase: "connected" },
              serverConfig: { environment: { platform: { os: "darwin" } } },
            } as never,
          ]}
          linkedEnvironmentId={undefined}
          taskId={undefined}
          onEdit={() => {}}
        />,
      );
      await Promise.resolve();
    });
    await click((root) => root.findByProps({ "data-routine-delete-finished": true }));
    expect(mock.sent.filter((entry) => entry.command === "deleteScheduledTask")).toEqual([
      {
        command: "deleteScheduledTask",
        value: { environmentId, input: { id: "first", expectedRevision: 3 } },
      },
      {
        command: "deleteScheduledTask",
        value: { environmentId, input: { id: "second", expectedRevision: 5 } },
      },
    ]);
  });
});
