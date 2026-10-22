import {
  AssetResource,
  type DesignAddress,
  type DesignDocument,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useMemo } from "react";
import { useAssetUrls } from "~/assets/assetUrls";

const EMPTY_RESOURCES: readonly AssetResource[] = [];
const isAssetResource = Schema.is(AssetResource);

/**
 * The asset resource for one design image, or null while the contract has no
 * `design-asset` member. `useAssetUrls` decodes its key against the
 * AssetResource union and throws during render on an unknown tag, so an
 * unsupported resource must never reach it; the node keeps its placeholder.
 * When the server lane adds `design-asset`, this starts returning resources
 * with no change here.
 */
export function designAssetResource(address: DesignAddress, asset: string): AssetResource | null {
  const candidate: unknown = {
    _tag: "design-asset",
    owner: address.owner,
    designId: address.designId,
    asset,
  };
  return isAssetResource(candidate) ? candidate : null;
}

/** Image node asset names in a document, sorted and unique. */
export function designImageAssets(document: DesignDocument | null): string[] {
  const names = new Set<string>();
  for (const page of document?.pages ?? [])
    for (const node of page.nodes) if (node.type === "image") names.add(node.asset);
  return [...names].sort();
}

/**
 * Image assets resolve through the app's signed asset URLs. Until a URL
 * resolves (or while the contract lacks the resource) the node shows its
 * placeholder box.
 */
export function useDesignAssetUrls(
  environmentId: EnvironmentId,
  address: DesignAddress,
  document: DesignDocument | null,
) {
  const assets = useMemo(() => designImageAssets(document), [document]);
  const entries = useMemo(
    () =>
      assets.flatMap((asset) => {
        const resource = designAssetResource(address, asset);
        return resource === null ? [] : [{ asset, resource }];
      }),
    [address, assets],
  );
  const resources = useMemo(
    () => (entries.length === 0 ? EMPTY_RESOURCES : entries.map((entry) => entry.resource)),
    [entries],
  );
  const urls = useAssetUrls(environmentId, resources);
  return useMemo(() => {
    const map = new Map(entries.map((entry, i) => [entry.asset, urls[i] ?? ""]));
    return (asset: string) => map.get(asset) ?? "";
  }, [entries, urls]);
}
