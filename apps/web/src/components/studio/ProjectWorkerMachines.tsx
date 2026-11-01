import {
  isLocalWorkerMachine,
  MAX_PROJECT_WORKER_MACHINES,
  type ProjectWorkerMachine,
} from "@specweave-studio/contracts";

import {
  moveWorkerMachine,
  type WorkerMachineChoice,
  workerMachineListView,
} from "../../studio/fleetWorkers";

/**
 * Where this project's workers run: an ordered list of machines. A launch
 * the coordinator does not pin to a machine tries them top to bottom and
 * skips one that is offline, lacks the project or refuses the work. Leaving
 * "This machine" out means a worker never starts here on its own.
 */
export function ProjectWorkerMachines(props: {
  readonly choices: ReadonlyArray<WorkerMachineChoice>;
  readonly list: ReadonlyArray<ProjectWorkerMachine>;
  readonly disabled: boolean;
  readonly onChange: (list: ReadonlyArray<ProjectWorkerMachine>) => void;
}) {
  const { choices, list, disabled, onChange } = props;
  const { rows, addable } = workerMachineListView(choices, list);
  if (choices.length <= 1 && rows.every((row) => isLocalWorkerMachine(row.machine)))
    return (
      <p className="project-muted">
        Workers run on this machine. To run them on a second Mac or your own Linux VPS, add it under
        Settings &gt; Connections &gt; Your private machines.
      </p>
    );
  const includesHere = list.some(isLocalWorkerMachine);
  return (
    <div className="project-worker-machines">
      <h3>Machines for workers</h3>
      <ol aria-label="Machines for workers, in the order the coordinator tries them">
        {rows.map((row, index) => (
          <li key={row.value}>
            <span className="project-worker-machine-name">
              {index + 1}. {row.label}
            </span>
            <button
              type="button"
              className="project-control"
              aria-label={`Move ${row.label} up`}
              disabled={disabled || index === 0}
              onClick={() => onChange(moveWorkerMachine(list, index, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className="project-control"
              aria-label={`Move ${row.label} down`}
              disabled={disabled || index === rows.length - 1}
              onClick={() => onChange(moveWorkerMachine(list, index, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className="project-control"
              aria-label={`Remove ${row.label}`}
              disabled={disabled || rows.length === 1}
              onClick={() => onChange(list.filter((_, at) => at !== index))}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      {addable.length > 0 && list.length < MAX_PROJECT_WORKER_MACHINES ? (
        <label>
          Add a machine
          <select
            value=""
            disabled={disabled}
            onChange={(event) => {
              const choice = addable.find((entry) => entry.value === event.target.value);
              if (choice) onChange([...list, choice.machine]);
            }}
          >
            <option value="" disabled>
              Choose…
            </option>
            {addable.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <span className="project-muted">
        The coordinator starts each worker on the first machine that can take it, in the same
        repository, and hears back when it finishes. A machine that is offline, has no copy of this
        project or does not allow the work is skipped.{" "}
        {includesHere
          ? "This machine is in the list, so work never stalls while it is up."
          : "This machine is not in the list, so when none of them can take a worker, nothing starts and the coordinator tells you."}{" "}
        You can still ask the coordinator to use a particular machine.
      </span>
    </div>
  );
}
