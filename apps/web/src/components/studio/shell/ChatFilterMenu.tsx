/**
 * The Chats list's filter and sort menu. What it lists and how it is arranged live in
 * ChatListOptions; the machine is stored apart, since it is an id and not a fixed choice.
 */
import { ArchiveIcon, SlidersVerticalIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import { cn } from "~/lib/utils";
import {
  CHAT_ACTIVITY_FILTERS,
  CHAT_GROUPINGS,
  CHAT_OPTION_LABELS,
  CHAT_PROJECT_THREAD_CHOICES,
  CHAT_SORTS,
  CHAT_STATUS_FILTERS,
  DEFAULT_CHAT_LIST_OPTIONS,
  chatListOptionsAreDefault,
  type ChatListOptions,
} from "../../../studio/shellModel";
import type { MachineFilterOption } from "../../../studio/threadMachineFilter";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

const FILTER_SECTIONS = [
  { key: "status", title: "Status", values: CHAT_STATUS_FILTERS },
  { key: "activity", title: "Last activity", values: CHAT_ACTIVITY_FILTERS },
  { key: "projectThreads", title: "Agent threads", values: CHAT_PROJECT_THREAD_CHOICES },
  { key: "groupBy", title: "Group by", values: CHAT_GROUPINGS },
  { key: "sortBy", title: "Sort by", values: CHAT_SORTS },
] as const;
/**
 * A chat never resolves, so "Resolved" only means something while agent threads are
 * listed too; a saved pick stays visible so it can be changed.
 */
function chatFilterValues(
  section: (typeof FILTER_SECTIONS)[number],
  options: ChatListOptions,
): readonly string[] {
  if (section.key !== "status" || options.projectThreads === "show") return section.values;
  return section.values.filter((value) => value !== "resolved" || options.status === "resolved");
}
/** The first row that chooses how the list is arranged rather than what it lists. */
const FIRST_ARRANGE_SECTION = FILTER_SECTIONS.findIndex((section) => section.key === "groupBy");

export function ChatFilterMenu(props: {
  options: ChatListOptions;
  onChange: (options: ChatListOptions) => void;
  machines: readonly MachineFilterOption[];
  machine: string | null;
  onMachineChange: (machineId: string | null) => void;
}) {
  const changed = !chatListOptionsAreDefault(props.options) || props.machine !== null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={cn("sws-icon-button", changed && "sws-icon-button-on")}
                  aria-label={
                    changed ? "Filter and sort chats, filter active" : "Filter and sort chats"
                  }
                />
              }
            />
          }
        >
          <SlidersVerticalIcon aria-hidden />
          {changed ? <span className="sws-filter-flag" aria-hidden /> : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Filter and sort chats</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" className="min-w-60">
        {FILTER_SECTIONS.map((section, index) => {
          const labels = CHAT_OPTION_LABELS[section.key] as Record<string, string>;
          return (
            <Fragment key={section.key}>
              {/* The rows above choose what is listed, the rows below how it is arranged. */}
              {index === FIRST_ARRANGE_SECTION ? (
                <>
                  {props.machines.length > 1 ? <ChatMachineMenu {...props} /> : null}
                  <MenuSeparator />
                </>
              ) : null}
              <MenuSub>
                <MenuSubTrigger>
                  <span className="flex-1">{section.title}</span>
                  <span className="text-muted-foreground">
                    {labels[props.options[section.key]]}
                  </span>
                </MenuSubTrigger>
                <MenuSubPopup className="min-w-44">
                  <MenuGroup>
                    <MenuGroupLabel>{section.title}</MenuGroupLabel>
                    <MenuRadioGroup
                      value={props.options[section.key]}
                      onValueChange={(value) =>
                        props.onChange({
                          ...props.options,
                          [section.key]: value,
                        } as ChatListOptions)
                      }
                    >
                      {chatFilterValues(section, props.options).map((value) => (
                        <MenuRadioItem key={value} value={value} closeOnClick={false}>
                          <span className="flex items-center justify-between gap-6">
                            {labels[value]}
                            <MenuRadioItemIndicator />
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </MenuSubPopup>
              </MenuSub>
            </Fragment>
          );
        })}
        <MenuSeparator />
        {changed ? (
          <MenuItem
            onClick={() => {
              props.onChange(DEFAULT_CHAT_LIST_OPTIONS);
              props.onMachineChange(null);
            }}
          >
            Reset to defaults
          </MenuItem>
        ) : null}
        {/* Rarely needed, so it waits here rather than taking a row in the list. */}
        <MenuItem render={<Link to="/settings/archived" />}>
          <ArchiveIcon aria-hidden />
          Archived chats
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Only offered once chats run on more than one machine. */
function ChatMachineMenu(props: {
  machines: readonly MachineFilterOption[];
  machine: string | null;
  onMachineChange: (machineId: string | null) => void;
}) {
  const current = props.machines.find((option) => option.machineId === props.machine);
  return (
    <MenuSub>
      <MenuSubTrigger>
        <span className="flex-1">Machine</span>
        <span className="text-muted-foreground">{current?.label ?? "All"}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-44">
        <MenuGroup>
          <MenuGroupLabel>Machine</MenuGroupLabel>
          <MenuRadioGroup
            value={props.machine ?? ""}
            onValueChange={(value) => props.onMachineChange(value === "" ? null : value)}
          >
            {[{ machineId: "", label: "All machines", count: null }, ...props.machines].map(
              (option) => (
                <MenuRadioItem
                  key={option.machineId}
                  value={option.machineId}
                  closeOnClick={false}
                  aria-label={
                    option.count === null
                      ? option.label
                      : `${option.label}, ${option.count} open ${option.count === 1 ? "chat" : "chats"}`
                  }
                >
                  <span className="flex items-center justify-between gap-6">
                    <span>
                      {option.label}
                      {option.count === null ? null : (
                        <span className="text-muted-foreground"> {option.count}</span>
                      )}
                    </span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
