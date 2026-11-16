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
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { LaptopIcon, WifiOffIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  /** How it is bound to the increment; only a `claim` names the task it wrote to. */
  readonly binding: string | null;
  readonly boundTaskId: string | null;
  /** When it last wrote to that task in the ledger. */
  readonly boundAt: string | null;
}

/**
 * One read answers for 100 threads, and a long-lived project has more, so the
 * board reads in pages. A thread's page comes from its id, not its place in
 * the list, so a thread that starts, settles or moves up changes one page's
 * read and leaves the others alone.
 */
export const BOARD_THREAD_PAGES = 8;
/** How full a page is planned, so ordinary growth does not overflow it. */
const PAGE_FILL = 60;

interface BoardThreadPage {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** The ids joined: what the read is for. */
  readonly idsKey: string;
  readonly activityKey: string;
}

function idHash(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1)
    hash = (Math.imul(hash, 31) + id.charCodeAt(index)) >>> 0;
  return hash;
}

/** 1 page up to 100 threads, then 2, 4 or 8: the count changes rarely, so pages hold still. */
function pageCount(threads: number): number {
  if (threads <= THREAD_INCREMENT_PROGRESS_MAX_THREADS) return 1;
  let pages = 2;
  while (pages < BOARD_THREAD_PAGES && threads / pages > PAGE_FILL) pages *= 2;
  return pages;
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
    const held = byMachine.get(key);
    if (held) held.push(thread);
    else byMachine.set(key, [thread]);
  }
  const pages: BoardThreadPage[] = [];
  let cut = false;
  for (const [key, held] of byMachine) {
    const count = pageCount(held.length);
    const buckets: EnvironmentThreadShell[][] = Array.from({ length: count }, () => []);
    for (const thread of held) buckets[count === 1 ? 0 : idHash(thread.id) % count]!.push(thread);
    buckets.forEach((bucket, index) => {
      if (bucket.length === 0) return;
      let page = bucket;
      if (bucket.length > THREAD_INCREMENT_PROGRESS_MAX_THREADS) {
        // Too many for one read: the threads still at work stay, then the newest.
        cut = true;
        page = bucket
          .map((thread) => ({ thread, resolved: threadTone(thread) === "resolved" }))
          .toSorted(
            (left, right) =>
              Number(left.resolved) - Number(right.resolved) ||
              right.thread.updatedAt.localeCompare(left.thread.updatedAt),
          )
          .slice(0, THREAD_INCREMENT_PROGRESS_MAX_THREADS)
          .map((entry) => entry.thread);
      }
      const threadIds = page.map((thread) => thread.id).toSorted();
      pages.push({
        key: `${key}\u0000${count}\u0000${index}`,
        environmentId: page[0]!.environmentId,
        projectId: page[0]!.projectId,
        threadIds,
        idsKey: threadIds.join(","),
        activityKey: page.reduce(
          (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
          "",
        ),
      });
    });
  }
  return { pages, cut };
}

/** What a thread's progress read says about its increment; a fixture may know only the id. */
type BoardThreadLink = Pick<ThreadIncrementProgress, "incrementId"> &
  Partial<Pick<ThreadIncrementProgress, "binding" | "boundTaskId" | "boundAt">>;

interface BoardPageState {
  /** The ids the state answers for; a page whose ids changed is not answered yet. */
  readonly idsKey: string;
  readonly state: ThreadIncrementState;
}

const BoardThreadPageLoader = memo(function BoardThreadPageLoader(props: {
  page: BoardThreadPage;
  onChange: (key: string, idsKey: string, state: ThreadIncrementState) => void;
}) {
  const { page, onChange } = props;
  const state = useThreadIncrementState(page);
  useEffect(() => onChange(page.key, page.idsKey, state), [onChange, page.key, page.idsKey, state]);
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
  // The thread list is a new array on every update of any thread. A page whose
  // threads and newest change are the same keeps its object, so its loader rests.
  const held = useRef(new Map<string, BoardThreadPage>());
  const { pages, cut } = useMemo(() => {
    const next = boardThreadPages(threads);
    const kept = new Map<string, BoardThreadPage>();
    const pages = next.pages.map((page) => {
      const before = held.current.get(page.key);
      const same =
        before !== undefined &&
        before.idsKey === page.idsKey &&
        before.activityKey === page.activityKey;
      const entry = same ? before : page;
      kept.set(page.key, entry);
      return entry;
    });
    held.current = kept;
    return { pages, cut: next.cut };
  }, [threads]);
  const pagesKey = pages.map((page) => page.key).join("\u0001");
  const [states, setStates] = useState(() => new Map<string, BoardPageState>());
  const onChange = useCallback(
    (key: string, idsKey: string, state: ThreadIncrementState) =>
      setStates((current) => {
        const before = current.get(key);
        return before?.state === state && before.idsKey === idsKey
          ? current
          : new Map(current).set(key, { idsKey, state });
      }),
    [],
  );
  // Pages that no longer exist (the project crossed a page-count step) are forgotten.
  useEffect(() => {
    const live = new Set(pagesKey.split("\u0001"));
    setStates((current) =>
      [...current.keys()].every((key) => live.has(key))
        ? current
        : new Map([...current].filter(([key]) => live.has(key))),
    );
  }, [pagesKey]);
  const loaders = pages.map((page) => (
    <BoardThreadPageLoader key={page.key} page={page} onChange={onChange} />
  ));
  const answered =
    !cut &&
    pages.every((page) => {
      const entry = states.get(page.key);
      return entry?.idsKey === page.idsKey && entry.state.answered;
    });
  // A page being read again keeps its last answer for the threads it still holds.
  const links = useMemo(() => {
    const result = new Map<string, BoardThreadLink>();
    for (const page of pages)
      for (const [threadId, entry] of states.get(page.key)?.state.progress ?? [])
        result.set(`${page.environmentId}\u0000${threadId}`, entry);
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
      const link = links.get(`${thread.environmentId}\u0000${thread.id}`);
      if (!link) continue;
      const incrementId = link.incrementId;
      const offline = machine.state === "unknown";
      const held = grouped.get(incrementId) ?? [];
      held.push({
        thread,
        tone: threadTone(thread, offline),
        status: threadStatusWord(thread, offline),
        updatedAt: thread.updatedAt,
        machine,
        color: identity(machine.executionMachineId).color,
        binding: link.binding ?? null,
        boundTaskId: link.boundTaskId ?? null,
        boundAt: link.boundAt ?? null,
      });
      grouped.set(incrementId, held);
    }
    for (const [incrementId, held] of grouped) grouped.set(incrementId, boardThreadOrder(held));
    return {
      byIncrement: grouped,
      multiMachine: machines.size > 1 || (machineLabels?.size ?? 0) > 1,
    };
  }, [environments, identity, links, machineLabels, nickname, threads, unreachable]);
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
