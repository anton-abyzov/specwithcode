import type {
  EnvironmentId,
  ProjectId,
  ServerSettings,
  TimelineDetail,
  UnifiedSettings,
} from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ListCollapseIcon, MessageSquareTextIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import {
  RESPONSE_STYLE_DESCRIPTIONS,
  RESPONSE_STYLE_LABELS,
  type ResponseStyle,
} from "~/responseStyle";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  resolveTimelineDetail,
  setThreadTimelineDetail,
  setTimelineDetail,
  threadHasOwnTimelineDetail,
  TIMELINE_DETAIL_DESCRIPTIONS,
  TIMELINE_DETAIL_LABELS,
  TIMELINE_DETAIL_LEVELS,
} from "~/timelineDetail";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function isTimelineDetail(value: unknown): value is TimelineDetail {
  return TIMELINE_DETAIL_LEVELS.includes(value as TimelineDetail);
}

const RESPONSE_STYLES = Object.keys(RESPONSE_STYLE_LABELS) as ResponseStyle[];

function isResponseStyle(value: unknown): value is ResponseStyle {
  return RESPONSE_STYLES.includes(value as ResponseStyle);
}

/** The "This thread" choice that follows the default for every thread. */
const FOLLOW_DEFAULT = "default";

export interface HeaderProjectRef {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

/** The logical project a checkout belongs to, so a choice reaches all its checkouts, as in Settings. */
export function findLogicalProjectKey(
  groups: readonly Pick<SidebarProjectSnapshot, "projectKey" | "memberProjects">[],
  project: HeaderProjectRef,
): string | null {
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === project.environmentId && member.id === project.projectId,
    ),
  );
  return group?.projectKey ?? null;
}

/** A null style means the project's checkouts disagree. */
interface ProjectReplies {
  style: ResponseStyle | null;
  writable: boolean;
  onChange: (style: ResponseStyle) => void;
}

type MenuProps = {
  className?: string | undefined;
  /** "project" matches the project workspace header's icon buttons. */
  appearance?: "chat" | "project" | undefined;
  /** `environmentId:threadId` of the thread this header belongs to. */
  threadKey?: string | null | undefined;
};

/**
 * How the agents of the header's project reply, and how much of their work a
 * timeline shows. With a project the trigger names the reply style, which is
 * what agents are told; the view levels sit under "Show".
 */
export function TimelineDetailMenu({
  project = null,
  ...menu
}: MenuProps & {
  /** The checkout this header's thread runs in; without one only the view levels show. */
  project?: HeaderProjectRef | null;
}) {
  return project ? (
    <ProjectRepliesScope project={project} {...menu} />
  ) : (
    <DetailMenu {...menu} replies={null} />
  );
}

const keepScope = () => {};

function ProjectRepliesScope({ project, ...menu }: MenuProps & { project: HeaderProjectRef }) {
  const projectKey = findLogicalProjectKey(useSettingsProjectGroups(), project);
  const search = useMemo(() => ({ project: projectKey ?? undefined }), [projectKey]);
  if (projectKey === null) return <DetailMenu {...menu} replies={null} />;
  return (
    <SettingsScopeProvider search={search} onChange={keepScope}>
      <ProjectRepliesMenu {...menu} />
    </SettingsScopeProvider>
  );
}

const RESPONSE_STYLE_KEYS: readonly (keyof ServerSettings)[] = ["responseStyle"];
const selectResponseStyle = (settings: UnifiedSettings) => settings.responseStyle;

function ProjectRepliesMenu(menu: MenuProps) {
  const style = useScopedSettings(selectResponseStyle);
  const mixed = useScopedSettingsMixed(RESPONSE_STYLE_KEYS);
  const writable = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  const replies = useMemo(
    () => ({
      style: mixed ? null : style,
      writable,
      onChange: (next: ResponseStyle) => update({ responseStyle: next }),
    }),
    [mixed, style, update, writable],
  );
  return <DetailMenu {...menu} replies={replies} />;
}

