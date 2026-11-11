import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GoogleService,
  ProjectConnection,
  ProjectId,
} from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  SERVICE_PRESETS,
  SERVICE_START_FAILURE,
  type ServicePreset,
  serviceRowState,
  serviceStatusText,
} from "../../studio/assistantServices";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { assistantNameOr } from "../../studio/assistantTerms";

const GOOGLE_ROWS: ReadonlyArray<{ service: GoogleService; name: string; summary: string }> = [
  { service: "gmail", name: "Email", summary: "Read your Gmail" },
  { service: "gmailDrafts", name: "Email drafts", summary: "Save drafts for you to send" },
  { service: "calendar", name: "Calendar", summary: "Read your events" },
  { service: "drive", name: "Drive", summary: "Find and read your files" },
];

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : fallback;
};

function GoogleRows({
  environmentId,
  projectId,
  disabled,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  disabled: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.googleAccountStatus({ environmentId, input: {} }),
  );
  const setAccess = useAtomCommand(serverEnvironment.setGoogleProjectAccess, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = query.data ?? null;
  const enabled = status?.projects.find((entry) => entry.projectId === projectId)?.services ?? [];
  async function toggle(service: GoogleService, on: boolean) {
    setBusy(true);
    setError(null);
    const services = on
      ? [...new Set([...enabled, service])]
      : enabled.filter((entry) => entry !== service);
    const result = await setAccess({ environmentId, input: { projectId, services } });
    if (result._tag === "Failure")
      setError(failureText(result, "The host refused the change. Nothing changed."));
    query.refresh();
    setBusy(false);
  }
  return (
    <>
      {GOOGLE_ROWS.map(({ service, name, summary }) => {
        const granted = status?.services.includes(service) ?? false;
        return (
          <li className="assistant-service" key={service} data-service={service}>
            <div>
              <strong>{name}</strong>
              <small className="project-muted">{summary}</small>
            </div>
            {granted ? (
              <Switch
                size="sm"
                aria-label={name}
                checked={enabled.includes(service)}
                disabled={disabled || busy}
                onCheckedChange={(on) => void toggle(service, on)}
              />
            ) : (
              <Link to="/settings/google" className="underline underline-offset-2">
                Connect
              </Link>
            )}
          </li>
        );
      })}
      {error ? <li role="alert">{error}</li> : null}
    </>
  );
}

function PresetRow({
  preset,
  connection,
  environmentId,
  projectId,
  disabled,
  admissionBlocked,
  onChanged,
  assistantName,
}: {
  preset: ServicePreset;
  connection: ProjectConnection | undefined;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  disabled: boolean;
  admissionBlocked: boolean;
  onChanged: () => void;
  assistantName: string;
}) {
  const tokenId = useId();
  const save = useAtomCommand(projectWorkspace.connectionSave, { reportFailure: false });
  const setCredential = useAtomCommand(projectWorkspace.connectionCredentialSet, {
    reportFailure: false,
  });
  const check = useAtomCommand(projectWorkspace.connectionCheck, { reportFailure: false });
  const revoke = useAtomCommand(projectWorkspace.connectionRevoke, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [picked, setPicked] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const state = serviceRowState(connection);
  const allowed = picked ?? connection?.allowedTools ?? [];
  const blocked = disabled || busy;

  async function connect() {
    setBusy(true);
    setError(null);
    const target = { projectId, id: preset.id };
    try {
      let revision = connection?.revision ?? null;
      if (state === "not-connected") {
        const saved = await save({
          environmentId,
          input: {
            ...target,
            expectedRevision: revision,
            config: preset.config,
            allowedTools: [],
          },
        });
        if (saved._tag === "Failure") {
          setError(failureText(saved, "Could not save this connection."));
          return;
        }
        revision = saved.value.revision;
      }
      if (token.trim() !== "") {
        const set = await setCredential({
          environmentId,
          input: {
            ...target,
            expectedRevision: revision!,
            envKey: preset.config.envKeys[0]!,
            value: token.trim(),
          },
        });
        if (set._tag === "Failure") {
          setError(failureText(set, "Could not save the token. It was not stored."));
          return;
        }
        revision = set.value.revision;
        setToken("");
      }
      const checked = await check({
        environmentId,
        input: { ...target, expectedRevision: revision! },
      });
      if (checked._tag === "Failure") setError(failureText(checked, SERVICE_START_FAILURE));
      else if (checked.value.status !== "ready") setError(SERVICE_START_FAILURE);
      else setOpen(false);
    } catch {
      setError("Not confirmed. Reload this tab before trying again.");
    } finally {
      onChanged();
      setBusy(false);
    }
  }

  async function saveTools() {
    if (!connection) return;
    setBusy(true);
    setError(null);
    const saved = await save({
      environmentId,
      input: {
        projectId,
        id: preset.id,
        expectedRevision: connection.revision,
        // Its own command: a newer preset here must not count as a changed command.
        config: {
          name: connection.name,
          command: connection.command,
          args: connection.args,
          envKeys: connection.envKeys,
        },
        allowedTools: [...allowed],
      },
    });
    if (saved._tag === "Failure") setError(failureText(saved, "Could not save the allowed tools."));
    else setPicked(null);
    onChanged();
    setBusy(false);
  }

  async function disconnect() {
    if (!connection) return;
    setBusy(true);
    setError(null);
    const result = await revoke({
      environmentId,
      input: { projectId, id: preset.id, expectedRevision: connection.revision },
    });
    if (result._tag === "Failure") setError(failureText(result, "Could not disconnect it."));
    else setPicked(null);
    onChanged();
    setBusy(false);
  }

  return (
    <li className="assistant-service assistant-service-preset" data-service={preset.id}>
      <div>
        <strong>{preset.name}</strong>
        <small className="project-muted">{preset.summary}</small>
      </div>
      <div className="assistant-service-state">
        <span className="project-muted" role="status">
          {serviceStatusText(connection)}
        </span>
        {state !== "ready" ? (
          <button
            type="button"
            className="project-control"
            disabled={blocked}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Connect
          </button>
        ) : null}
        {state !== "not-connected" ? (
          <button
            type="button"
            className="project-control"
            disabled={blocked}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        ) : null}
      </div>
      {open && state !== "ready" ? (
        <form
          className="assistant-service-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label htmlFor={tokenId}>{preset.tokenLabel}</label>
          <input
            id={tokenId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            disabled={blocked}
            onChange={(event) => setToken(event.target.value)}
          />
          <small className="project-muted">
            {preset.tokenHelp}{" "}
            <a href={preset.tokenUrl} target="_blank" rel="noreferrer">
              Open {preset.name}
            </a>
            . It stays on this machine and is never shown again.
          </small>
          <button
            type="submit"
            className="project-control project-primary"
            disabled={
              blocked || admissionBlocked || (state === "not-connected" && token.trim() === "")
            }
          >
            {busy ? "Connecting…" : `Connect ${preset.name}`}
          </button>
        </form>
      ) : null}
      {state === "ready" && connection ? (
        <fieldset className="assistant-service-tools" disabled={blocked}>
          <legend>What {assistantName} may use</legend>
          <small className="project-muted">
            This is what {preset.name} offers. Its first use confirms the token.
          </small>
          {connection.tools.map((tool) => (
            <label className="project-checkbox" key={tool.name}>
              <input
                type="checkbox"
                checked={allowed.includes(tool.name)}
                onChange={(event) =>
                  setPicked(
                    event.target.checked
                      ? [...allowed, tool.name]
                      : allowed.filter((name) => name !== tool.name),
                  )
                }
              />
              <span>{tool.name}</span>
            </label>
          ))}
          {picked !== null ? (
            <button
              type="button"
              className="project-control project-primary"
              onClick={() => void saveTools()}
            >
              Save allowed tools
            </button>
          ) : null}
        </fieldset>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </li>
  );
}

/** What the personal assistant can reach, in one place; only the person connects anything. */
export function AssistantServices({
  environmentId,
  projectId,
  disabled,
  admissionBlocked,
  onOpenEnvironment,
  assistantName,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  disabled: boolean;
  admissionBlocked: boolean;
  onOpenEnvironment: () => void;
  /** The assistant's title, so the copy calls it by its name. */
  assistantName?: string | undefined;
}) {
  const called = assistantNameOr(assistantName);
  const query = useEnvironmentQuery(
    projectWorkspace.connections({ environmentId, input: { projectId } }),
  );
  const connections = query.data?.connections ?? [];
  return (
    <section className="project-settings-section assistant-services">
      <h2>Services</h2>
      <p className="project-muted">
        The accounts {called} may use for you. Sign-ins and tokens stay on this machine, and you
        choose what each one may do.
      </p>
      <h3>Google</h3>
      <ul>
        <GoogleRows environmentId={environmentId} projectId={projectId} disabled={disabled} />
      </ul>
      <h3>Connect with a token</h3>
      <ul>
        {SERVICE_PRESETS.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            connection={connections.find((entry) => entry.id === preset.id)}
            environmentId={environmentId}
            projectId={projectId}
            disabled={disabled}
            admissionBlocked={admissionBlocked}
            onChanged={query.refresh}
            assistantName={called}
          />
        ))}
      </ul>
      <h3>Other ways in</h3>
      <ul>
        <li className="assistant-service" data-service="health">
          <div>
            <strong>Health</strong>
            <small className="project-muted">
              No direct connection. Export your records to a folder and approve it.
            </small>
          </div>
          <button type="button" className="project-control" onClick={onOpenEnvironment}>
            Approve a folder
          </button>
        </li>
        <li className="assistant-service" data-service="finances">
          <div>
            <strong>Finances</strong>
            <small className="project-muted">
              No direct connection. Keep statements in a folder and approve it.
            </small>
          </div>
          <button type="button" className="project-control" onClick={onOpenEnvironment}>
            Approve a folder
          </button>
        </li>
        <li className="assistant-service" data-service="browser">
          <div>
            <strong>Browser</strong>
            <small className="project-muted">Sites you are signed in to, through Chrome</small>
          </div>
          <Link to="/settings/chrome" className="underline underline-offset-2">
            Open Chrome settings
          </Link>
        </li>
        <li className="assistant-service" data-service="custom">
          <div>
            <strong>Your own</strong>
            <small className="project-muted">Any MCP server, or one from your other tools</small>
          </div>
          <button type="button" className="project-control" onClick={onOpenEnvironment}>
            Add under Environment
          </button>
        </li>
      </ul>
    </section>
  );
}
