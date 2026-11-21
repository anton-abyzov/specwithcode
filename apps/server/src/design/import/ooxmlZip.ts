/**
 * Defensive Office Open XML (ZIP) reader shared by Excel (.xlsx) and Word (.docx)
 * read-only previews. Enforces strict archive size, entry count, unpacked byte,
 * path-safety, macro-rejection, and XML element budgets.
 */
import * as Yauzl from "yauzl";

import {
  parseXml,
  XML_LIMITS,
  XmlRefused,
  type XmlBudget,
  type XmlElement,
} from "./xml.ts";

export interface OoxmlZipLimits {
  readonly fileBytes: number;
  readonly entries: number;
  readonly unpackedBytes: number;
  readonly xmlPartBytes: number;
  readonly xmlElements: number;
}

export const DEFAULT_OOXML_LIMITS: OoxmlZipLimits = {
  fileBytes: 25 * 1024 * 1024,
  entries: 2_000,
  unpackedBytes: 150 * 1024 * 1024,
  xmlPartBytes: XML_LIMITS.partChars,
  xmlElements: 1_000_000,
};

export class OoxmlPreviewError extends Error {
  readonly code: "invalid" | "too_large";
  constructor(code: "invalid" | "too_large", message: string) {
    super(message);
    this.code = code;
  }
}

export const MACRO_CONTENT_TYPE_RE = /macroenabled|vbaproject|activex|vnd\.ms-office\.vba/i;

/** Normalizes a ZIP entry path and refuses traversal or absolute paths. */
export function normalizeZipPath(raw: string): string | null {
  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.length === 0 || cleaned.endsWith("/")) return null;
  const parts = cleaned.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    stack.push(part);
  }
  return stack.length > 0 ? stack.join("/") : null;
}