function DetailMenu({
  className,
  appearance = "chat",
  threadKey = null,
  replies,
}: MenuProps & { replies: ProjectReplies | null }) {
  const defaultDetail = useClientSettings((settings) => settings.timelineDetail);
  const detail = useClientSettings((settings) => resolveTimelineDetail(settings, threadKey));
  const ownLevel = useClientSettings((settings) => threadHasOwnTimelineDetail(settings, threadKey));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "timeline.cycleDetail"),
    [keybindings],
  );
  const replyLabel = replies
    ? replies.style === null
      ? "Mixed"
      : RESPONSE_STYLE_LABELS[replies.style]
    : null;
  const showLabel = `Show: ${TIMELINE_DETAIL_LABELS[detail]}${ownLevel ? " (this thread)" : ""}`;
  const label = replyLabel ? `Agent replies: ${replyLabel}. ${showLabel}` : showLabel;
  const responseStyleData = replies ? (replies.style ?? "mixed") : undefined;
  const TriggerIcon = replies ? MessageSquareTextIcon : ListCollapseIcon;
  // Each level is described once: in the thread's group when there is one.
  const levelItem = (described: boolean) => (level: TimelineDetail) => (
    <MenuRadioItem key={level} value={level} closeOnClick>
      <span className="flex items-start gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
          <MenuRadioItemIndicator />
        </span>
        <span className="flex min-w-0 flex-col">
          <span>{TIMELINE_DETAIL_LABELS[level]}</span>
          {described ? (
            <span className="text-muted-foreground text-xs">
              {TIMELINE_DETAIL_DESCRIPTIONS[level]}
            </span>
          ) : null}
        </span>
      </span>
    </MenuRadioItem>
  );
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                appearance === "project" ? (
                  <button
                    type="button"
                    aria-label={label}
                    data-timeline-detail={detail}
                    data-timeline-detail-own={ownLevel || undefined}
                    data-response-style={responseStyleData}
                    className={cn("sws-icon-button", ownLevel && "sws-icon-button-on", className)}
                    style={{ width: "auto", paddingInline: 6, gap: 4 }}
                  />
                ) : (
                  <Button
                    size="xs"
                    variant={ownLevel ? "secondary" : "ghost-muted"}
                    aria-label={label}
                    data-timeline-detail={detail}
                    data-timeline-detail-own={ownLevel || undefined}
                    data-response-style={responseStyleData}
                    className={cn("shrink-0", className)}
                  />
                )
              }
            />
          }
        >
          <TriggerIcon aria-hidden className={appearance === "chat" ? "size-3.5" : undefined} />
          <span aria-hidden data-timeline-detail-label className="text-xs">
            {replyLabel ?? TIMELINE_DETAIL_LABELS[detail]}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}
          {shortcutLabel ? ` (${shortcutLabel} cycles what every thread shows)` : ""}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-64">
        {replies ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Agent replies in this project</MenuGroupLabel>
              <MenuRadioGroup
                value={replies.style ?? ""}
                onValueChange={(value) => {
                  if (isResponseStyle(value)) replies.onChange(value);
                }}
              >
                {RESPONSE_STYLES.map((style) => (
                  <MenuRadioItem
                    key={style}
                    value={style}
                    disabled={!replies.writable}
                    closeOnClick
                  >
                    <span className="flex items-start gap-2">
                      <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                        <MenuRadioItemIndicator />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span>{RESPONSE_STYLE_LABELS[style]}</span>
                        <span className="text-muted-foreground text-xs">
                          {RESPONSE_STYLE_DESCRIPTIONS[style]}
                        </span>
                      </span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {replies.writable ? null : (
                <p className="px-2 pb-1 text-muted-foreground text-xs">
                  This connection cannot change project settings.
                </p>
              )}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        {threadKey ? (
          <MenuGroup>
            <MenuGroupLabel>Show in this thread</MenuGroupLabel>
            <MenuRadioGroup
              value={ownLevel ? detail : FOLLOW_DEFAULT}
              onValueChange={(value) => {
                if (value === FOLLOW_DEFAULT) setThreadTimelineDetail(threadKey, null);
                else if (isTimelineDetail(value)) setThreadTimelineDetail(threadKey, value);
              }}
            >
              <MenuRadioItem value={FOLLOW_DEFAULT} closeOnClick>
                <span className="flex items-start gap-2">
                  <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                    <MenuRadioItemIndicator />
                  </span>
                  <span>Use default ({TIMELINE_DETAIL_LABELS[defaultDetail]})</span>
                </span>
              </MenuRadioItem>
              {TIMELINE_DETAIL_LEVELS.map(levelItem(true))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{threadKey ? "Show in every thread" : "Show"}</MenuGroupLabel>
          <MenuRadioGroup
            value={defaultDetail}
            onValueChange={(value) => {
              if (isTimelineDetail(value)) setTimelineDetail(value);
            }}
          >
            {TIMELINE_DETAIL_LEVELS.map(levelItem(!threadKey))}
          </MenuRadioGroup>
        </MenuGroup>
        {shortcutLabel ? (
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
            <span>Cycle what every thread shows</span>
            <MenuShortcut>{shortcutLabel}</MenuShortcut>
          </div>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
