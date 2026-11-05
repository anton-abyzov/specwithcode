import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { MAX_PROJECT_SECRET_FILES } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useLinkMachines } from "../studio/useLinkMachines";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const MAX_ENTRY_LENGTH = 512;

/**
 * Why one Secret files entry cannot be used, or null: the shape rules the server
 * applies. A `~/` entry is listed in a copy for the person to copy, and only .NET
 * user secrets are copied into the other machine's home folder.
 */
export function secretFileEntryProblem(entry: string): string | null {
  if (entry.length > MAX_ENTRY_LENGTH)
    return `Keep each entry under ${MAX_ENTRY_LENGTH} characters.`;
  if (/^[a-zA-Z]:/.test(entry) || entry.startsWith("\\") || /^~[^/]/.test(entry))
    return "Use a path inside the project folder, or ~/ for one in your home folder.";
  if (entry.split(/[\\/]/).includes("..")) return "An entry cannot leave its folder (..).";
  return null;
}

/** The entries one per line, trimmed and without repeats. */
export function secretFileEntries(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Settings > Project: extra secret files a copy offers beside the built-in list
 * (.env, keys, credentials, .NET user secrets). Gitignore-style entries; `~/`
 * names a file or folder in the home folder. Written to every machine with a copy.
 */
export function ProjectSecretFilesSettings({
  members,
}: {
  readonly members: ReadonlyArray<EnvironmentProject>;
}) {
  const tx = useTx();
  const machines = useLinkMachines();
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const saved = (members[0]?.workspaceSettings?.secretFiles ?? []).join("\n");
  const [text, setText] = useState(saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(saved), [saved]);
  if (members.length === 0) return null;
  const entries = secretFileEntries(text);
  const problems = entries.flatMap((entry) => {
    const problem = secretFileEntryProblem(entry);
    return problem ? [`${entry}: ${problem}`] : [];
  });
  const tooMany = entries.length > MAX_PROJECT_SECRET_FILES;
  const save = async () => {
    setPending(true);
    const failures: string[] = [];
    for (const member of members) {
      const result = await update({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          workspaceSettings: {
            expectedRevision: member.workspaceSettings?.revision ?? 0,
            secretFiles: entries,
          },
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        failures.push(
          `${machines.label(member.environmentId)}: ${cause instanceof Error ? cause.message : "try again in a moment."}`,
        );
      }
    }
    setPending(false);
    setError(failures.length > 0 ? failures.join(" ") : null);
  };
  return (
    <SettingsSection title="Secret files">
      <SettingsRow
        title="Also treat these as secrets"
        description="One per line, like .gitignore: settings.local.json or config/keys/. A copy offers them only when you include secrets. A ~/ entry, such as ~/.config/acme/token.json, is listed so you can copy it yourself; sign-in and start-up files are never listed."
      />
      <div className="space-y-2 px-3 pb-3 sm:px-4">
        <Textarea
          aria-label={tx("Secret files")}
          value={text}
          disabled={pending}
          rows={4}
          className="font-mono text-xs"
          placeholder={"settings.local.json\nconfig/keys/\n~/.config/acme/token.json"}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setError(null);
          }}
        />
        {problems.length > 0 || tooMany ? (
          <ul role="alert" className="space-y-1 text-xs text-destructive-foreground">
            {tooMany ? (
              <li>
                {renderRich(tx("Keep it to {MAX_PROJECT_SECRET_FILES} entries."), {
                  MAX_PROJECT_SECRET_FILES: MAX_PROJECT_SECRET_FILES,
                })}
              </li>
            ) : null}
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={pending || entries.join("\n") === saved || problems.length > 0 || tooMany}
          onClick={() => void save()}
        >
          {tx("Save secret files")}
        </Button>
      </div>
    </SettingsSection>
  );
}
