import { parseAssetCollectionKey } from "@specweave-studio/client-runtime/state/assets";
import type { DesignAddress, DesignDocument, EnvironmentId } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { designAssetResource, useDesignAssetUrls } from "./designAssets";

const environmentId = "env-test" as EnvironmentId;
const ASSET = `${"ab".repeat(32)}.png`;
const address = { owner: { kind: "playground" }, designId: "d_assets" } as DesignAddress;

function withImage(): DesignDocument {
  const document = newDesignDocument({
    id: "d_assets",
    kind: "design",
    title: "Assets",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => 0.5,
  });
  const outcome = applyDesignOperations(document, [
    {
      op: "add_node",
      pageId: document.pages[0]!.id,
      node: {
        id: "n_img",
        parentId: null,
        type: "image",
        asset: ASSET,
        x: 0,
        y: 0,
        width: 40,
        height: 40,
      },
    },
  ]);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

function Probe({ document }: { document: DesignDocument }) {
  // The real hook chain: useDesignAssetUrls -> useAssetUrls -> assetEnvironment.createUrls.
  const assetUrl = useDesignAssetUrls(environmentId, address, document);
  return <span data-url={assetUrl(ASSET)}>{assetUrl(ASSET) || "placeholder"}</span>;
}

describe("design image assets", () => {
  it("renders a design with an image node through the real asset hook without throwing", () => {
    const html = renderToStaticMarkup(<Probe document={withImage()} />);
    expect(html).toContain("placeholder");
  });

  it("never hands useAssetUrls a resource the AssetResource union rejects", () => {
    const raw = { _tag: "design-asset", ...address, asset: ASSET };
    const decodes = (() => {
      try {
        parseAssetCollectionKey(JSON.stringify([environmentId, [raw]]));
        return true;
      } catch {
        return false;
      }
    })();
    // Whatever the contract says, the resolver only returns what decodes.
    expect(designAssetResource(address, ASSET) !== null).toBe(decodes);
  });
});
