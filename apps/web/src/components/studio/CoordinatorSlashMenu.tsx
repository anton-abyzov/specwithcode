/**
 * The coordinator composer's `/` menu: the app's own commands, run with no
 * model turn, and the coordinator provider's skills, which insert their
 * invocation and go to the agent with the message.
 */
import { resolveProviderSkillsForCwd } from "@specweave-studio/client-runtime/providerSkills";
import type { ProviderDriverKind, ServerProvider } from "@specweave-studio/contracts";
import { useMemo, useState, type KeyboardEvent } from "react";

import { useTheme } from "../../hooks/useTheme";
import { searchProviderSkills } from "../../providerSkillSearch";
import {
  leadingSlashQuery,
  matchComposerAppCommands,
  type ComposerAppCommand,
} from "../../studio/composerAppCommands";
import { ComposerCommandMenu, type ComposerCommandItem } from "../chat/ComposerCommandMenu";

const LIST_ID = "coordinator-slash-menu";
const SKILL_LIMIT = 30;

export interface CoordinatorSlashMenuInput {
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly onAppCommand: ((command: ComposerAppCommand) => void) | null;
  readonly provider: {
    readonly driverKind: ProviderDriverKind;
    readonly snapshot: ServerProvider;
  } | null;
  readonly cwd: string | null;
}

/** Items for a `/query` typed as the whole draft: app commands first, then skills. */
export function coordinatorSlashItems(
  query: string,
  input: Pick<CoordinatorSlashMenuInput, "onAppCommand" | "provider" | "cwd">,
): ComposerCommandItem[] {
  const apps: ComposerCommandItem[] = input.onAppCommand
    ? matchComposerAppCommands(query).map((entry) => ({
        id: `app:${entry.command}`,
        type: "app-command",
        command: entry.command,
        label: entry.label,
        description: entry.description,
      }))
    : [];
  const provider = input.provider;
  const skills: ComposerCommandItem[] = provider
    ? searchProviderSkills(
        resolveProviderSkillsForCwd(provider.snapshot, input.cwd),
        query.startsWith("skill:") ? query.slice("skill:".length) : query,
        SKILL_LIMIT,
      ).map((skill) => ({
        id: `skill:${provider.driverKind}:${skill.name}`,
        type: "skill",
        provider: provider.driverKind,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }))
    : [];
  return [...apps, ...skills];
}

/**
 * Drives the menu from the textarea: which items show, the highlighted one,
 * and the keys that move through or pick them.
 */
export function useCoordinatorSlashMenu(input: CoordinatorSlashMenuInput) {
  const { resolvedTheme } = useTheme();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const query =
    dismissedFor === input.prompt
      ? null
      : leadingSlashQuery(input.prompt, caret ?? input.prompt.length);
  const { onAppCommand, provider, cwd } = input;
  const items = useMemo(
    () => (query === null ? [] : coordinatorSlashItems(query, { onAppCommand, provider, cwd })),
    [query, onAppCommand, provider, cwd],
  );
  const open = query !== null && items.length > 0;
  const active = items.find((item) => item.id === activeId) ?? items[0] ?? null;

  const select = (item: ComposerCommandItem) => {
    if (item.type === "app-command") {
      input.setPrompt("");
      setActiveId(null);
      onAppCommand?.(item.command);
      return;
    }
    if (item.type === "skill") {
      input.setPrompt(`$${item.skill.name} `);
      setActiveId(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || active === null) return false;
    const index = items.indexOf(active);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveId(items[(index + step + items.length) % items.length]!.id);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (event.shiftKey || event.nativeEvent.isComposing) return false;
      event.preventDefault();
      select(active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedFor(input.prompt);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <div className="coordinator-slash-menu" data-coordinator-slash-menu>
      <ComposerCommandMenu
        listId={LIST_ID}
        items={items}
        resolvedTheme={resolvedTheme === "dark" ? "dark" : "light"}
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={active?.id ?? null}
        onHighlightedItemChange={setActiveId}
        onSelect={select}
      />
    </div>
  ) : null;

  return {
    open,
    menu,
    onKeyDown,
    /** The caret moves with typing and clicks; the menu follows the word under it. */
    onCaretChange: (position: number | null) => setCaret(position),
    listId: open ? LIST_ID : undefined,
  };
}
