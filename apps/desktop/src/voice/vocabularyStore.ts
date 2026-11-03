// @effect-diagnostics nodeBuiltinImport:off -- The vocabulary is a small user-owned file read at IPC boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  decodeStoredVocabulary,
  encodeStoredVocabulary,
  formatVocabulary,
  parseVocabulary,
  type VocabularyTerm,
} from "./vocabulary.ts";

/** The vocabulary file on this machine: readable only by its owner, never synced. */
export class VoiceVocabularyStore {
  private readonly path: string;
  private cached: readonly VocabularyTerm[] | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async terms(): Promise<readonly VocabularyTerm[]> {
    // Read once per run; the editor is what changes it while the app is open.
    this.cached ??= decodeStoredVocabulary(
      await NodeFSP.readFile(this.path, "utf8").catch(() => ""),
    );
    return this.cached;
  }

  async read() {
    // A hand edit made while the app is open shows up in the editor.
    this.cached = null;
    const terms = await this.terms();
    return { text: formatVocabulary(terms), count: terms.length, refused: 0 };
  }

  async save(text: string) {
    const { terms, refused } = parseVocabulary(text);
    await NodeFSP.mkdir(NodePath.dirname(this.path), { recursive: true, mode: 0o700 });
    const partial = `${this.path}.saving`;
    await NodeFSP.writeFile(partial, encodeStoredVocabulary(terms), { mode: 0o600 });
    await NodeFSP.rename(partial, this.path);
    this.cached = terms;
    return { text: formatVocabulary(terms), count: terms.length, refused };
  }
}
