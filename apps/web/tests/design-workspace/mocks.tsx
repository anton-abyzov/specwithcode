/**
 * Simulated data, routing and permission hooks for the design workspace
 * fixture. Components, styles, the renderer and the gallery rules are real.
 */
import type { PropsWithChildren } from "react";
import { useSyncExternalStore } from "react";
import type { DesignSummary } from "@specweave-studio/contracts";

type Listener = () => void;
const listeners = new Set<Listener>();
export const fixture = {
  /** Designs of the Library's project, as `design.list` would return them. */
  projectDesigns: [] as DesignSummary[],
  pushed: [] as string[],
  calls: [] as Array<{ label: string; value: unknown }>,
  opened: [] as string[],
};
export function publish(change: Partial<typeof fixture>): void {
  Object.assign(fixture, change);
  for (const listener of listeners) listener();
}
function useFixture<T>(select: () => T): T {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, select);
}

// @tanstack/react-router
const push = (path: string) => publish({ pushed: [...fixture.pushed, path] });
const pathOf = (route: { to: string; params?: Record<string, string> }) =>
  route.to.replace(/\$(\w+)/g, (_match, name: string) => route.params?.[name] ?? "");
export const useRouter = () => ({
  history: { push },
  navigate: async (route: { to: string; params?: Record<string, string> }) => push(pathOf(route)),
});
export const useNavigate = () => async () => undefined;
export function Link({ children, to, ...rest }: PropsWithChildren<{ to: string }>) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}

// studio/design, studio/projectWorkspace
export const design = {
  list: (key: unknown) => ({ query: "design.list", key }),
  copy: { label: "design.copy" },
};
export const projectWorkspace = {
  library: () => ({ query: "library" }),
  libraryAddArtifact: { label: "library.add" },
};

// state/query
const LIBRARY = {
  workspaceRoot: "/Users/me/atlas-web",
  specweave: true,
  hub: { name: "atlas-web", revision: 3, updatedAt: "2026-10-20T13:10:00.000Z" },
  hubProblem: null,
  artifacts: [
    {
      id: "a1",
      title: "Release notes",
      kind: "file",
      location: ".specweave/reports/release-notes.md",
      createdAt: "2026-10-19T09:00:00.000Z",
      modifiedAt: "2026-10-19T09:00:00.000Z",
      byteLength: 4200,
      missing: false,
    },
  ],
  folders: [
    {
      path: ".specweave/docs",
      label: "Docs",
      modifiedAt: "2026-10-18T09:00:00.000Z",
    },
  ],
};
export function useEnvironmentQuery(atom: { query: string } | null) {
  const designs = useFixture(() => fixture.projectDesigns);
  return {
    data:
      atom?.query === "design.list"
        ? { designs, problems: [] }
        : atom?.query === "library"
          ? LIBRARY
          : null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => undefined,
  };
}

// state/use-atom-command
export const useAtomCommand = (command: { label: string }) => async (value: unknown) => {
  fixture.calls.push({ label: command.label, value });
  return { _tag: "Success", value: { ref: { designId: "d_copy" } } };
};

// state/session
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = () => true;

// files/useDirectoryEntries, browser/useOpenLink
const NO_DIRECTORIES = new Map();
export const useDirectoryEntries = () => ({
  directories: NO_DIRECTORIES,
  error: null,
  load: async () => undefined,
  refresh: () => undefined,
});
export const useOpenLink = () => async () => undefined;

// shell/LibraryFileViewer
export function LibraryFileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  fixture.opened.push(path);
  return (
    <div role="dialog" aria-label="File" data-testid="library-viewer" className="sr-only">
      {path}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
export const useParams = ({
  select,
}: { select?: (params: Record<string, string>) => unknown } = {}) => (select ? select({}) : {});
