import { useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { environmentFragment } from "@specweave-studio/shared/personalAssistantMigration";

export interface MergeDialogSeat {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly title: string;
  readonly supportsPersonalLink: boolean;
  readonly isStaleExtra?: boolean | undefined;
  /** Why this seat's preview failed: it is unreachable, not out of date. */
  readonly previewError?: string | null | undefined;
}

/**
 * Machine names as the review shows them: two machines with the same label get
 * a short id fragment, so "Keep version from" and the runner list stay tellable apart.
 */
export function distinctMachineLabels(
  seats: ReadonlyArray<{ readonly environmentId: string; readonly machineLabel: string }>,
): Map<string, string> {
  const envsByLabel = new Map<string, Set<string>>();
  for (const seat of seats) {
    const envs = envsByLabel.get(seat.machineLabel) ?? new Set<string>();
    envs.add(seat.environmentId);
    envsByLabel.set(seat.machineLabel, envs);
  }
  const out = new Map<string, string>();
  for (const seat of seats) {
    const shared = (envsByLabel.get(seat.machineLabel)?.size ?? 0) > 1;
    out.set(
      seat.environmentId,
      shared
        ? `${seat.machineLabel} (${environmentFragment(seat.environmentId)})`
        : seat.machineLabel,
    );
  }
  return out;
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
  blockedMessage = null,
  note = null,
  lockedName = null,
  defaultRoutineOwner = null,
  onRetryUnreachable,
  onLeaveOut,
  onConfirm,
  onCancel,
}: {
  seats: ReadonlyArray<MergeDialogSeat>;
  clashes: ReadonlyArray<MergeDialogClash>;
  busy?: boolean;
  error?: string | null;
  /** A reason linking cannot go ahead at all, such as two different existing links. */
  blockedMessage?: string | null;
  /** An extra line, such as that this machine has no assistant of its own yet. */
  note?: string | null;
  /** Extending an existing link keeps its name: shown, not editable. */
  lockedName?: string | null;
  /** The machine that runs routines now, when extending a link. */
  defaultRoutineOwner?: EnvironmentId | null;
  onRetryUnreachable?: () => void;
  onLeaveOut?: (environmentId: EnvironmentId) => void;
  onConfirm: (input: {
    readonly routineOwnerEnvironmentId: EnvironmentId;
    readonly resolutions: Readonly<Record<string, MergeDialogResolution>>;
    readonly canonicalName: string;
  }) => void;
  onCancel: () => void;
}) {
  const canonicalSeats = seats.filter((seat) => !seat.isStaleExtra);
  const labels = distinctMachineLabels(seats);
  const labelOf = (environmentId: string, fallback: string) =>
    labels.get(environmentId) ?? fallback;
  const unreachableSeats = canonicalSeats.filter((seat) => typeof seat.previewError === "string");
  // Only a machine that answered with an old protocol needs an update.
  const unsupportedPeers = canonicalSeats.filter(
    (seat) => !seat.supportsPersonalLink && typeof seat.previewError !== "string",
  );
  const [routineOwner, setRoutineOwner] = useState<EnvironmentId | "">(
    defaultRoutineOwner !== null &&
      canonicalSeats.some((seat) => seat.environmentId === defaultRoutineOwner)
      ? defaultRoutineOwner
      : (canonicalSeats[0]?.environmentId ?? ""),
  );
  const [resolutions, setResolutions] = useState<Record<string, MergeDialogResolution>>({});
  const [approved, setApproved] = useState(false);
  const [name, setName] = useState(() =>
    canonicalSeats.some((seat) => seat.title.trim() === "Percy")
      ? "Percy"
      : (canonicalSeats[0]?.title ?? "Percy"),
  );

  const finalName = (lockedName ?? name).trim();
  const unresolvedCount = clashes.filter((clash) => resolutions[clash.name] === undefined).length;
  const canConfirm =
    !busy &&
    approved &&
    blockedMessage === null &&
    unsupportedPeers.length === 0 &&
    unreachableSeats.length === 0 &&
    unresolvedCount === 0 &&
    routineOwner !== "" &&
    canonicalSeats.some((seat) => seat.environmentId === routineOwner) &&
    finalName.length > 0 &&
    canonicalSeats.length >= 2;

  // The surrounding dialog popup carries the dialog role and its name.
  return (
    <div className="project-settings-section">
      <h2>Link personal assistants across your machines</h2>
      <p className="project-muted">
        Each machine saves a copy of its database before it links. Chats stay on their own machines;
        memory, name, icon, instructions and repository links sync. A file you keep from one machine
        is renamed on the others and stays there, so nothing is deleted.
      </p>

      {note && <p className="project-muted">{note}</p>}

      {blockedMessage && (
        <p className="project-notice" role="alert">
          {blockedMessage}
        </p>
      )}

      {unsupportedPeers.length > 0 && (
        <p className="project-notice" role="alert">
          Update these machines before linking:{" "}
          {unsupportedPeers
            .map((peer) => labelOf(peer.environmentId, peer.machineLabel))
            .join(", ")}
          .
        </p>
      )}

      {unreachableSeats.length > 0 && (
        <div className="project-notice" role="alert">
          {unreachableSeats.map((seat) => (
            <p key={seat.environmentId}>
              Could not read {labelOf(seat.environmentId, seat.machineLabel)}: {seat.previewError}{" "}
              {onLeaveOut && (
                <button
                  type="button"
                  className="project-control"
                  disabled={busy}
                  onClick={() => onLeaveOut(seat.environmentId)}
                >
                  Leave {labelOf(seat.environmentId, seat.machineLabel)} out
                </button>
              )}
            </p>
          ))}
          {onRetryUnreachable && (
            <button
              type="button"
              className="project-control"
              disabled={busy}
              onClick={onRetryUnreachable}
            >
              Try again
            </button>
          )}
        </div>
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
              <strong>{seat.title}</strong> on {labelOf(seat.environmentId, seat.machineLabel)}
              {seat.isStaleExtra
                ? " (a second assistant on that machine: it stays as it is, not linked)"
                : ""}
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
                      Keep version from {labelOf(variant.environmentId, variant.machineLabel)}
                    </option>
                  ))}
                  <option value="keep-both">
                    Keep both (the older copies get the machine name)
                  </option>
                </select>
              </div>
            );
          })}
        </section>
      )}

      <label>
        <span>Name on every machine</span>
        <input
          type="text"
          aria-label="Linked assistant name"
          value={lockedName ?? name}
          maxLength={200}
          disabled={busy}
          readOnly={lockedName !== null}
          onChange={(e) => setName(e.target.value)}
        />
        {lockedName !== null && (
          <span className="project-muted">
            These machines join the linked assistant and keep its name.
          </span>
        )}
      </label>

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
                {labelOf(seat.environmentId, seat.machineLabel)}
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
        <span>Save a copy on each machine and link these assistants</span>
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
              canonicalName: finalName,
            });
          }}
        >
          {busy ? "Linking…" : "Link assistants"}
        </button>
        <button type="button" className="project-control" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
