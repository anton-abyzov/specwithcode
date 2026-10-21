/* Host listings for the link settler, read from the fixture's files. */
import { AsyncResult } from "effect/reactivity";

import { listFolder } from "../hostFiles";

export async function executeAtomQuery(
  _registry: unknown,
  request: { readonly search?: true; readonly input: { readonly cwd: string } },
) {
  const entries = request.search ? [] : listFolder(request.input.cwd);
  return entries === null
    ? { _tag: "Failure" as const }
    : AsyncResult.success({ truncated: false, entries });
}
