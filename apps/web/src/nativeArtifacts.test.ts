import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  cachedDetailRead,
  isClaudeArtifactUrl,
  isNativeArtifactCandidate,
  nativeArtifactFromItem,
  nativeArtifactReferences,
  nativeVersionLabel,
  type NativeArtifactToolItem,
  parseArtifactPublishText,
  resolveNativeArtifacts,
} from "./nativeArtifacts";

// Synthetic only: no real page, account or machine.
const URL_V = "https://claude.ai/artifact/ExampleArtifact0001";
const URL_CODE = "https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000002";
const PATH = "/Users/example/work/probe.html";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";

function publish(output: Record<string, unknown>): Record<string, unknown> {
  return {
    url: URL_V,
    path: PATH,
    artifact_id: ARTIFACT_ID,
    title: "Probe page",
    updated: false,
    owned: true,
    audience: "owner",
    seq: 1,
    version: "1700000000-aaaa",
    ...output,
  };
}

function item(overrides: Partial<NativeArtifactToolItem> = {}): NativeArtifactToolItem {
  return {
    id: "item-1",
    type: "dynamic_tool",
    status: "completed",
    toolName: "Artifact",
    input: { file_path: PATH, title: "Probe page" },
    output: publish({}),
    nativeItemRef: { driver: "claudeAgent" },
    completedAt: DateTime.makeUnsafe("2026-10-24T07:28:51.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-24T07:28:51.000Z"),
    ...overrides,
  };
}

