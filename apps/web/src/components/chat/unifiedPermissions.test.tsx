import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind, type ServerProviderModel } from "@specweave-studio/contracts";
import { shouldRenderTraitsControls, TraitsPicker } from "./TraitsPicker";

const models: ServerProviderModel[] = [
  {
    slug: "model",
    name: "Model",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          type: "select",
          label: "Reasoning effort",
          currentValue: "medium",
          options: [{ id: "medium", label: "Medium" }],
        },
        { id: "allowAll", type: "boolean", label: "Allow All", currentValue: false },
      ],
    },
  },
];
const props = {
  provider: ProviderDriverKind.make("acp"),
  model: "model",
  models,
  prompt: "",
  onPromptChange: () => {},
  onModelOptionsChange: () => {},
  planModeEnabled: true,
  modelOptions: [{ id: "allowAll", value: false }],
};
describe("unified composer permissions", () => {
  it("hides cached Allow All from the trigger while preserving reasoning", () => {
    const html = renderToStaticMarkup(<TraitsPicker {...props} />);
    expect(html).toContain("Medium");
    expect(html).not.toContain("Off");
    expect(html).not.toContain("Allow All");
  });
  it("does not resurrect saved permissions for an unavailable model", () => {
    expect(
      shouldRenderTraitsControls({
        ...props,
        provider: ProviderDriverKind.make("opencode"),
        models: [],
      }),
    ).toBe(false);
  });
});
