/**
 * Edit, Write, NotebookEdit and Bash results as the Claude Agent SDK delivers
 * them: the `tool_result` block the model sees plus the user message's
 * `tool_use_result`. Paths and text are synthetic; the shapes are not.
 *
 * - Bash error exit, non-error nonzero exit and interrupt, Edit with hunks and
 *   Write create follow results recorded in Claude Code 2.1.296 and 2.1.301
 *   session transcripts, whose `toolUseResult` is the object the SDK delivers
 *   as `tool_use_result` (an interrupt is an error result whose structured
 *   output says `interrupted: true`; an error exit's text starts "Exit code N").
 * - Edit with a git patch, Write update without hunks, NotebookEdit and the
 *   internal `edits` list follow the SDK 0.3.276 output types (`sdk-tools.d.ts`)
 *   and Claude Code 2.1.302's tool schemas; no recording carried them.
 */
export interface ClaudeToolResultFixture {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly content: string;
  readonly isError?: boolean;
  /** Absent when the CLI attached no structured result. */
  readonly toolUseResult?: unknown;
}

export const CLAUDE_TOOL_RESULT_FIXTURES = {
  editHunks: {
    id: "toolu_fixture_edit_hunks",
    name: "Edit",
    input: {
      file_path: "/workspace/src/math.ts",
      old_string: "  return a + b;",
      new_string: "  return a + b + c;",
    },
    content: "The file /workspace/src/math.ts has been updated successfully.",
    toolUseResult: {
      filePath: "/workspace/src/math.ts",
      oldString: "  return a + b;",
      newString: "  return a + b + c;",
      originalFile: "export function add(a, b, c) {\n  return a + b;\n}\n",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            " export function add(a, b, c) {",
            "-  return a + b;",
            "+  return a + b + c;",
            " }",
          ],
        },
      ],
      userModified: false,
      replaceAll: false,
    },
  },
  editGitPatch: {
    id: "toolu_fixture_edit_git_patch",
    name: "Edit",
    input: {
      file_path: "/workspace/src/config.ts",
      old_string: "export const port = 3000;",
      new_string: "export const port = 8319;",
    },
    content: "The file /workspace/src/config.ts has been updated successfully.",
    toolUseResult: {
      filePath: "/workspace/src/config.ts",
      oldString: "export const port = 3000;",
      newString: "export const port = 8319;",
      originalFile: null,
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
      gitDiff: {
        filename: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch:
          "diff --git a/src/config.ts b/src/config.ts\n" +
          "index 1111111..2222222 100644\n" +
          "--- a/src/config.ts\n" +
          "+++ b/src/config.ts\n" +
          "@@ -1 +1 @@\n" +
          "-export const port = 3000;\n" +
          "+export const port = 8319;\n",
      },
    },
  },
  editInputOnly: {
    id: "toolu_fixture_edit_input_only",
    name: "Edit",
    input: {
      file_path: "/workspace/src/retry.ts",
      old_string: "const retries = 1;",
      new_string: "const retries = 3;",
    },
    content: "The file /workspace/src/retry.ts has been updated successfully.",
    // The diff timed out: no hunks and no git patch.
    toolUseResult: {
      filePath: "/workspace/src/retry.ts",
      oldString: "const retries = 1;",
      newString: "const retries = 3;",
      originalFile: "const retries = 1;\n",
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    },
  },
  editList: {
    id: "toolu_fixture_edit_list",
    name: "Edit",
    input: {
      file_path: "/workspace/src/names.ts",
      edits: [
        { old_string: "const first = 'a';", new_string: "const first = 'b';" },
        { old_string: "keep();\ndrop();", new_string: "keep();\nadd();", replace_all: false },
      ],
    },
    content: "The file /workspace/src/names.ts has been updated successfully.",
  },
  writeCreate: {
    id: "toolu_fixture_write_create",
    name: "Write",
    input: { file_path: "/workspace/notes/todo.md", content: "# Todo\n- ship\n" },
    content: "File created successfully at: /workspace/notes/todo.md",
    toolUseResult: {
      type: "create",
      filePath: "/workspace/notes/todo.md",
      content: "# Todo\n- ship\n",
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
  },
  writeUpdateWithoutHunks: {
    id: "toolu_fixture_write_update",
    name: "Write",
    input: { file_path: "/workspace/data/large.json", content: '{"rows":[]}\n' },
    content: "The file /workspace/data/large.json has been updated successfully.",
    // The previous content was too large to diff.
    toolUseResult: {
      type: "update",
      filePath: "/workspace/data/large.json",
      content: '{"rows":[]}\n',
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
  },
  notebookReplace: {
    id: "toolu_fixture_notebook_replace",
    name: "NotebookEdit",
    input: {
      notebook_path: "/workspace/analysis.ipynb",
      cell_id: "cell-2",
      new_source: "df.describe()",
      edit_mode: "replace",
    },
    content: "Updated cell cell-2 with df.describe()",
    toolUseResult: {
      new_source: "df.describe()",
      old_source: "df.head()",
      cell_id: "cell-2",
      cell_type: "code",
      language: "python",
      edit_mode: "replace",
      notebook_path: "/workspace/analysis.ipynb",
      original_file: '{"cells":[]}',
      updated_file: '{"cells":[]}',
    },
  },
  editFailed: {
    id: "toolu_fixture_edit_failed",
    name: "Edit",
    input: {
      file_path: "/workspace/src/math.ts",
      old_string: "@@ -1 +1 @@\nconst missing = true;",
      new_string: "const missing = false;",
    },
    isError: true,
    content:
      "<tool_use_error>String to replace not found in file.\nString: @@ -1 +1 @@\nconst missing = true;</tool_use_error>",
    toolUseResult:
      "Error: String to replace not found in file.\nString: @@ -1 +1 @@\nconst missing = true;",
  },
  bashErrorExit: {
    id: "toolu_fixture_bash_error_exit",
    name: "Bash",
    input: { command: "ls missing-dir", description: "List a missing folder" },
    isError: true,
    content: "Exit code 2\nls: missing-dir: No such file or directory",
    toolUseResult: "Error: Exit code 2\nls: missing-dir: No such file or directory",
  },
  bashNonErrorExit: {
    id: "toolu_fixture_bash_git_diff",
    name: "Bash",
    input: { command: "git diff --exit-code", description: "Show unstaged changes" },
    content:
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new",
    toolUseResult: {
      stdout:
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      returnCodeInterpretation: "Files differ",
    },
  },
  bashUnparsedError: {
    id: "toolu_fixture_bash_unparsed_error",
    name: "Bash",
    input: { command: "make build", description: "Build" },
    isError: true,
    content: "Command failed: Exit code 2\nmake: *** [build] Error 2",
    toolUseResult: "Error: Command failed: Exit code 2\nmake: *** [build] Error 2",
  },
  bashInterrupted: {
    id: "toolu_fixture_bash_interrupted",
    name: "Bash",
    input: { command: "sleep 60", description: "Wait" },
    isError: true,
    content: "<error>Command was aborted before completion</error>",
    toolUseResult: {
      stdout: "",
      stderr: "",
      interrupted: true,
      isImage: false,
      noOutputExpected: false,
      returnCodeInterpretation: "Command failed with exit code 145",
    },
  },
} satisfies Record<string, ClaudeToolResultFixture>;