describe("nativeArtifactFromItem", () => {
  it("reads a completed publish as one reference with its title, version, path and link", () => {
    expect(nativeArtifactFromItem(item())).toEqual({
      key: `claudeAgent:${URL_V}`,
      provider: "claudeAgent",
      title: "Probe page",
      version: "1700000000-aaaa",
      seq: 1,
      localPath: PATH,
      url: URL_V,
      artifactId: ARTIFACT_ID,
      audience: "owner",
      itemId: "item-1",
      publishedAt: Date.parse("2026-10-24T07:28:51.000Z"),
      source: "structured",
    });
  });

  it("reads the same result kept as JSON text, as a replayed history keeps it", () => {
    const json = JSON.stringify(publish({ seq: 2, updated: true }));
    expect(nativeArtifactFromItem(item({ output: json }))).toMatchObject({
      url: URL_V,
      localPath: PATH,
      seq: 2,
      source: "text",
    });
    expect(nativeArtifactFromItem(item({ output: [{ type: "text", text: json }] }))).toMatchObject({
      url: URL_V,
      seq: 2,
    });
    // A JSON string that only wraps another string is not a result.
    expect(nativeArtifactFromItem(item({ output: JSON.stringify("{ not json") }))).toBeNull();
    expect(nativeArtifactFromItem(item({ output: "{ not json" }))).toBeNull();
  });

  it("reads the structured side field when it arrives wrapped", () => {
    const output = { type: "structured_tool_use_result", value: publish({}), fallbackValue: "" };
    expect(nativeArtifactFromItem(item({ output }))?.url).toBe(URL_V);
  });

  it("accepts both link forms, and keeps an https page elsewhere without its link", () => {
    expect(nativeArtifactFromItem(item({ output: publish({ url: URL_CODE }) }))?.url).toBe(
      URL_CODE,
    );
    const elsewhere = nativeArtifactFromItem(
      item({ output: publish({ url: "https://example.com/artifact/ExampleArtifact0001" }) }),
    );
    expect(elsewhere).toMatchObject({ url: null, localPath: PATH, title: "Probe page" });
    expect(elsewhere?.key).toBe(`claudeAgent:path:${PATH}`);
  });

  it("drops a result whose link is not https", () => {
    for (const url of [
      "http://claude.ai/artifact/ExampleArtifact0001",
      "javascript:alert(1)",
      "claude.ai/artifact/ExampleArtifact0001",
      42,
    ]) {
      expect(nativeArtifactFromItem(item({ output: publish({ url }) })), String(url)).toBeNull();
    }
  });

  it("lists an unchanged republish", () => {
    expect(nativeArtifactFromItem(item({ output: publish({ unchanged: true }) }))).not.toBeNull();
  });

  it("produces nothing for a call that did not finish", () => {
    for (const status of ["failed", "interrupted", "cancelled", "running", "pending"]) {
      expect(nativeArtifactFromItem(item({ status })), status).toBeNull();
    }
    expect(nativeArtifactFromItem(item({ toolNonExecutionKind: "cancelled" }))).toBeNull();
  });

  it("produces nothing for the tool's other actions", () => {
    for (const action of ["read", "list", "status", "watch", "upload_asset", "list_assets"]) {
      expect(nativeArtifactFromItem(item({ input: { action, url: URL_V } })), action).toBeNull();
    }
    const outputs = [
      { read: { url: URL_V, bytes: 10, code: 200 }, artifactRead: { slug: "x" }, owned: true },
      { artifacts: [{ title: "Probe page", url: URL_V }], truncated: false },
      { watch: { url: URL_V, watching: false } },
      { watches: [] },
      { asset_list: [] },
      { written: { url: URL_V }, asset_upload: { id: "a", url: `${URL_V}/assets/a` } },
    ];
    for (const output of outputs) {
      expect(nativeArtifactFromItem(item({ output })), JSON.stringify(output)).toBeNull();
      expect(nativeArtifactFromItem(item({ output: JSON.stringify(output) }))).toBeNull();
    }
  });

  it("produces nothing for other tools or providers", () => {
    for (const toolName of ["ArtifactComments", "ArtifactData", "artifact", null]) {
      expect(nativeArtifactFromItem(item({ toolName })), String(toolName)).toBeNull();
    }
    expect(nativeArtifactFromItem(item({ nativeItemRef: { driver: "codex" } }))).toBeNull();
    expect(nativeArtifactFromItem(item({ nativeItemRef: null }))).toBeNull();
    expect(nativeArtifactFromItem(item({ type: "file_change" }))).toBeNull();
  });

  it("produces nothing for a malformed or failed result", () => {
    const outputs: unknown[] = [
      publish({ url: undefined }),
      publish({ path: undefined }),
      publish({ path: "work/probe.html" }),
      publish({ path: "/Users/example/a\nb.html" }),
      publish({ path: "\\\\server\\share\\probe.html" }),
      publish({ isError: true }),
      publish({ is_error: true }),
      publish({ error: "Artifacts need a claude.ai login." }),
      "Artifacts need a claude.ai login. Run /login and retry.",
      "Published! See https://claude.ai/artifact/ExampleArtifact0001 (not JSON",
      [{ type: "image", source: {} }],
      [],
      42,
      null,
      undefined,
    ];
    for (const output of outputs) {
      expect(nativeArtifactFromItem(item({ output })), JSON.stringify(output)).toBeNull();
    }
    expect(nativeArtifactFromItem(item({ output: undefined, outputOmitted: true }))).toBeNull();
  });

  it("keeps the reference when an optional field is malformed", () => {
    const ref = nativeArtifactFromItem(
      item({
        input: { file_path: PATH },
        output: publish({
          seq: 1.5,
          version: "v".repeat(200),
          artifact_id: 7,
          title: "",
          audience: ["owner"],
        }),
      }),
    );
    expect(ref).toMatchObject({
      seq: null,
      version: null,
      artifactId: null,
      audience: null,
      // No title anywhere: the file's name.
      title: "probe.html",
    });
    expect(nativeArtifactFromItem(item({ output: publish({ seq: 0 }) }))?.seq).toBeNull();
  });

  it("reads the tool's one-line text answer", () => {
    const text = `Published ${PATH} at ${URL_V} (Version 3, version id 1700000003-cccc) Icon: "code".`;
    expect(nativeArtifactFromItem(item({ output: text }))).toMatchObject({
      url: URL_V,
      localPath: PATH,
      seq: 3,
      version: "1700000003-cccc",
      title: "Probe page",
      artifactId: null,
      source: "text",
    });
    expect(
      parseArtifactPublishText(
        `Published ${PATH} at http://claude.ai/artifact/ExampleArtifact0001 (Version 1, version id x)`,
      ),
    ).toBeNull();
    expect(parseArtifactPublishText(`Published ${PATH} at ${URL_V}`)).toBeNull();
  });
});

