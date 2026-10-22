// @effect-diagnostics nodeBuiltinImport:off - Test helpers read exported files with Node APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Yauzl from "yauzl";

/** Text of every entry of a ZIP file (a PPTX), by entry name. */
export const readZipText = (bytes: Uint8Array) =>
  new Promise<Map<string, string>>((resolve, reject) => {
    Yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error !== null || zip === undefined) return reject(error ?? new Error("Not a ZIP file."));
      const entries = new Map<string, string>();
      zip.on("entry", (entry: Yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });

/** `ppt/slides/slideN.xml` entries in slide order. */
export const slideXml = (entries: ReadonlyMap<string, string>) =>
  [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((name) => entries.get(name)!);

/** Visible text runs of one slide or notes part. */
export const textRuns = (xml: string) =>
  [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) =>
    match[1]!.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
  );

/** Python with python-pptx for the read-back check; the test is skipped without it. */
export const PYTHON_PPTX_ENV = "STUDIO_TEST_PYTHON_PPTX";
/** When set, exports are also written here as evidence. */
export const EVIDENCE_DIR_ENV = "STUDIO_DESIGN_EVIDENCE_DIR";

export interface PptxReadBack {
  readonly slideWidth: number;
  readonly slideHeight: number;
  readonly slides: ReadonlyArray<{
    readonly texts: ReadonlyArray<string>;
    readonly notes: string;
    readonly shapes: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
  }>;
}

/** Opens a PPTX with python-pptx (apps/server/scripts/pptx-read-back.py) and returns what it read. */
export const pptxReadBack = (python: string, file: string): PptxReadBack => {
  const script = NodePath.resolve(import.meta.dirname, "../../../scripts/pptx-read-back.py");
  const output = NodeChildProcess.execFileSync(python, ["-I", script, file], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(output) as PptxReadBack;
};
