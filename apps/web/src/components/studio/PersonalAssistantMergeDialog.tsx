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
    readonly canonicalName: string;
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
  const [name, setName] = useState(() =>
    canonicalSeats.some((seat) => seat.title.trim() === "Percy")
      ? "Percy"
      : (canonicalSeats[0]?.title ?? "Percy"),
  );

  const unresolvedCount = clashes.filter((clash) => resolutions[clash.name] === undefined).length;
  const canConfirm =
    !busy &&
    approved &&
    unsupportedPeers.length === 0 &&
    unresolvedCount === 0 &&
    routineOwner !== "" &&
    name.trim().length > 0 &&
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
        Each machine saves a copy of its database before it links. Chats stay on their own machines;
        memory, name, icon, instructions and repository links sync. A file you keep from one machine
        is renamed on the others and stays there, so nothing is deleted.
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
                      Keep version from {variant.machineLabel}
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
          value={name}
          maxLength={200}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
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
              canonicalName: name.trim(),
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
