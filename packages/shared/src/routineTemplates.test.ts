import { ScheduledTaskUpsertSchedule } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ROUTINE_TEMPLATES, routineTemplate } from "./routineTemplates.ts";

describe("routine templates", () => {
  it("offers the four personal routines with phone-length names", () => {
    expect(ROUTINE_TEMPLATES.map((template) => template.title)).toEqual([
      "Monthly tax prep",
      "Monthly profit and loss",
      "Research brief",
      "Email triage and draft replies",
    ]);
    for (const template of ROUTINE_TEMPLATES) {
      expect(template.title.length).toBeLessThanOrEqual(32);
      expect(template.summary.length).toBeLessThanOrEqual(64);
      expect(routineTemplate(template.id)).toBe(template);
    }
  });

  it("routes project work and never acts outside the Mac", () => {
    for (const template of ROUTINE_TEMPLATES) {
      expect(template.prompt).toContain("studio_project_route");
      // Sending, filing or paying appear only as things not to do.
      expect(template.prompt).not.toMatch(/\b(send|file|pay)\s+(the|my|it|this)\b/i);
    }
    expect(routineTemplate("email-triage")?.prompt).toContain("do not send");
  });

  it("suggests only valid monthly cadences", () => {
    const decode = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
    for (const template of ROUTINE_TEMPLATES)
      if (template.suggestedCadence !== null)
        expect(decode(template.suggestedCadence)).toEqual(template.suggestedCadence);
  });
});
