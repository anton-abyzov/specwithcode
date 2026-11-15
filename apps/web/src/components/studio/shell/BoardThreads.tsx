/**
 * The threads working on each board card. A card and a thread are not one to
 * one: an increment can have several threads (a builder, a reviewer, a
 * hand-off to another machine) or none, so every thread is its own line that
 * opens that thread, with its state and the machine it runs on in that
 * machine's color. A thread that moved shows the arrow the thread list shows.
 */
import {
  THREAD_INCREMENT_PROGRESS_MAX_THREADS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { LaptopIcon, WifiOffIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useEnvironments } from "../../../state/environments";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { BOARD_CARD_THREADS, boardThreadOrder } from "../../../studio/projectBoardModel";
import {
  THREAD_TONE_LABELS,
  threadStatusWord,
  threadTone,
  type ThreadTone,
} from "../../../studio/shellModel";
import { threadLocation, type ThreadLocation } from "../../../studio/threadLocation";
import { useUnreachableHosts } from "../../../studio/unreachableHosts";
import {
  useThreadIncrementState,
  type ThreadIncrementState,
} from "../../../studio/useThreadIncrementProgress";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export interface BoardThread {
  readonly thread: EnvironmentThreadShell;
  readonly tone: ThreadTone;
  /** "Working", "Needs you"…; null once resolved. */
  readonly status: string | null;
  readonly updatedAt: string;
  readonly machine: ThreadLocation;
  /** The machine it runs on now, as that machine's color id. */
  readonly color: string;
}

/**
 * One read answers for 100 threads, and a long-lived project has more, so the
 * board reads in pages: per machine, the threads still at work first, then the
 * newest. Past this many pages a machine's oldest threads are left unread and
 * the board stops claiming a card is free.
 */
export const BOARD_THREAD_PAGES = 5;

interface BoardThreadPage {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly activityKey: string;
}

/** The pages to read, and whether some thread fits in none of them. */
export function boardThreadPages(threads: ReadonlyArray<EnvironmentThreadShell>): {
  readonly pages: ReadonlyArray<BoardThreadPage>;
  readonly cut: boolean;
} {
  const byMachine = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = `${thread.environmentId}\u0000${thread.projectId}`;
    byMachine.set(key, [...(byMachine.get(key) ?? []), thread]);
  }
  const pages: BoardThreadPage[] = [];
  let cut = false;
  for (const [key, held] of byMachine) {
    const ordered = held.toSorted(
      (left, right) =>
        Number(threadTone(left) === "resolved") - Number(threadTone(right) === "resolved") ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
    const limit = BOARD_THREAD_PAGES * THREAD_INCREMENT_PROGRESS_MAX_THREADS;
    if (ordered.length > limit) cut = true;
    for (let start = 0; start < Math.min(ordered.length, limit); ) {
      const page = ordered.slice(start, start + THREAD_INCREMENT_PROGRESS_MAX_THREADS);
      pages.push({
        key: `${key}\u0000${start}`,
        environmentId: page[0]!.environmentId,
        projectId: page[0]!.projectId,
        threadIds: page.map((thread) => thread.id),
        activityKey: page.reduce(
          (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
          "",
        ),
      });
      start += THREAD_INCREMENT_PROGRESS_MAX_THREADS;
    }
  }
  return { pages, cut };
}

const BoardThreadPageLoader = memo(function BoardThreadPageLoader(props: {
  page: BoardThreadPage;
  onChange: (key: string, state: ThreadIncrementState) => void;
}) {
  const { page, onChange } = props;
  const state = useThreadIncrementState(page);
  useEffect(() => onChange(page.key, state), [onChange, page.key, state]);
  return null;
});

/**
 * Each increment's threads, by increment id, on this machine and on the
 * others that serve the project. `loaders` must be rendered: they do the reads.
 */
export function useBoardThreads(input: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly machineLabels?: ReadonlyMap<string, string> | undefined;
}): {
  readonly byIncrement: ReadonlyMap<string, ReadonlyArray<BoardThread>>;
  /**
   * False until every thread has said which increment it works on: an empty
   * card then means "not known yet", not "nobody is on it".
   */
  readonly answered: boolean;
  /** Threads run on more than one machine, so each line names its own. */
  readonly multiMachine: boolean;
  readonly loaders: ReactNode;
} {
  const { threads, machineLabels } = input;
  const { pages, cut } = useMemo(() => boardThreadPages(threads), [threads]);
  const [states, setStates] = useState(() => new Map<string, ThreadIncrementState>());
  const onChange = useCallback(
    (key: string, state: ThreadIncrementState) =>
      setStates((current) =>
        current.get(key) === state ? current : new Map(current).set(key, state),
      ),
    [],
  );
  const loaders = useMemo(
    () =>
      pages.map((page) => (
        <BoardThreadPageLoader key={page.key} page={page} onChange={onChange} />
      )),
    [onChange, pages],
  );
  const answered = !cut && pages.every((page) => states.get(page.key)?.answered === true);
  const links = useMemo(() => {
    const result = new Map<string, string>();
    for (const page of pages)
      for (const [threadId, entry] of states.get(page.key)?.progress ?? [])
        result.set(`${page.environmentId}\u0000${threadId}`, entry.incrementId);
    return result;
  }, [pages, states]);
  const unreachable = useUnreachableHosts();
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  const identity = useMachineIdentities();
  const joined = useMemo(() => {
    const labels = new Map<string, string>();
    for (const environment of environments)
      labels.set(environment.environmentId, environment.label);
    for (const [id, label] of machineLabels ?? [])
      if (label !== id && !labels.has(id)) labels.set(id, label);
    const name = (id: string, fallbackLabel?: string | null) => {
      const label = labels.get(id) ?? fallbackLabel;
      const resolved = nickname(id, label);
      return label || resolved !== id ? resolved : "another machine";
    };
    const fullName = (id: string, fallbackLabel?: string | null) =>
      labels.get(id) ?? fallbackLabel ?? name(id);
    const grouped = new Map<string, BoardThread[]>();
    const machines = new Set<string>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const machine = threadLocation({
        summary: thread.source,
        servingEnvironmentId: thread.environmentId,
        name,
        fullName,
        unreachable,
      });
      machines.add(machine.executionMachineId);
      const incrementId = links.get(`${thread.environmentId}\u0000${thread.id}`);
      if (!incrementId) continue;
      const offline = machine.state === "unknown";
      const held = grouped.get(incrementId) ?? [];
      held.push({
        thread,
        tone: threadTone(thread, offline),
        status: threadStatusWord(thread, offline),
        updatedAt: thread.updatedAt,
        machine,
        color: identity(machine.executionMachineId).color,
      });
      grouped.set(incrementId, held);
    }
    for (const [incrementId, held] of grouped) grouped.set(incrementId, boardThreadOrder(held));
    return {
      byIncrement: grouped,
      multiMachine: machines.size > 1 || (machineLabels?.size ?? 0) > 1,
    };
  }, [
    environments,
    identity,
    links,
    machineLabels,
    nickname,
    threads,
    unreachable,
  ]);
  return { ...joined, answered, loaders };
}

