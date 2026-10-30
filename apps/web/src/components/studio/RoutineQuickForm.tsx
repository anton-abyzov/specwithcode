/**
 * A short form for a reusable routine, started from a template: what it does,
 * what it works from, where the result goes, and when it runs. It runs only
 * when asked unless the person picks the template's cadence (a monthly day, or
 * a daily time); nothing is saved until they press Save.
 */
import { useId, useRef, useState } from "react";
import {
  CommandId,
  ROUTINE_BRIEF_MAX_INPUTS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskUpsertSchedule,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { RoutineTemplate } from "@specweave-studio/shared/routineTemplates";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";

const DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

export function RoutineQuickForm({
  environmentId,
  projectId,
  modelSelection,
  template,
  onDone,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  modelSelection: ModelSelection | null;
  template: RoutineTemplate;
  onDone: (saved: boolean) => void;
}) {
  const id = useId();
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask);
  const [title, setTitle] = useState(template.title);
  const [prompt, setPrompt] = useState(template.prompt);
  const [inputs, setInputs] = useState(() =>
    template.inputs.slice(0, ROUTINE_BRIEF_MAX_INPUTS).map((entry) => ({ ...entry, location: "" })),
  );
  const [output, setOutput] = useState(template.output ?? "");
  const suggested = template.suggestedCadence;
  const daily = suggested?.type === "fixed_time";
  const [scheduled, setScheduled] = useState(template.cadenceOnByDefault === true);
  const [dayOfMonth, setDayOfMonth] = useState(
    suggested?.type === "monthly" ? suggested.dayOfMonth : 1,
  );
  const [timeOfDay, setTimeOfDay] = useState(suggested?.timeOfDay ?? "09:00");
  const [prepareOnly, setPrepareOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One id per form, so a retried save after a lost reply creates one routine.
  const commandId = useRef(CommandId.make(`routine-template:${template.id}:${randomUUID()}`));

  async function save() {
    if (saving) return;
    if (modelSelection === null) {
      setError("Pick a coordinator model in this project's settings first.");
      return;
    }
    if (!title.trim() || !prompt.trim()) {
      setError("A routine needs a name and what to do.");
      return;
    }
    const schedule: ScheduledTaskUpsertSchedule = !scheduled
      ? { type: "manual" }
      : daily
        ? { type: "fixed_time", timeOfDay }
        : { type: "monthly", dayOfMonth, timeOfDay };
    setSaving(true);
    setError(null);
    try {
      const result = await upsert({
        environmentId,
        input: {
          commandId: commandId.current,
          title: title.trim(),
          prompt: prompt.trim(),
          enabled: true,
          schedule,
          projectId,
          threadId: null,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          ownThread: true,
          brief: {
            inputs: inputs
              .filter((entry) => entry.location.trim())
              .map((entry) => ({ label: entry.label.trim(), location: entry.location.trim() })),
            output: output.trim() || null,
            prepareOnly,
          },
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "The routine was not saved.");
        return;
      }
      onDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Not confirmed. Save again to retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="sws-routine-form"
      aria-label={`New routine: ${template.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        Name
        <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        What it does
        <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {inputs.length > 0 ? (
        <fieldset>
          <legend>Works from</legend>
          <p className="project-muted">
            Only what you list here. Each run checks it is there and current first.
          </p>
          {inputs.map((entry, index) => (
            <label key={entry.label}>
              {entry.label}
              <input
                value={entry.location}
                placeholder={entry.hint}
                onChange={(e) =>
                  setInputs((current) =>
                    current.map((item, at) =>
                      at === index ? { ...item, location: e.target.value } : item,
                    ),
                  )
                }
              />
            </label>
          ))}
        </fieldset>
      ) : null}
      <label>
        Result goes to
        <input
          value={output}
          placeholder="Answer in the thread"
          onChange={(e) => setOutput(e.target.value)}
        />
        <span className="project-muted">
          {"{period} is the previous month and {date} the run date. A rerun updates the file."}
        </span>
      </label>
      <fieldset>
        <legend>When it runs</legend>
        <label className="project-checkbox">
          <input
            type="radio"
            name={`${id}-when`}
            checked={!scheduled}
            onChange={() => setScheduled(false)}
          />
          When you ask (Run now)
        </label>
        <label className="project-checkbox">
          <input
            type="radio"
            name={`${id}-when`}
            checked={scheduled}
            onChange={() => setScheduled(true)}
          />
          {daily ? "Every day" : "Every month"}
        </label>
        {scheduled ? (
          <div className="sws-routine-when">
            {daily ? null : (
              <label>
                Day
                <select value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Time
              <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
            </label>
          </div>
        ) : null}
      </fieldset>
      <label className="project-checkbox">
        <input
          type="checkbox"
          checked={prepareOnly}
          onChange={(e) => setPrepareOnly(e.target.checked)}
        />
        Prepare and draft only: you file, pay and send
      </label>
      <p className="project-muted">
        Runs in a thread of its own, named after the routine; each run continues it.
        {scheduled ? " Each scheduled run uses your plan's limits." : ""}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="project-actions">
        <button type="submit" className="project-control" disabled={saving}>
          {saving ? "Saving…" : "Save routine"}
        </button>
        <button
          type="button"
          className="project-control"
          disabled={saving}
          onClick={() => onDone(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
