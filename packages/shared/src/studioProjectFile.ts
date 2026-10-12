import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { StudioProjectFile, STUDIO_PROJECT_FILE_SCHEMA_URL } from "@specweave-studio/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `specweave-studio.json` file contents (lenient JSONC string) and the
 * decoded {@link StudioProjectFile}.
 */
export const StudioProjectFileFromJson = fromLenientJson(StudioProjectFile);

const decodeStudioProjectFile = Schema.decodeExit(StudioProjectFileFromJson);

/**
 * Decode raw `specweave-studio.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseStudioProjectFile(contents: string): StudioProjectFile | null {
  const decoded = decodeStudioProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `specweave-studio.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link STUDIO_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildStudioProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in specweave-studio.json.
  const document = Schema.toJsonSchemaDocument(StudioProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: STUDIO_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
