/**
 * The Advisor row of the composer's options menu: whether this thread may
 * consult a stronger model. Follow project uses the project's setting (shown
 * beside it); On and Off are the thread's own choice.
 */
import type {
  AdvisorSettings,
  ScopedThreadRef,
  ThreadAdvisorMode,
} from "@specweave-studio/contracts";
import { threadAdvisorState } from "@specweave-studio/shared/advisor";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";

import { useTx } from "../../i18n";
import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadAdvisorMenuVisible } from "./threadAdvisorAvailability";
import { MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator as MenuDivider } from "../ui/menu";

export type ThreadAdvisorChoice = "follow" | ThreadAdvisorMode;

export const THREAD_ADVISOR_CHOICES: ReadonlyArray<ThreadAdvisorChoice> = ["follow", "on", "off"];

/** The radio value for a thread's stored mode; null and absent follow the project. */
export function threadAdvisorChoice(
  mode: ThreadAdvisorMode | null | undefined,
): ThreadAdvisorChoice {
  return mode === "on" || mode === "off" ? mode : "follow";
}

/** The mode a choice writes with thread.advisor-mode.set. */
export function threadAdvisorModeForChoice(choice: ThreadAdvisorChoice): ThreadAdvisorMode | null {
  return choice === "follow" ? null : choice;
}

export { threadAdvisorMenuVisible };

export interface ThreadAdvisorMenuState {
  readonly choice: ThreadAdvisorChoice;
  /** Whether the thread may consult, after its own choice. */
  readonly enabled: boolean;
  /** The project's setting, which Follow project uses. */
  readonly projectEnabled: boolean;
}

export function threadAdvisorMenuState(
  mode: ThreadAdvisorMode | null | undefined,
  projectSettings: Pick<AdvisorSettings, "enabled">,
): ThreadAdvisorMenuState {
  return {
    choice: threadAdvisorChoice(mode),
    enabled: threadAdvisorState(mode, projectSettings).enabled,
    projectEnabled: projectSettings.enabled,
  };
}

/** The three choices, for a thread whose state is already read. */
export function ThreadAdvisorMenuItems(props: {
  readonly state: ThreadAdvisorMenuState;
  readonly separated: boolean;
  readonly onChoose: (mode: ThreadAdvisorMode | null) => void;
}) {
  const tx = useTx();
  const { state } = props;
  const labels: Record<ThreadAdvisorChoice, string> = {
    follow: state.projectEnabled ? tx("Follow project (on)") : tx("Follow project (off)"),
    on: tx("On"),
    off: tx("Off"),
  };
  return (
    <div data-thread-advisor-menu={state.enabled ? "on" : "off"}>
      {props.separated ? <MenuDivider /> : null}
      <MenuGroup>
        <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
          {tx("Advisor")}
          <div className="font-normal">
            {tx("Lets this thread ask a stronger model to check its work.")}
          </div>
        </div>
        <MenuRadioGroup
          value={state.choice}
          onValueChange={(value) => {
            const choice = THREAD_ADVISOR_CHOICES.find((candidate) => candidate === value);
            if (choice === undefined || choice === state.choice) return;
            props.onChoose(threadAdvisorModeForChoice(choice));
          }}
        >
          {THREAD_ADVISOR_CHOICES.map((choice) => (
            <MenuRadioItem
              key={choice}
              value={choice}
              hideIndicator
              closeOnClick
              data-thread-advisor-choice={choice}
            >
              <span>{labels[choice]}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    </div>
  );
}

/** The Advisor row for one thread; nothing for a draft, an older server or an advisor child. */
export function ThreadAdvisorMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly separated: boolean;
}) {
  const shell = useThreadShell(props.threadRef);
  const environment = useEnvironment(props.threadRef.environmentId);
  const setAdvisorMode = useOrchestrationCommand(threadEnvironment.setAdvisorMode);
  const config = environment?.serverConfig;
  const settings = config?.settings;
  if (
    shell === null ||
    settings == null ||
    !threadAdvisorMenuVisible({
      capability: config?.environment?.capabilities.advisor === true,
      purpose: shell.source.purpose,
    })
  ) {
    return null;
  }
  const projectAdvisor = resolveProjectSettings(settings, shell.projectId).settings.advisor;
  return (
    <ThreadAdvisorMenuItems
      state={threadAdvisorMenuState(shell.source.advisorMode, projectAdvisor)}
      separated={props.separated}
      onChoose={(advisorMode) => {
        void setAdvisorMode({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId, advisorMode },
        });
      }}
    />
  );
}
