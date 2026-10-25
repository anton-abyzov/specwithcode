import { EnvironmentId } from "@specweave-studio/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ShelfFileCheck } from "~/artifactShelf";

import {
  checkFolder,
  FILE_CHECK_TIMEOUT_MS,
  type FolderListing,
  type ListFolder,
  useArtifactFileChecks,
} from "./useMissingArtifactFiles";

const HOST = EnvironmentId.make("example-host");
const OTHER_HOST = EnvironmentId.make("example-other-host");

function listing(names: ReadonlyArray<string>, complete = true): FolderListing {
  return { names: new Set(names), complete };
}

/** A host whose folders answer from a table; a folder it lacks is refused. */
function host(folders: Record<string, FolderListing | "hang">): ListFolder & { calls: string[] } {
  const calls: string[] = [];
  const list = (folder: string, signal: AbortSignal) => {
    calls.push(folder);
    const answer = folders[folder];
    if (answer === "hang") {
      // Like a reconnecting host: no answer until the caller gives up.
      return new Promise<FolderListing>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    return answer ? Promise.resolve(answer) : Promise.reject(new Error("refused"));
  };
  return Object.assign(list, { calls });
}

interface ProbeProps {
  readonly environmentId: EnvironmentId | null;
  readonly paths: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly offline: string | null;
  readonly listFolder: ListFolder;
}

let latest: ReadonlyMap<string, ShelfFileCheck> = new Map();
function Probe(props: ProbeProps) {
  latest = useArtifactFileChecks(props);
  return null;
}

let renderer: ReactTestRenderer | undefined;
async function render(props: ProbeProps) {
  await act(async () => {
    if (renderer) renderer.update(createElement(Probe, props));
    else renderer = create(createElement(Probe, props));
  });
}

function states() {
  return Object.fromEntries([...latest].map(([path, check]) => [path, check]));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useArtifactFileChecks", () => {
  it("asks an offline machine nothing and calls its files unreachable", async () => {
    const list = host({});
    await render({
      environmentId: HOST,
      paths: ["/tmp/a/one.md", "relative/two.md"],
      enabled: true,
      offline: "Example Mac is offline",
      listFolder: list,
    });
    expect(list.calls).toEqual([]);
    expect(states()).toEqual({
      "/tmp/a/one.md": { state: "unreachable", reason: "Example Mac is offline" },
      "relative/two.md": { state: "unreachable", reason: "Example Mac is offline" },
    });
  });

  it("says present with the size, missing only for a definite absence, and unknown past a cut-short listing", async () => {
    const list = host({
      "/tmp/a": listing(["one.md"]),
      "/tmp/big": listing(["listed.md"], false),
    });
    await render({
      environmentId: HOST,
      paths: [
        "/tmp/a/one.md",
        "/tmp/a/gone.md",
        "/tmp/big/listed.md",
        "/tmp/big/absent.md",
        "notes.md",
      ],
      enabled: true,
      offline: null,
      listFolder: list,
    });
    expect(states()).toEqual({
      "/tmp/a/one.md": { state: "present" },
      "/tmp/a/gone.md": { state: "missing" },
      "/tmp/big/listed.md": { state: "present" },
      "/tmp/big/absent.md": { state: "unknown", reason: "Its folder is too large to check" },
      "notes.md": { state: "unknown", reason: "Not checkable from here" },
    });
    expect(list.calls.toSorted()).toEqual(["/tmp/a", "/tmp/big"]);
  });

  it("reads a refused folder as a failed check unless its parent shows the folder is gone", async () => {
    const list = host({
      "/tmp": listing(["refused"]),
      "/srv": listing(["other"]),
    });
    await render({
      environmentId: HOST,
      paths: ["/tmp/refused/a.md", "/srv/deleted/b.md"],
      enabled: true,
      offline: null,
      listFolder: list,
    });
    expect(states()).toEqual({
      "/tmp/refused/a.md": {
        state: "unreachable",
        reason: "Check failed: the folder could not be listed",
      },
      "/srv/deleted/b.md": { state: "missing" },
    });
  });

  it("gives up on a folder that never answers without holding up the others", async () => {
    vi.useFakeTimers();
    const list = host({ "/tmp/slow": "hang", "/tmp/fast": listing(["a.md"]) });
    await render({
      environmentId: HOST,
      paths: ["/tmp/slow/a.md", "/tmp/fast/a.md"],
      enabled: true,
      offline: null,
      listFolder: list,
    });
    expect(states()).toEqual({
      "/tmp/slow/a.md": { state: "unknown", checking: true },
      "/tmp/fast/a.md": { state: "present", checking: true },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FILE_CHECK_TIMEOUT_MS);
    });
    expect(states()).toEqual({
      "/tmp/slow/a.md": { state: "unreachable", reason: "Check failed: no answer" },
      "/tmp/fast/a.md": { state: "present" },
    });
    // A host that does not answer is not asked about the parent too.
    expect(list.calls.toSorted()).toEqual(["/tmp/fast", "/tmp/slow"]);
  });

  it("checks nothing while closed, and keeps one machine's answers from another", async () => {
    const list = host({ "/tmp/a": listing(["one.md"]) });
    const props = {
      environmentId: HOST,
      paths: ["/tmp/a/one.md"],
      enabled: false,
      offline: null,
      listFolder: list,
    };
    await render(props);
    expect(list.calls).toEqual([]);
    expect(states()).toEqual({ "/tmp/a/one.md": { state: "unknown" } });
    await render({ ...props, enabled: true });
    expect(states()).toEqual({ "/tmp/a/one.md": { state: "present" } });
    // The thread moved: the other machine's answer is not this one's.
    const other = host({});
    let hold: (() => void) | undefined;
    const pending: ListFolder = (folder, signal) => {
      other(folder, signal).catch(() => {});
      return new Promise((resolve) => {
        hold = () => resolve(listing([]));
      });
    };
    await render({ ...props, enabled: true, environmentId: OTHER_HOST, listFolder: pending });
    expect(states()).toEqual({ "/tmp/a/one.md": { state: "unknown", checking: true } });
    await act(async () => hold?.());
    expect(states()).toEqual({ "/tmp/a/one.md": { state: "missing" } });
    // Offline after that: unreachable at once, with no new request.
    await render({
      ...props,
      enabled: true,
      environmentId: OTHER_HOST,
      listFolder: pending,
      offline: "Example Mac is offline",
    });
    expect(states()["/tmp/a/one.md"]).toEqual({
      state: "unreachable",
      reason: "Example Mac is offline",
    });
    expect(other.calls).toEqual(["/tmp/a"]);
  });
});

describe("checkFolder", () => {
  it("checks a Windows folder by its own separators", async () => {
    const list = host({ "C:\\work": listing(["a.md"]) });
    const checks = await checkFolder(list, "C:\\work", ["C:\\work\\a.md", "C:\\work\\b.md"], {
      timeoutMs: FILE_CHECK_TIMEOUT_MS,
      signal: new AbortController().signal,
    });
    expect(Object.fromEntries(checks)).toEqual({
      "C:\\work\\a.md": { state: "present" },
      "C:\\work\\b.md": { state: "missing" },
    });
  });
});