/** Where a thread runs, in its machine's color; "→ name" once it moved there. */
export function BoardMachineMark({ thread }: { thread: BoardThread }) {
  const { machine } = thread;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="sws-board-machine machine-mark"
            data-machine-id={machine.executionMachineId}
            data-machine-color={thread.color}
            data-execution={machine.state}
            data-moved={machine.moved || undefined}
          />
        }
      >
        {machine.state === "unknown" ? <WifiOffIcon aria-hidden /> : <LaptopIcon aria-hidden />}
        <span className="sr-only">{machine.description}</span>
        <span aria-hidden>
          {machine.moved ? <span className="sws-board-machine-arrow">→ </span> : null}
          {machine.label.split(" → ").at(-1)}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{machine.description}</TooltipPopup>
    </Tooltip>
  );
}

/** A card's thread lines: each opens its thread. */
export function BoardThreadLines({
  threads,
  showMachine,
  onOpen,
}: {
  threads: ReadonlyArray<BoardThread>;
  showMachine: boolean;
  onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const [all, setAll] = useState(false);
  if (threads.length === 0) return null;
  const shown = all ? threads : threads.slice(0, BOARD_CARD_THREADS);
  const hidden = threads.length - shown.length;
  return (
    <ul className="sws-board-threads" aria-label="Threads on this increment">
      {shown.map((entry) => (
        <li key={`${entry.thread.environmentId}:${entry.thread.id}`}>
          <button
            type="button"
            className="sws-board-thread"
            data-tone={entry.tone}
            aria-label={`Open thread ${entry.thread.title}, ${THREAD_TONE_LABELS[entry.tone]}`}
            onClick={() => onOpen(entry.thread)}
          >
            <span className="sws-dot" data-tone={entry.tone} aria-hidden />
            <span className="sws-board-thread-title">{entry.thread.title}</span>
            {entry.status ? <span className="sws-board-thread-status">{entry.status}</span> : null}
          </button>
          {showMachine || entry.machine.moved ? <BoardMachineMark thread={entry} /> : null}
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <button type="button" className="sws-board-thread-more" onClick={() => setAll(true)}>
            {hidden} more {hidden === 1 ? "thread" : "threads"}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
