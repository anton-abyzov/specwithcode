// Stand-ins for what needs a server or a browser tab: the board RPC answers
// from 700 fictional increments, filtered and cut the way the server does.
import type { ProjectBoardCard, ProjectBoardResult, ProjectId } from "@specweave-studio/contracts";

const NOW = Date.parse("2026-11-14T18:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SUBJECTS = [
  "Sign-in with a passkey",
  "Faster search over large folders",
  "Export a report as a document",
  "Copy a project to another machine",
  "Clear progress for long uploads",
  "Keyboard shortcuts for the panel",
  "Usage chart by week",
  "Retry a failed sync",
  "Dark theme contrast pass",
  "Notifications for finished runs",
  "Rename a thread in place",
  "Offline queue for messages",
];
const pull = (number: number) => `https://github.com/example/atlas/pull/${number}`;

function card(index: number, column: ProjectBoardCard["column"], order: number): ProjectBoardCard {
  const number = 1338 - index;
  const subject = SUBJECTS[index % SUBJECTS.length]!;
  const total = 3 + (index % 5);
  const done =
    column === "planned"
      ? 0
      : column === "active"
        ? index % total
        : column === "review"
          ? total
          : total;
  const incrementId = `${String(number).padStart(4, "0")}-${subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return {
    incrementId,
    title: index % 9 === 4 ? `${subject}, with the settings and the empty state reviewed` : subject,
    status:
      column === "done"
        ? "completed"
        : column === "planned"
          ? "planned"
          : column === "active" && index % 13 === 5
            ? "paused"
            : "active",
    column,
    tasks: { total, done },
    blocked: column === "active" && (index % 7 === 3 || index % 13 === 5),
    updatedAt: ago(20 + order * (column === "done" ? 190 : 75)),
    pullRequests:
      column === "planned" || index % 3 === 0
        ? []
        : index % 8 === 1
          ? [pull(400 - index), pull(399 - index)]
          : [pull(400 - index)],
    specPath: `/work/atlas/.specweave/increments/${incrementId}/spec.md`,
  };
}

const ALL: ProjectBoardCard[] = [];
let index = 0;
for (const [column, count] of [
  ["active", 71],
  ["review", 7],
  ["planned", 11],
  ["done", 611],
] as const) {
  for (let order = 0; order < count; order += 1) ALL.push(card(index++, column, order));
}

export const projectWorkspace = {
  board: (request: { input: { projectId: ProjectId; query?: string; doneLimit?: number } }) =>
    request.input,
};

// One reply per distinct input, as the real query atoms hold theirs.
const replies = new Map<string, ProjectBoardResult>();
export function useEnvironmentQuery(input: {
  projectId: ProjectId;
  query?: string;
  doneLimit?: number;
}) {
  const key = `${input.query ?? ""}|${input.doneLimit ?? 30}`;
  let data = replies.get(key);
  if (data === undefined) {
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matched = ALL.filter((entry) =>
      words.every((word) => `${entry.incrementId} ${entry.title}`.toLowerCase().includes(word)),
    );
    const counts = { planned: 0, active: 0, review: 0, done: 0 };
    for (const entry of matched) counts[entry.column] += 1;
    let doneLeft = input.doneLimit ?? 30;
    data = {
      projectId: input.projectId,
      cards: matched.filter((entry) => entry.column !== "done" || doneLeft-- > 0),
      counts,
    };
    replies.set(key, data);
  }
  return { data, error: null, isPending: false, refresh };
}
const refresh = () => undefined;

export function useOpenLink() {
  return async (url: string) => {
    document.body.dataset.openedLink = url;
  };
}

export function LibraryFileViewer(props: { path: string; onClose: () => void }) {
  return (
    <button type="button" className="fixture-viewer" data-viewer-path={props.path} onClick={props.onClose}>
      Viewer: {props.path}
    </button>
  );
}
