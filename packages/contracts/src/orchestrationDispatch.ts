import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectCreateFailure } from "./project.ts";

/**
 * A command dispatch failure. `bootstrapThreadDisposition` tells a client whether the
 * thread a bootstrap turn would have created was removed or never created;
 * `projectCreateFailure` says why a new project could not be made.
 */
export class OrchestrationDispatchCommandError extends Schema.TaggedError<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    bootstrapThreadDisposition: Schema.optional(Schema.Literals(["deleted", "not-created"])),
    /** Why `projects.createNew` failed. Absent from older servers and every other command. */
    projectCreateFailure: Schema.optional(ProjectCreateFailure),
  },
) {}