/** Resolves an OOXML relationship Target relative to the owning part's directory. */
export function resolveOoxmlTarget(ownerPart: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  if (target.startsWith("/")) return normalizeZipPath(target);
  const slash = ownerPart.lastIndexOf("/");
  const baseParts = slash >= 0 ? ownerPart.slice(0, slash).split("/") : [];
  const rawParts = target.replace(/\\/g, "/").split("/");
  const stack = [...baseParts];
  for (const part of rawParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack.join("/") : null;
}

export interface OoxmlArchive {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly xmlBudget: XmlBudget;
  readXml: (partPath: string) => XmlElement | null;
  hasPart: (partPath: string) => boolean;
}

export function openOoxmlArchive(
  bytes: Uint8Array,
  limits: OoxmlZipLimits = DEFAULT_OOXML_LIMITS,
): Promise<OoxmlArchive> {
  if (bytes.byteLength > limits.fileBytes) {
    return Promise.reject(
      new OoxmlPreviewError("too_large", "The file is larger than the preview size limit."),
    );
  }
  return new Promise((resolve, reject) => {
    Yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (openErr, zipfile) => {
        if (openErr || !zipfile) {
          reject(new OoxmlPreviewError("invalid", "The file is not a valid Office Open XML archive."));
          return;
        }
        const entries = new Map<string, Uint8Array>();
        let entryCount = 0;
        let unpackedBytes = 0;
        let settled = false;
        const fail = (err: OoxmlPreviewError) => {
          if (settled) return;
          settled = true;
          try {
            zipfile.close();
          } catch {
            // ignore
          }
          reject(err);
        };

        if (zipfile.entryCount > limits.entries) {
          fail(new OoxmlPreviewError("too_large", "The archive has too many entries to preview."));
          return;
        }

        zipfile.on("error", () => {
          fail(new OoxmlPreviewError("invalid", "The Office archive is corrupted or unreadable."));
        });

        zipfile.on("end", () => {
          if (settled) return;
          settled = true;
          const xmlBudget: XmlBudget = { elements: limits.xmlElements, used: 0 };
          const decoder = new TextDecoder("utf-8", { fatal: false });
          const readXml = (partPath: string): XmlElement | null => {
            const raw = entries.get(partPath);
            if (!raw) return null;
            if (raw.byteLength > limits.xmlPartBytes) {
              throw new OoxmlPreviewError("too_large", "An XML part inside the document is too large.");
            }
            const text = decoder.decode(raw);
            try {
              return parseXml(text, xmlBudget);
            } catch (error) {
              if (error instanceof XmlRefused) {
                throw new OoxmlPreviewError(
                  error.tooLarge ? "too_large" : "invalid",
                  error.message,
                );
              }
              throw new OoxmlPreviewError("invalid", "An XML part inside the document is malformed.");
            }
          };
          resolve({
            entries,
            xmlBudget,
            readXml,
            hasPart: (partPath) => entries.has(partPath),
          });
        });

        zipfile.on("entry", (entry: Yauzl.Entry) => {
          if (settled) return;
          entryCount += 1;
          if (entryCount > limits.entries) {
            fail(new OoxmlPreviewError("too_large", "The archive has too many entries to preview."));
            return;
          }
          if (entry.fileName.endsWith("/")) {
            zipfile.readEntry();
            return;
          }
          const normalized = normalizeZipPath(entry.fileName);
          if (!normalized) {
            fail(new OoxmlPreviewError("invalid", "The archive contains an unsafe path."));
            return;
          }
          if (entry.uncompressedSize > limits.unpackedBytes) {
            fail(new OoxmlPreviewError("too_large", "The archive expands beyond the preview limit."));
            return;
          }
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              fail(new OoxmlPreviewError("invalid", "Could not read an entry from the archive."));
              return;
            }
            const chunks: Buffer[] = [];
            let entryBytes = 0;
            stream.on("data", (chunk: Buffer) => {
              entryBytes += chunk.byteLength;
              unpackedBytes += chunk.byteLength;
              if (unpackedBytes > limits.unpackedBytes) {
                stream.destroy();
                fail(
                  new OoxmlPreviewError("too_large", "The archive expands beyond the preview limit."),
                );
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", () => {
              fail(new OoxmlPreviewError("invalid", "Failed while unpacking the archive."));
            });
            stream.on("end", () => {
              if (settled) return;
              entries.set(normalized, Buffer.concat(chunks, entryBytes));
              zipfile.readEntry();
            });
          });
        });

        zipfile.readEntry();
      },
    );
  });
}

/** Parses an OOXML `.rels` part into a map of `Id -> { target, type, external }`. */
export interface OoxmlRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

export function readRelationships(
  archive: OoxmlArchive,
  relsPath: string,
): ReadonlyMap<string, OoxmlRelationship> {
  const root = archive.readXml(relsPath);
  const map = new Map<string, OoxmlRelationship>();
  if (!root) return map;
  for (const kid of root.children) {
    if (kid.name !== "Relationship" && !kid.name.endsWith(":Relationship")) continue;
    const id = kid.attrs.Id;
    const target = kid.attrs.Target;
    if (!id || !target) continue;
    map.set(id, {
      id,
      type: kid.attrs.Type ?? "",
      target,
      external: kid.attrs.TargetMode?.toLowerCase() === "external",
    });
  }
  return map;
}

/** Verifies `[Content_Types].xml` has no macro/VBA content types. */
export function assertNoMacros(archive: OoxmlArchive): void {
  const contentTypes = archive.readXml("[Content_Types].xml");
  if (!contentTypes) {
    throw new OoxmlPreviewError("invalid", "Missing [Content_Types].xml in Office archive.");
  }
  for (const kid of contentTypes.children) {
    const type = kid.attrs.ContentType ?? "";
    if (MACRO_CONTENT_TYPE_RE.test(type)) {
      throw new OoxmlPreviewError(
        "invalid",
        "Macro-enabled Office files are not previewed here for safety.",
      );
    }
  }
  for (const part of archive.entries.keys()) {
    if (/vbaProject\.bin$/i.test(part)) {
      throw new OoxmlPreviewError(
        "invalid",
        "Macro-enabled Office files are not previewed here for safety.",
      );
    }
  }
}
