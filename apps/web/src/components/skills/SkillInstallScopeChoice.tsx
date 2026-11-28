/**
 * "Install for" above this machine's install buttons (1440): You, in every
 * project, or This project, chosen before Install is pressed. It starts on
 * the remembered default (project, then Percy, then the machine) and can make
 * the current choice that default. The machine view sets the machine default.
 */
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SkillInstallScope,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { useAtomValue } from "@effect/atom-react";

import { useTx } from "../../i18n";
import { useProject } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useMachineNickname } from "../../studio/machineNickname";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import type { SkillFolderScope } from "./SkillUpdate.logic";
import {
  OLDER_SERVER_NOTE,
  resolveSkillInstallScope,
  SCOPE_LABELS,
  SCOPE_WHERE,
  skillInstallScopeDefaultPatch,
  SOURCE_PHRASES,
  type ResolvedSkillInstallScope,
  useSkillInstallScopePick,
} from "./skillInstallScope.logic";

const SCOPES: ReadonlyArray<SkillInstallScope> = ["user", "project"];

export interface SkillInstallScopeState {
  /** Null on a server that cannot take a scope: installs there follow the view. */
  readonly scope: SkillInstallScope | null;
  readonly resolved: ResolvedSkillInstallScope;
  readonly choose: (scope: SkillInstallScope) => void;
  readonly supported: boolean;
}

/** The chosen scope for this machine and folder, starting on the remembered default. */
export function useSkillInstallScope(scope: SkillFolderScope): SkillInstallScopeState {
  const { environmentId, projectId } = scope;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const project = useProject({ environmentId, projectId });
  const settings = config?.settings;
  const resolved = resolveSkillInstallScope({
    userLevel: scope.userLevel === true,
    projectOverride: settings?.projectSettingsOverrides[projectId]?.skillInstallScope,
    personalAssistant: isPersonalAssistantProject(project),
    machineDefault: settings?.skillInstallScope ?? "project",
  });
  const supported = config?.environment.capabilities.skillInstallScope === true;
  const [picked, choose] = useSkillInstallScopePick(resolved.scope);
  const chosen = scope.userLevel === true ? "user" : picked;
  return {
    scope: supported ? chosen : null,
    resolved,
    supported,
    choose,
  };
}

export function SkillInstallScopeChoice({
  state,
  folder,
  ...scope
}: SkillFolderScope & {
  readonly state: SkillInstallScopeState;
  /** The project folder "This project" writes to. */
  readonly folder: string | null;
}) {
  const tx = useTx();
  const { environmentId, projectId } = scope;
  const machine = useMachineNickname(environmentId) || tx("this machine");
  const canSave = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const update = useUpdateEnvironmentSettings(environmentId as EnvironmentId);
  const settings = config?.settings;

  if (!state.supported)
    return (
      <p className="text-xs text-muted-foreground" data-testid="skill-install-scope-older">
        {tx(OLDER_SERVER_NOTE, { machine })}
      </p>
    );

  const save = (level: "project" | "machine", value: SkillInstallScope | null) => {
    if (!settings) return;
    update(
      skillInstallScopeDefaultPatch({
        level,
        scope: value,
        projectId,
        settings,
        perKey: config?.environment.capabilities.projectSettingsOverrideChanges === true,
      }),
    );
  };

  if (scope.userLevel === true) {
    // The machine view installs for you; here the machine's default for projects is set.
    const machineDefault = settings?.skillInstallScope ?? "project";
    return (
      <section
        className="space-y-1.5 rounded-lg border px-3 py-2.5 text-xs"
        aria-label={tx("Where skills install")}
        data-testid="skill-install-scope"
        data-scope="user"
      >
        <p className="text-foreground">
          {tx("Skills installed here go to you, in every project on {machine}.", { machine })}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-muted-foreground">{tx("When a project is open, install for")}</span>
          <RadioGroup
            className="flex-row flex-wrap"
            aria-label={tx("Default for projects on {machine}", { machine })}
            value={machineDefault}
            disabled={!canSave || !settings}
            onValueChange={(value) => save("machine", value as SkillInstallScope)}
          >
            {SCOPES.map((value) => (
              <label key={value} className="flex cursor-pointer items-center gap-1.5">
                <Radio value={value} />
                <span>{tx(SCOPE_LABELS[value])}</span>
              </label>
            ))}
          </RadioGroup>
        </div>
        <p className="text-muted-foreground">
          {tx("A project can choose its own in its Skills view. Percy installs for you.")}
        </p>
      </section>
    );
  }

  const chosen = state.scope ?? state.resolved.scope;
  const projectOwn = settings?.projectSettingsOverrides[projectId]?.skillInstallScope;
  const machineDefault = settings?.skillInstallScope ?? "project";
  return (
    <section
      className="space-y-2 rounded-lg border px-3 py-2.5 text-xs"
      aria-label={tx("Install for")}
      data-testid="skill-install-scope"
      data-scope={chosen}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <span className="pt-0.5 font-medium text-foreground">{tx("Install for")}</span>
        <RadioGroup
          className="flex-row flex-wrap"
          aria-label={tx("Install for")}
          value={chosen}
          onValueChange={(value) => state.choose(value as SkillInstallScope)}
        >
          {SCOPES.map((value) => (
            <label
              key={value}
              className="flex max-w-80 cursor-pointer items-start gap-1.5"
              data-testid={`skill-install-scope-${value}`}
            >
              <Radio value={value} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-foreground">{tx(SCOPE_LABELS[value])}</span>
                <span className="block break-words text-muted-foreground">
                  {tx(SCOPE_WHERE[value], { machine, folder: folder ?? tx("the project folder") })}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span>
          {chosen === state.resolved.scope
            ? tx(SOURCE_PHRASES[state.resolved.source], { machine })
            : tx("This install only.")}
        </span>
        {canSave && settings ? (
          <>
            {projectOwn !== chosen ? (
              <Button
                size="xs"
                variant="link"
                type="button"
                onClick={() => save("project", chosen)}
              >
                {tx("Make this the default for this project")}
              </Button>
            ) : null}
            {machineDefault !== chosen ? (
              <Button
                size="xs"
                variant="link"
                type="button"
                onClick={() => save("machine", chosen)}
              >
                {tx("Make this the default for every project on {machine}", { machine })}
              </Button>
            ) : null}
            {projectOwn !== undefined ? (
              <Button size="xs" variant="link" type="button" onClick={() => save("project", null)}>
                {tx("Follow {machine}'s default", { machine })}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** The project folder "This project" writes to, as the Skills view shows it. */
export function useSkillProjectFolder(scope: SkillFolderScope): string | null {
  const project = useProject({ environmentId: scope.environmentId, projectId: scope.projectId });
  return scope.cwd ?? project?.workspaceRoot ?? null;
}
