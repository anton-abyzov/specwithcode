// Stand-ins for what needs a server or a router. The fixture's data rides on `window`.
import type { ReactNode } from "react";

type Fixture = { read: unknown; refs: ReadonlyArray<string>; calls: Array<unknown> };
const fixture = () => (window as unknown as { __environmentFixture: Fixture }).__environmentFixture;

export const projectWorkspace = {
  environmentRead: (request: { input: { threadId?: string } }) => ({
    data: () => {
      const { thread, ...read } = fixture().read as { thread?: unknown };
      return request.input.threadId === undefined ? read : { ...read, thread };
    },
  }),
  environmentPrepare: "prepare",
};
export const vcsEnvironment = {
  listRefs: () => ({
    data: () => ({ refs: fixture().refs.map((name) => ({ name, current: false })) }),
  }),
};
export function useEnvironmentQuery(atom: { data: () => unknown } | null) {
  return {
    data: atom === null ? null : atom.data(),
    error: null,
    failure: null,
    isPending: false,
    isSuccess: atom !== null,
    dataUpdatedAt: 0,
    refresh() {},
  };
}
export function useAtomCommand() {
  return async (request: unknown) => {
    fixture().calls.push(request);
    return { _tag: "Success", value: fixture().read };
  };
}
export const useMachineNickname = () => "This Mac (M4)";
export function Link({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <a className={className} href="#worktrees">
      {children}
    </a>
  );
}
