import type { DesignSystem } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  intentLabel,
  inverseOperations,
  newComponentId,
  newModeId,
  operationsFor,
  tokenToEdit,
} from "./systemEditIntents";
import { TEST_SYSTEM, testToken } from "./testSystem";

const token = (name: string) => TEST_SYSTEM.tokens.find((candidate) => candidate.name === name)!;

describe("operations for an intent", () => {
  it("changes one mode's value and keeps the others", () => {
    expect(
      operationsFor(TEST_SYSTEM, {
        kind: "set-value",
        name: "color-brand",
        modeId: "dark",
        raw: " #6066ff ",
      }),
    ).toEqual([
      {
        op: "put_token",
        token: {
          name: "color-brand",
          type: "color",
          group: "color",
          values: { light: "#595ecc", dark: "#6066ff" },
        },
      },
    ]);
  });

  it("lets a later mode inherit again, but never the first mode", () => {
    const [operation] = operationsFor(TEST_SYSTEM, {
      kind: "set-value",
      name: "color-brand",
      modeId: "dark",
      raw: null,
    });
    expect(operation).toMatchObject({ op: "put_token", token: { values: { light: "#595ecc" } } });
    expect(
      operationsFor(TEST_SYSTEM, {
        kind: "set-value",
        name: "color-brand",
        modeId: "light",
        raw: null,
      }),
    ).toEqual([]);
    expect(
      operationsFor(TEST_SYSTEM, {
        kind: "set-value",
        name: "color-scrim",
        modeId: "dark",
        raw: null,
      }),
    ).toEqual([]);
  });

  it("records an alias written by hand and drops it when the value is literal again", () => {
    const [aliased] = operationsFor(TEST_SYSTEM, {
      kind: "set-value",
      name: "color-ink",
      modeId: "light",
      raw: "{color-brand}",
    });
    expect(aliased).toMatchObject({ token: { aliasOf: "color-brand" } });
    const linked: DesignSystem = {
      ...TEST_SYSTEM,
      tokens: [{ ...token("color-link"), aliasOf: "color-brand" }],
    };
    const [literal] = operationsFor(linked, {
      kind: "set-value",
      name: "color-link",
      modeId: "light",
      raw: "#111111",
    });
    expect(literal).toEqual({
      op: "put_token",
      token: { name: "color-link", type: "color", group: "color", values: { light: "#111111" } },
    });
  });

  it("replaces an import's default value when the first mode is written", () => {
    const system: DesignSystem = {
      ...TEST_SYSTEM,
      tokens: [
        {
          name: "gap",
          type: "dimension",
          values: {
            default: {
              raw: "4px",
              resolved: "4px",
              provenance: { source: "file", location: "x", extractor: "y" },
            },
          },
        },
      ],
    };
    expect(
      operationsFor(system, { kind: "set-value", name: "gap", modeId: "light", raw: "6px" }),
    ).toEqual([
      { op: "put_token", token: { name: "gap", type: "dimension", values: { light: "6px" } } },
    ]);
  });

  it("writes nothing when nothing changes or the token is gone", () => {
    expect(
      operationsFor(TEST_SYSTEM, {
        kind: "set-value",
        name: "space-1",
        modeId: "light",
        raw: "4px",
      }),
    ).toEqual([]);
    expect(operationsFor(TEST_SYSTEM, { kind: "remove", name: "missing" })).toEqual([]);
    expect(operationsFor(TEST_SYSTEM, { kind: "rename", from: "space-1", to: "space-1" })).toEqual(
      [],
    );
    expect(operationsFor(TEST_SYSTEM, { kind: "delete-mode", id: "nope" })).toEqual([]);
    expect(
      operationsFor(
        { ...TEST_SYSTEM, modes: [{ id: "light", name: "Light" }] },
        {
          kind: "delete-mode",
          id: "light",
        },
      ),
    ).toEqual([]);
  });

  it("renames, removes and saves usage notes", () => {
    expect(
      operationsFor(TEST_SYSTEM, { kind: "rename", from: "space-1", to: " space-xs " }),
    ).toEqual([{ op: "rename_token", from: "space-1", to: "space-xs" }]);
    expect(operationsFor(TEST_SYSTEM, { kind: "remove", name: "space-2" })).toEqual([
      { op: "delete_token", name: "space-2" },
    ]);
    expect(
      operationsFor(TEST_SYSTEM, { kind: "set-usage", name: "space-2", text: " Gaps in rows. " }),
    ).toEqual([
      {
        op: "put_token",
        token: {
          name: "space-2",
          type: "dimension",
          group: "spacing",
          description: "Gaps in rows.",
          values: { light: "8px" },
        },
      },
    ]);
    const [cleared] = operationsFor(TEST_SYSTEM, {
      kind: "set-usage",
      name: "color-ink",
      text: "",
    });
    expect(cleared).toMatchObject({ op: "put_token" });
    expect("description" in (cleared as { token: object }).token).toBe(false);
  });

  it("adds a token with trimmed values and drops empty modes", () => {
    expect(
      operationsFor(TEST_SYSTEM, {
        kind: "add",
        token: {
          name: " accent-500 ",
          type: "color",
          group: "color",
          values: { light: " #ff0000 ", dark: "" },
          description: "  ",
        },
      }),
    ).toEqual([
      {
        op: "put_token",
        token: { name: "accent-500", type: "color", group: "color", values: { light: "#ff0000" } },
      },
    ]);
  });

  it("edits the system's info and modes", () => {
    expect(operationsFor(TEST_SYSTEM, { kind: "set-info", name: "Harbor UI" })).toEqual([]);
    expect(operationsFor(TEST_SYSTEM, { kind: "set-info", description: "" })).toEqual([
      { op: "set_info", description: null },
    ]);
    expect(
      operationsFor(TEST_SYSTEM, { kind: "put-mode", id: "hc", name: "High contrast" }),
    ).toEqual([{ op: "put_mode", mode: { id: "hc", name: "High contrast" } }]);
    expect(operationsFor(TEST_SYSTEM, { kind: "delete-mode", id: "dark" })).toEqual([
      { op: "delete_mode", modeId: "dark" },
    ]);
  });
});

