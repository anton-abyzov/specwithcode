import type { APIRoute } from "astro";

import { buildStudioProjectFileJsonSchema } from "@specweave-studio/shared/studioProjectFile";

// Rendered at build time; published at https://studio.invalid/schema/specweave-studio.json so
// specweave-studio.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildStudioProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
