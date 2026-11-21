// @effect-diagnostics nodeBuiltinImport:off - Creates temporary local bundle fixtures for offline artifact library tests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { rewriteLocalArtifactLibraries } from "./localArtifactLibs.ts";

const tempDirs: string[] = [];

function makeTempStaticDir(mermaidSource: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-artifact-libs-"));
  tempDirs.push(dir);
  const libDir = NodePath.join(dir, "artifact-libs");
  NodeFS.mkdirSync(libDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(libDir, "mermaid.min.js"), mermaidSource, "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("rewriteLocalArtifactLibraries", () => {
  it("rewrites allowlisted mermaid@11 CDN script tags into inline local bundles", () => {
    const staticDir = makeTempStaticDir('window.mermaid={v:"11",close:"</script>"};');
    const html = [
      "<!doctype html><html><head>",
      '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>',
      '<script src="https://unpkg.com/mermaid@11.4.0/dist/mermaid.min.js"></script>',
      "</head><body><div class=\"mermaid\">graph TD; A-->B;</div></body></html>",
    ].join("\n");

    const result = rewriteLocalArtifactLibraries(html, { staticDir, maxPageBytes: 100_000 });
    expect(result).toContain('<script data-local-artifact-lib="mermaid">');
    // Escapes embedded </script> safely and only injects once
    expect(result).toContain('<\\/script>');
    expect(result.match(/data-local-artifact-lib="mermaid"/g)).toHaveLength(1);
    expect(result).not.toContain("cdn.jsdelivr.net");
    expect(result).not.toContain("unpkg.com");
  });

  it("skips type=module, nomodule, and non-allowlisted URLs", () => {
    const staticDir = makeTempStaticDir("window.mermaid={};");
    const html = [
      '<script type="module" src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"></script>',
      '<script nomodule src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>',
      '<script src="https://evil.example/mermaid@11/dist/mermaid.min.js"></script>',
      '<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>',
    ].join("\n");

    const result = rewriteLocalArtifactLibraries(html, { staticDir, maxPageBytes: 100_000 });
    expect(result).toBe(html);
  });

  it("leaves the CDN tag untouched when inlining would exceed maxPageBytes", () => {
    const staticDir = makeTempStaticDir("x".repeat(500));
    const html = '<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.0/mermaid.min.js"></script>';

    const result = rewriteLocalArtifactLibraries(html, { staticDir, maxPageBytes: 200 });
    expect(result).toBe(html);
  });

  it("ignores commented-out script tags and preserves nonce attributes", () => {
    const staticDir = makeTempStaticDir("window.mermaid={ok:true};");
    const html = [
      '<!-- <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script> -->',
      '<script nonce="abc123" src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>',
    ].join("\n");

    const result = rewriteLocalArtifactLibraries(html, { staticDir, maxPageBytes: 100_000 });
    expect(result).toContain('<!-- <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script> -->');
    expect(result).toContain('<script data-local-artifact-lib="mermaid" nonce="abc123">window.mermaid={ok:true};</script>');
  });
});
