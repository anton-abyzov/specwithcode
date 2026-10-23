import type { ServerProviderModel } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { imageInputBlockReason, modelRejectsImages } from "./composerImageInput";

const model = (slug: string, imageInput?: boolean): ServerProviderModel => ({
  slug,
  name: `Model ${slug}`,
  isCustom: false,
  capabilities: null,
  ...(imageInput === undefined ? {} : { imageInput }),
});

const models = [model("text-only", false), model("vision", true), model("unreported")];

describe("imageInputBlockReason", () => {
  it("blocks images to a model that reports it cannot read them", () => {
    expect(imageInputBlockReason({ model: "text-only", models, imageCount: 1 })).toBe(
      "Model text-only can't read images. Remove the image or pick another model.",
    );
  });

  it("allows a message without images to that model", () => {
    expect(imageInputBlockReason({ model: "text-only", models, imageCount: 0 })).toBeNull();
  });

  it("allows images when the model reads them or does not say", () => {
    expect(imageInputBlockReason({ model: "vision", models, imageCount: 2 })).toBeNull();
    expect(imageInputBlockReason({ model: "unreported", models, imageCount: 1 })).toBeNull();
    expect(imageInputBlockReason({ model: "missing", models, imageCount: 1 })).toBeNull();
  });
});

describe("modelRejectsImages", () => {
  it("is true only for a model that reports no image input", () => {
    expect(modelRejectsImages("text-only", models)).toBe(true);
    expect(modelRejectsImages("vision", models)).toBe(false);
    expect(modelRejectsImages("unreported", models)).toBe(false);
    expect(modelRejectsImages("missing", models)).toBe(false);
  });
});
