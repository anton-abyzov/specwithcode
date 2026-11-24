import type { EnvironmentId } from "@specweave-studio/contracts";
import { expect, it } from "vite-plus/test";
import { approveInput } from "./copySecretsPolicy";

const M4 = "m4" as EnvironmentId;

it("binds an approval to the preview revision the window acted on", () => {
  expect(approveInput("op", M4, false, null, "m3", "a".repeat(64))).toEqual({
    operationId: "op",
    withoutSecrets: true,
    previewRevision: "a".repeat(64),
  });
});

it("approves unbound when the destination named no revision (an older machine)", () => {
  expect(approveInput("op", M4, false, null, "m3", undefined)).toEqual({
    operationId: "op",
    withoutSecrets: true,
  });
});
