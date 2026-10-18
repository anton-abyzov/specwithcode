import type { ServerSettings } from "@specweave-studio/contracts";
import * as Layer from "effect/Layer";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as Settings from "../serverSettings.ts";

/** Exercise the same settings-write serialization as the production service. */
export const fallbackPolicyTestLayer = (settings: ServerSettings) =>
  Layer.mergeAll(Settings.layerTest(settings), ProjectAdmission.layer);
