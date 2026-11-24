// @effect-diagnostics nodeBuiltinImport:off - Deflate and CRC-32 for the zip container come from node:zlib.
/**
 * Writes a Sheet as an Excel workbook (.xlsx). The XML parts come from the
 * shared builder; this file only packs them into a zip with deflate, so the
 * server needs no zip library. Entry times are fixed, so the same Sheet always
 * gives the same bytes.
 */
import * as NodeZlib from "node:zlib";
import {
  type SheetDocument,
  type SheetEvaluation,
  buildXlsxParts,
  evaluateSheet,
  xlsxPartOrder,
} from "@specweave-studio/shared/officeSheet";

// 1980-01-01 00:00, the earliest time a zip entry can carry.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** Files as a zip archive (deflate, UTF-8 names). */
export function zipFiles(files: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const packed = NodeZlib.deflateRawSync(data, { level: 6 });
    const crc = NodeZlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    local.set(nameBytes, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    central.set(nameBytes, 46);
    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A Sheet as .xlsx bytes, formulas with their computed values. */
export function writeXlsxWorkbook(
  document: SheetDocument,
  evaluation: SheetEvaluation = evaluateSheet(document),
): Uint8Array {
  const parts = buildXlsxParts(document, evaluation);
  const encoder = new TextEncoder();
  return zipFiles(xlsxPartOrder(parts).map((name) => [name, encoder.encode(parts[name]!)] as const));
}
