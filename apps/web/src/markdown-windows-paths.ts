import type { Parent } from "mdast";
import type { Processor } from "unified";

interface EscapeCompileContext {
  readonly stack: ReadonlyArray<{ readonly type: string }>;
  sliceSerialize(token: unknown): string;
}

function keepWindowsPathEscape(this: EscapeCompileContext, token: unknown) {
  const parent = this.stack.at(-1);
  const tail = parent && "children" in parent ? (parent as Parent).children.at(-1) : undefined;
  if (tail?.type !== "text") return;

  const escaped = this.sliceSerialize(token);
  // The default characterEscapeValue handler has already appended the character
  // without its backslash. Restore it only when this token continues a drive path.
  const prefix = tail.value.slice(0, -(escaped.length - 1));
  if (/(?:^|[\s("'[<{])[A-Za-z]:(?:[\\/][^\s"'<>]*)?$/u.test(prefix)) {
    tail.value = prefix + escaped;
  }
}

/** Keep path separators before punctuation in Windows paths written as prose. */
export function remarkPreserveWindowsPathText(this: Processor) {
  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push({
    exit: { characterEscape: keepWindowsPathEscape },
  });
}