describe("isClaudeArtifactUrl", () => {
  it("accepts only the two claude.ai page forms, normalized", () => {
    expect(isClaudeArtifactUrl(URL_V)).toBe(URL_V);
    expect(isClaudeArtifactUrl(URL_CODE)).toBe(URL_CODE);
    expect(isClaudeArtifactUrl(`${URL_V}/?utm_source=x#top`)).toBe(URL_V);
    for (const url of [
      "http://claude.ai/artifact/ExampleArtifact0001",
      "https://claude.ai.example.com/artifact/ExampleArtifact0001",
      "https://user@claude.ai/artifact/ExampleArtifact0001",
      "https://claude.ai:8443/artifact/ExampleArtifact0001",
      "https://claude.ai/chat/ExampleArtifact0001",
      "https://claude.ai/code/artifact/not-a-uuid",
      "https://example.com/artifact/ExampleArtifact0001",
      "javascript:alert(1)",
      "",
    ]) {
      expect(isClaudeArtifactUrl(url), url).toBeNull();
    }
  });
});

describe("nativeArtifactReferences", () => {
  it("lists a page once at its newest version, and two pages newest first", () => {
    const refs = nativeArtifactReferences([
      item({ id: "v1" }),
      item({
        id: "other",
        input: { file_path: "/tmp/other.md" },
        output: publish({
          url: URL_CODE,
          path: "/tmp/other.md",
          title: "Other",
          artifact_id: null,
        }),
      }),
      item({
        id: "v2",
        input: { file_path: PATH, url: URL_V },
        output: publish({ seq: 2, updated: true, version: "1700000002-bbbb" }),
      }),
    ]);
    expect(refs.map((ref) => [ref.itemId, ref.seq, ref.version])).toEqual([
      ["v2", 2, "1700000002-bbbb"],
      ["other", 1, "1700000000-aaaa"],
    ]);
  });

  it("names the version by its count, else its id", () => {
    expect(nativeVersionLabel({ seq: 2, version: "x" })).toBe("Version 2");
    expect(nativeVersionLabel({ seq: null, version: "1" })).toBe("Version 1");
    expect(nativeVersionLabel({ seq: null, version: null })).toBeNull();
  });
});

describe("isNativeArtifactCandidate", () => {
  it("asks for a summarized publish, not for a read", () => {
    expect(
      isNativeArtifactCandidate(
        item({ input: { summary: "…", truncated: true }, output: undefined, outputOmitted: true }),
      ),
    ).toBe(true);
    expect(isNativeArtifactCandidate(item({ input: { action: "read", url: URL_V } }))).toBe(false);
    expect(isNativeArtifactCandidate(item({ status: "failed" }))).toBe(false);
  });
});

describe("resolveNativeArtifacts", () => {
  /** The timeline withholds every output; the detail read returns it. */
  function withheld(full: NativeArtifactToolItem): NativeArtifactToolItem {
    return { ...full, output: undefined, outputOmitted: true };
  }

  it("reads each page's newest call once, and an older one only when the newer does not parse", async () => {
    const v1 = item({ id: "v1" });
    const v2 = item({ id: "v2", output: publish({ seq: 2 }) });
    const broken = item({ id: "v3", output: "not a result" });
    const other = item({
      id: "o1",
      input: { file_path: "/tmp/other.md" },
      output: publish({ url: URL_CODE, path: "/tmp/other.md" }),
    });
    const full = new Map([v1, v2, broken, other].map((entry) => [entry.id, entry]));
    const read = vi.fn(async (entry: NativeArtifactToolItem) => full.get(entry.id) ?? null);
    const refs = await resolveNativeArtifacts([v1, v2, broken, other].map(withheld), read);
    expect(read.mock.calls.map(([entry]) => entry.id)).toEqual(["v3", "o1", "v2"]);
    expect(refs.map((ref) => [ref.itemId, ref.seq])).toEqual([
      ["o1", 1],
      ["v2", 2],
    ]);
  });

  it("uses an output the timeline kept without asking", async () => {
    const read = vi.fn(async () => null);
    const refs = await resolveNativeArtifacts([item()], read);
    expect(read).not.toHaveBeenCalled();
    expect(refs).toHaveLength(1);
  });

  it("leaves a page out when the host does not answer, without trying its older calls", async () => {
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    const refs = await resolveNativeArtifacts(
      [withheld(item({ id: "v1" })), withheld(item({ id: "v2" }))],
      read,
    );
    expect(refs).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("caches answers per revision and forgets failures", async () => {
    let fail = true;
    const read = vi.fn(async (entry: NativeArtifactToolItem) => {
      if (fail) throw new Error("offline");
      return entry;
    });
    const cached = cachedDetailRead(read, (entry) => entry.id);
    await expect(cached(item())).rejects.toThrow("offline");
    fail = false;
    await cached(item());
    await cached(item());
    expect(read).toHaveBeenCalledTimes(2);
  });
});
