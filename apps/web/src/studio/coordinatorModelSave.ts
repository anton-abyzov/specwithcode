import { useCallback, useEffect, useState } from "react";
import type { ModelSelection } from "@specweave-studio/contracts";

const saveFailure = (error: unknown): Error =>
  error instanceof Error ? error : new Error("The coordinator model was not saved. Try again.");

/** A project-local barrier. Failed selections must never silently send on the old model. */
export function createCoordinatorModelSave() {
  let pending: Promise<Error | null> | null = null;
  let failure: Error | null = null;
  let generation = 0;
  let active = true;
  const assertCurrent = (started: number) => {
    if (!active || started !== generation)
      throw new Error("The project changed before sending. Your message was not sent.");
  };
  return {
    activate() {
      active = true;
      return () => {
        active = false;
        generation++;
      };
    },
    get saving() {
      return pending !== null;
    },
    async save(operation: () => Promise<void>) {
      if (!active || pending) return null;
      const started = generation;
      failure = null;
      // Set the barrier before calling the mutation, including a same-frame Send.
      const promise = Promise.resolve()
        .then(operation)
        .then(() => null, saveFailure);
      pending = promise;
      const error = await promise;
      if (started !== generation || !active) return null;
      pending = null;
      failure = error;
      return { error };
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const started = generation;
      assertCurrent(started);
      // A second selection can start while the first settles. Wait for that too.
      while (pending) {
        await pending;
        assertCurrent(started);
      }
      if (failure)
        throw new Error(
          `Coordinator model was not saved. Choose it again before sending. ${failure.message}`,
        );
      // No await between readiness and dispatch: a new model save cannot slip in.
      return operation();
    },
  };
}

/** The owning surface is keyed by machine/project, so it gets an independent barrier. */
export function useCoordinatorModelSave(input: {
  persist: (selection: ModelSelection) => Promise<void>;
  onSaved: () => void;
  onError: (message: string | null) => void;
  onSettled: () => void;
}) {
  const [gate] = useState(createCoordinatorModelSave);
  const [saving, setSaving] = useState(false);
  useEffect(() => gate.activate(), [gate]);
  const save = useCallback(
    async (selection: ModelSelection) => {
      if (gate.saving) return;
      setSaving(true);
      input.onError(null);
      const result = await gate.save(() => input.persist(selection));
      if (result === null) return;
      setSaving(false);
      if (result.error) input.onError(result.error.message);
      else input.onSaved();
      input.onSettled();
    },
    [gate, input],
  );
  return { save, saving, runAfterSave: gate.run };
}
