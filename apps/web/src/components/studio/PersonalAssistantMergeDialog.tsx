import { useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";

export interface MergeDialogSeat {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly title: string;
  readonly supportsPersonalLink: boolean;
  readonly isStaleExtra?: boolean | undefined;
}

export interface MergeDialogClash {
  readonly name: string;
  readonly variants: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly machineLabel: string;
    readonly updatedAt: string;
  }>;
}

export type MergeDialogResolution =
  | { readonly strategy: "keep-from"; readonly environmentId: EnvironmentId }
  | { readonly strategy: "keep-both" };

export function PersonalAssistantMergeDialog({
  seats,
  clashes,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  seats: ReadonlyArray<MergeDialogSeat>;
  clashes: ReadonlyArray<MergeDialogClash>;
  busy?: boolean;
  error?: string | null;
  onConfirm: (input: {
    readonly routineOwnerEnvironmentId: EnvironmentId;
    readonly resolutions: Readonly<Record<string, MergeDialogResolution>>;
  }) => void;
  onCancel: () => void;
}) {
  const canonicalSeats = seats.filter((seat) => !seat.isStaleExtra);
  const unsupportedPeers = canonicalSeats.filter((seat) => !seat.supportsPersonalLink);
  const [routineOwner, setRoutineOwner] = useState<EnvironmentId | "">(
    canonicalSeats[0]?.environmentId ?? "",
  );
  const [resolutions, setResolutions] = useState<Record<string, MergeDialogResolution>>({});
  const [approved, setApproved] = useState(false);

  const unresolvedCount = clashes.filter((clash) => resolutions[clash.name] === undefined).length;
  const canConfirm =
    !busy &&
    approved &&
    unsupportedPeers.length === 0 &&
    unresolvedCount === 0 &&
    routineOwner !== "" &&
    canonicalSeats.length >= 2;

  return (
    <div
      className="project-settings-section"
      role="dialog"
      aria-modal="true"
      aria-label="Link personal assistants across your machines"
    >
      <h2>Link personal assistants across your machines</h2>
      <p className="project-muted">
        A pre-merge database snapshot will be saved on every participating machine before any memory
        files are linked. Threads stay on their own machines; only shared memory syncs.
      </p>

      {unsupportedPeers.length > 0 && (
        <p className="project-notice" role="alert">
          Update these machines before linking:{" "}
          {unsupportedPeers.map((peer) => peer.machineLabel).join(", ")}.
        </p>
      )}

      {error && (
        <p className="project-notice" role="alert">
          {error}
        </p>
      )}

      <section>
        <h3>Participating machines</h3>
        <ul>
          {seats.map((seat) => (
            <li key={`${seat.environmentId}:${seat.title}`}>
              <strong>{seat.title}</strong> on {seat.machineLabel}
              {seat.isStaleExtra ? " (duplicate row — will be archived safely)" : ""}
            </li>
          ))}
        </ul>
      </section>

      {clashes.length > 0 && (
        <section>
          <h3>Same-name memory file clashes ({clashes.length})</h3>
          <p className="project-muted">
            Choose how to keep each clashing file before the first sync. Nothing is overwritten
            silently.
          </p>
          {clashes.map((clash) => {
            const current = resolutions[clash.name];
            const value =
              current === undefined
                ? ""
                : current.strategy === "keep-both"
                  ? "keep-both"
                  : `keep-from:${current.environmentId}`;
            return (
              <div key={clash.name} className="project-environment-entry">
                <code>{clash.name}</code>
                <select
                  aria-label={`Resolution for ${clash.name}`}
                  value={value}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value;
                    setResolutions((prev) => {
                      const copy = { ...prev };
                      if (next === "") {
                        delete copy[clash.name];
                      } else if (next === "keep-both") {
                        copy[clash.name] = { strategy: "keep-both" };
                      } else if (next.startsWith("keep-from:")) {
                        copy[clash.name] = {
                          strategy: "keep-from",
                          environmentId: next.slice("keep-from:".length) as EnvironmentId,
                        };
                      }
                      return copy;
                    });
                  }}
                >
                  <option value="">Choose resolution…</option>
                  {clash.variants.map((variant) => (
                    <option
                      key={variant.environmentId}
                      value={`keep-from:${variant.environmentId}`}
                    >
                      Keep version from {variant.machineLabel}
                    </option>
                  ))}
                  <option value="keep-both">Keep both (suffix conflicting copy)</option>
                </select>
              </div>
            );
          })}
        </section>
      )}

      {canonicalSeats.length > 0 && (
        <label>
          <span>Scheduled routines run on</span>
          <select
            aria-label="Scheduled routines runner"
            value={routineOwner}
            disabled={busy}
            onChange={(e) => setRoutineOwner(e.target.value as EnvironmentId)}
          >
            {canonicalSeats.map((seat) => (
              <option key={seat.environmentId} value={seat.environmentId}>
                {seat.machineLabel}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        <input
          type="checkbox"
          checked={approved}
          disabled={busy}
          onChange={(e) => setApproved(e.target.checked)}
        />
        <span>I approve snapshotting each machine and linking these personal assistants</span>
      </label>

      <div className="project-actions">
        <button
          type="button"
          className="project-control project-primary"
          disabled={!canConfirm}
          onClick={() => {
            if (!canConfirm) return;
            onConfirm({
              routineOwnerEnvironmentId: routineOwner as EnvironmentId,
              resolutions,
            });
          }}
        >
          {busy ? "Linking…" : "Snapshot & link assistants"}
        </button>
        <button type="button" className="project-control" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