describe("undo", () => {
  it("puts back a changed token, deletes an added one and renames back", () => {
    const changed = operationsFor(TEST_SYSTEM, {
      kind: "set-value",
      name: "space-1",
      modeId: "light",
      raw: "6px",
    });
    expect(inverseOperations(TEST_SYSTEM, changed)).toEqual([
      { op: "put_token", token: tokenToEdit(token("space-1")) },
    ]);
    const added = operationsFor(TEST_SYSTEM, {
      kind: "add",
      token: { name: "space-3", type: "dimension", group: "spacing", values: { light: "12px" } },
    });
    expect(inverseOperations(TEST_SYSTEM, added)).toEqual([
      { op: "delete_token", name: "space-3" },
    ]);
    expect(
      inverseOperations(TEST_SYSTEM, [{ op: "rename_token", from: "space-1", to: "space-xs" }]),
    ).toEqual([{ op: "rename_token", from: "space-xs", to: "space-1" }]);
    expect(inverseOperations(TEST_SYSTEM, [{ op: "delete_token", name: "color-ink" }])).toEqual([
      { op: "put_token", token: tokenToEdit(token("color-ink")) },
    ]);
  });

  it("brings a removed mode back before its values", () => {
    const inverse = inverseOperations(TEST_SYSTEM, [{ op: "delete_mode", modeId: "dark" }]);
    expect(inverse[0]).toEqual({ op: "put_mode", mode: { id: "dark", name: "Dark" } });
    expect(inverse.slice(1).every((operation) => operation.op === "put_token")).toBe(true);
    expect(inverse.length).toBe(
      1 + TEST_SYSTEM.tokens.filter((candidate) => candidate.values.dark !== undefined).length,
    );
  });

  it("restores info, components and new modes", () => {
    expect(inverseOperations(TEST_SYSTEM, [{ op: "set_info", description: null }])).toEqual([
      { op: "set_info", description: "Calm tables and one indigo brand color." },
    ]);
    expect(
      inverseOperations(TEST_SYSTEM, [{ op: "put_mode", mode: { id: "hc", name: "HC" } }]),
    ).toEqual([{ op: "delete_mode", modeId: "hc" }]);
    const [restored] = inverseOperations(TEST_SYSTEM, [
      { op: "delete_component", componentId: "button" },
    ]);
    expect(restored).toMatchObject({ op: "put_component", component: { id: "button" } });
    expect("provenance" in (restored as { component: object }).component).toBe(false);
  });
});

describe("labels and ids", () => {
  it("says what happened", () => {
    expect(intentLabel({ kind: "remove", name: "space-2" })).toBe("Removed space-2");
    expect(intentLabel({ kind: "rename", from: "a", to: "b" })).toBe("Renamed a to b");
    expect(intentLabel({ kind: "set-value", name: "x", modeId: "dark", raw: null })).toBe(
      "x now matches the first mode",
    );
  });

  it("makes unique mode and component ids", () => {
    expect(newModeId("High contrast", ["light", "dark"])).toBe("high-contrast");
    expect(newModeId("Dark", ["light", "dark"])).toBe("dark-2");
    expect(newModeId("  ", [])).toBe("mode");
    expect(newComponentId("Price tag", ["html:Price-tag"])).toBe("html:Price-tag-2");
  });

  it("copies a stored token's raw values", () => {
    expect(tokenToEdit(testToken("a", "color", undefined, "#fff", "#000", "Note"))).toEqual({
      name: "a",
      type: "color",
      description: "Note",
      values: { light: "#fff", dark: "#000" },
    });
  });
});
