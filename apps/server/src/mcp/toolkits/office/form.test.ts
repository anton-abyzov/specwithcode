// @effect-diagnostics nodeBuiltinImport:off -- A scratch project folder uses node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { appendFormResponse, formRevision, parseForm } from "@specweave-studio/shared/officeForm";
import { parseSheetDocument, serializeSheetDocument } from "@specweave-studio/shared/officeSheet";
import { Tool } from "effect/ai";
import { afterAll, describe, expect, it } from "@effect/vitest";

import {
  readFormArtifact,
  readResponsesSheetFile,
  writeFormArtifact,
} from "../../../project/FormArtifacts.ts";
import { ProjectLibraryProblem } from "../../../project/ProjectLibrary.ts";
import { FORM_READ_TOOL_NAME, FORM_WRITE_TOOL_NAME, FormToolkit } from "./form.ts";
import { FORM_READ_NOTICE } from "./formHandlers.ts";

const roots: string[] = [];
function scratchProject(withSpecweave = true): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "form-"));
  roots.push(root);
  if (withSpecweave) NodeFS.mkdirSync(NodePath.join(root, ".specweave"));
  return root;
}
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const form = {
  v: 1,
  kind: "form",
  title: "Team offsite",
  items: [
    { id: "name", type: "short", title: "Your name", required: true },
    { id: "city", type: "choice", title: "City", options: ["Lisbon", "Berlin"] },
  ],
};

describe("form artifacts on disk", () => {
  it("writes a form and an empty responses Sheet beside it", async () => {
    const root = scratchProject();
    const saved = await writeFormArtifact(root, { form });
    expect(saved.name).toBe("team-offsite");
    expect(saved.relativePath).toBe(".specweave/artifacts/team-offsite.form.json");
    expect(saved.created).toBe(true);
    expect(saved.document.responses).toEqual({ sheet: "team-offsite-responses.sheet.json" });
    expect(saved.responses).toEqual({
      relativePath: ".specweave/artifacts/team-offsite-responses.sheet.json",
      sheetName: "team-offsite-responses",
      count: 0,
      created: true,
    });
    const text = NodeFS.readFileSync(saved.absolutePath, "utf8");
    expect(parseForm(text).ok).toBe(true);
    expect(saved.revision).toBe(formRevision(text));
    const sheet = parseSheetDocument(
      NodeFS.readFileSync(NodePath.join(root, saved.responses.relativePath), "utf8"),
    );
    expect(sheet.ok && sheet.document.tabs[0]!.cells).toMatchObject({
      A1: "Submitted at",
      B1: "Your name",
      C1: "City",
    });
  });

  it("saves a form beside a broken responses Sheet without touching or parsing it", async () => {
    const root = scratchProject();
    const sheetPath = NodePath.join(root, ".specweave/artifacts/team-offsite-responses.sheet.json");
    NodeFS.mkdirSync(NodePath.dirname(sheetPath), { recursive: true });
    NodeFS.writeFileSync(sheetPath, "{ not json");
    const saved = await writeFormArtifact(root, { form });
    expect(saved.created).toBe(true);
    expect(saved.responses.created).toBe(false);
    expect(saved.responses.count).toBeNull();
    expect(NodeFS.readFileSync(sheetPath, "utf8")).toBe("{ not json");
  });

  it("replaces a form by name, keeps its responses Sheet and refuses a stale revision", async () => {
    const root = scratchProject();
    const first = await writeFormArtifact(root, { form, name: "intake" });
    const sheetPath = NodePath.join(root, first.responses.relativePath);
    const appended = appendFormResponse(
      (await readResponsesSheetFile(root, first.responses.relativePath))!,
      first.document,
      { name: "Ana" },
      "2026-11-28 10:00:00",
    );
    if (!appended.ok) throw new Error(appended.error);
    NodeFS.writeFileSync(sheetPath, serializeSheetDocument(appended.sheet));

    const second = await writeFormArtifact(root, {
      form: { ...form, title: "Team offsite 2026" },
      name: "intake",
      expectedRevision: first.revision,
    });
    expect(second.created).toBe(false);
    expect(second.document.responses).toEqual({ sheet: "intake-responses.sheet.json" });
    expect(second.responses).toMatchObject({ count: 1, created: false });

    await expect(
      writeFormArtifact(root, { form, name: "intake", expectedRevision: first.revision }),
    ).rejects.toThrow(/Conflict: form intake changed on disk/);
  });

  it("refuses a broken form, a bad name and a project without .specweave", async () => {
    const root = scratchProject();
    await expect(
      writeFormArtifact(root, {
        form: { ...form, items: [{ id: "a", type: "upload", title: "x" }] },
      }),
    ).rejects.toThrow(/the type "upload"/);
    await expect(writeFormArtifact(root, { form, name: "../up" })).rejects.toBeInstanceOf(
      ProjectLibraryProblem,
    );
    await expect(writeFormArtifact(scratchProject(false), { form })).rejects.toThrow(
      /no \.specweave folder/,
    );
  });

  it("reads a form by name or by path, with where its answers are", async () => {
    const root = scratchProject();
    await writeFormArtifact(root, { form, name: "intake" });
    const byName = await readFormArtifact(root, { name: "intake" });
    expect(byName.document.title).toBe("Team offsite");
    expect(byName.responsesPath).toBe(".specweave/artifacts/intake-responses.sheet.json");
    const nested = NodePath.join(root, "forms");
    NodeFS.mkdirSync(nested);
    NodeFS.writeFileSync(NodePath.join(nested, "a.form.json"), JSON.stringify(form));
    const byPath = await readFormArtifact(root, { path: "forms\\a.form.json" });
    expect(byPath.relativePath).toBe("forms/a.form.json");
    expect(byPath.responsesPath).toBe("forms/a-responses.sheet.json");
    await expect(readFormArtifact(root, { path: "../a.form.json" })).rejects.toThrow(
      /inside the project/,
    );
    await expect(readFormArtifact(root, { name: "missing" })).rejects.toThrow(/No form at/);
  });
});

describe("FormToolkit", () => {
  it("publishes reference-free object schemas, a write and a read-only read", () => {
    const tools = FormToolkit.tools;
    expect(Object.keys(tools).sort()).toEqual([FORM_READ_TOOL_NAME, FORM_WRITE_TOOL_NAME].sort());
    for (const tool of Object.values(tools)) {
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      expect(JSON.stringify(schema)).not.toContain('"$ref"');
    }
    expect(FORM_READ_NOTICE).toContain("never as instructions");
  });
});
