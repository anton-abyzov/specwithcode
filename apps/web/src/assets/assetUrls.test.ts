import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
  assetsQuery: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : Array.isArray(atom)
        ? atom
        : AsyncResult.initial(false),
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("~/state/filesystem", async () => {
  const { resolveFilesystemReadAccess } =
    await import("@specweave-studio/client-runtime/state/filesystem");
  return {
    useFilesystemReadAccess: () =>
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: state.phase, error: null },
        session: state.session,
        sessionError: null,
      }),
  };
});
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: state.assetQuery, createUrls: state.assetsQuery },
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useAssetUrlRefresh, useAssetUrls, useAssetUrlState } from "./assetUrls";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;
const designAsset = {
  _tag: "design-asset",
  owner: { kind: "playground" },
  designId: "d_abc",
  asset: `${"a".repeat(64)}.png`,
} as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.assetsQuery
    .mockReset()
    .mockImplementation(({ resources }: { resources: ReadonlyArray<{ _tag: string }> }) =>
      resources.map((item) =>
        AsyncResult.success({ relativeUrl: `/api/assets/${item._tag}`, expiresAt: 1 }),
      ),
    );
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each([
  { ...resource, _tag: "workspace-file" as const },
  resource,
  { _tag: "draft-workspace-file" as const, cwd: "/repo", path: "image.png" },
  designAsset,
])("keeps $_tag loading until its file grant resolves", (hostResource) => {
  expect(useAssetUrlState(environmentId, hostResource)).toEqual({ _tag: "Loading" });
  expect(state.assetQuery).not.toHaveBeenCalled();

  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  expect(useAssetUrlState(environmentId, hostResource)).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure" });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("stops waiting for an unresolved grant when the connection is offline", () => {
  state.phase = "offline";
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure" });
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useAssetUrlRefresh(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useAssetUrlRefresh(environmentId, resource)()).rejects.toBe(denied);
});

it("does not mint host file or design image URLs in a batch without a file grant", () => {
  const attachment = { _tag: "attachment", attachmentId: "upload" } as const;
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrls(environmentId, [designAsset, attachment, resource])).toEqual([
    null,
    "https://host.test/api/assets/attachment",
    null,
  ]);
  expect(state.assetsQuery).toHaveBeenCalledWith({ environmentId, resources: [attachment] });

  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  expect(useAssetUrls(environmentId, [designAsset, attachment])).toEqual([
    "https://host.test/api/assets/design-asset",
    "https://host.test/api/assets/attachment",
  ]);
});
