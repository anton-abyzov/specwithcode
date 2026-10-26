import { assert, it } from "@effect/vitest";
import {
  EnvironmentRequestInvalidError,
  ProjectFolderCheckError,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { failProjectMutation } from "./http.ts";
import { ProjectFolderChangeError } from "./ProjectService.ts";

const projectId = ProjectId.make("project:http-folder-change");

it.effect("carries why a folder change was refused under a stable code", () =>
  Effect.gen(function* () {
    const detail =
      "/Users/me is a protected folder: the home folder, the filesystem root, or a folder that holds them or holds credentials or app data. Choose the project's own folder.";
    const error = yield* failProjectMutation(
      new ProjectFolderChangeError({ projectId, reason: "folder_protected", detail }),
    ).pipe(Effect.flip);
    assert.equal(error._tag, "EnvironmentRequestInvalidError");
    if (error._tag !== "EnvironmentRequestInvalidError") return;
    assert.equal(error.reason, "project_folder_change_refused");
    assert.equal(error.detail, detail);
    assert.equal(error.message, detail);

    // The detail survives the wire, and a client reads it as the message.
    const wire = yield* Schema.encodeEffect(EnvironmentRequestInvalidError)(error);
    const decoded = yield* Schema.decodeUnknownEffect(EnvironmentRequestInvalidError)(
      JSON.parse(JSON.stringify(wire)),
    );
    assert.equal(decoded.message, detail);

    const check = yield* failProjectMutation(
      new ProjectFolderCheckError({ message: "The project was not found." }),
    ).pipe(Effect.flip);
    assert.equal(check.message, "The project was not found.");
  }),
);

it("keeps the generic text when an older server sends no detail", () => {
  const error = new EnvironmentRequestInvalidError({
    code: "invalid_request",
    reason: "project_folder_change_refused",
    traceId: "trace",
  });
  assert.equal(
    error.message,
    "The project folder did not change. Check the folder in project settings before trying again.",
  );
});
