import { useState } from "react";
import type {
  NativeConnectionApplyInput,
  NativeConnectionChange,
  NativeTool,
} from "@specweave-studio/contracts";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** `KEY=value` (or `Name: value`) per line; blank lines are skipped. */
function pairs(text: string, separator: "=" | ":"): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.indexOf(separator);
    if (index <= 0) return null;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

/** A form for a new MCP server; it previews the change before anything is written. */
export function ConnectionEditor({
  tools,
  pending,
  onSubmit,
  onCancel,
}: {
  tools: ReadonlyArray<{ readonly tool: NativeTool; readonly label: string }>;
  pending: boolean;
  onSubmit: (input: NativeConnectionApplyInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"command" | "url">("command");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [chosen, setChosen] = useState<ReadonlyArray<NativeTool>>([]);
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      setProblem("Use a name that starts with a letter: letters, digits, - and _.");
      return;
    }
    if (chosen.length === 0) {
      setProblem("Tick at least one tool.");
      return;
    }
    if (kind === "command") {
      const variables = pairs(env, "=");
      if (!command.trim() || variables === null) {
        setProblem("Enter a command, and environment lines as KEY=value.");
        return;
      }
      const argv = args
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean);
      setProblem(null);
      onSubmit({
        action: "add",
        name,
        tools: [...chosen],
        server: {
          command: command.trim(),
          ...(argv.length ? { args: argv } : {}),
          ...(Object.keys(variables).length ? { env: variables } : {}),
        },
      });
      return;
    }
    const sent = pairs(headers, ":");
    if (!/^https?:\/\/\S+$/i.test(url.trim()) || sent === null) {
      setProblem("Enter an http(s) URL, and header lines as Name: value.");
      return;
    }
    setProblem(null);
    onSubmit({
      action: "add",
      name,
      tools: [...chosen],
      server: { url: url.trim(), ...(Object.keys(sent).length ? { headers: sent } : {}) },
    });
  }

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="connection-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4 className="text-sm font-medium">Add an MCP server</h4>
      <label className="block space-y-1 text-sm">
        <span>Name</span>
        <Input
          value={name}
          aria-label="Server name"
          placeholder="search"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="flex gap-2" role="group" aria-label="How the tool reaches the server">
        <Button
          type="button"
          size="xs"
          variant={kind === "command" ? "default" : "outline"}
          aria-pressed={kind === "command"}
          onClick={() => setKind("command")}
        >
          Command
        </Button>
        <Button
          type="button"
          size="xs"
          variant={kind === "url" ? "default" : "outline"}
          aria-pressed={kind === "url"}
          onClick={() => setKind("url")}
        >
          URL
        </Button>
      </div>
      {kind === "command" ? (
        <>
          <label className="block space-y-1 text-sm">
            <span>Command</span>
            <Input
              value={command}
              aria-label="Command"
              placeholder="npx"
              onChange={(e) => setCommand(e.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Arguments, one per line</span>
            <Textarea
              value={args}
              aria-label="Arguments"
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Environment, KEY=value per line</span>
            <Textarea
              value={env}
              aria-label="Environment"
              onChange={(e) => setEnv(e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            <span>URL</span>
            <Input
              value={url}
              aria-label="URL"
              placeholder="https://example.com/mcp"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Headers, Name: value per line</span>
            <Textarea
              value={headers}
              aria-label="Headers"
              onChange={(e) => setHeaders(e.target.value)}
            />
          </label>
        </>
      )}
      <fieldset className="space-y-1 text-sm">
        <legend>Add it to</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {tools.map(({ tool, label }) => (
            <label key={tool} className="flex items-center gap-2">
              <Checkbox
                aria-label={label}
                checked={chosen.includes(tool)}
                onCheckedChange={(checked) =>
                  setChosen((list) =>
                    checked ? [...list, tool] : list.filter((item) => item !== tool),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {problem ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={pending}>
          {pending ? "Checking…" : "Preview"}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What a change writes, file by file, with values masked by the machine. */
export function ChangePreview({
  change,
  pending,
  onConfirm,
  onCancel,
}: {
  change: NativeConnectionChange;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Review the change"
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="change-preview"
    >
      <h4 className="text-sm font-medium">Review the change</h4>
      <ul className="space-y-2 text-sm">
        {change.files.map((file) => (
          <li key={file.path}>
            <div className="font-medium">
              {file.tool} <span className="text-xs text-muted-foreground">{file.path}</span>
            </div>
            {file.lines.map((line) => (
              <code key={line} className="block break-all text-xs text-muted-foreground">
                {line}
              </code>
            ))}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        A backup is kept, so you can undo this. Tools pick the change up when they next start.
      </p>
      <div className="flex gap-2">
        <Button size="xs" disabled={pending} onClick={onConfirm}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
