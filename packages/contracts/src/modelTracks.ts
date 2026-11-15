/**
 * Model tracks: the three ordered model lists a person ranks. Daily is
 * routine work, Complex is the hardest work, Review is the model that checks
 * finished work. Daily and Complex are stored as the `routine` and `complex`
 * model lanes and Review as the adversarial review's `reviewers`, so a saved
 * list replaces the built-in order below and nothing is stored for a person
 * who never edits one.
 *
 * @module modelTracks
 */

export const MODEL_TRACKS = ["daily", "complex", "review"] as const;
export type ModelTrack = (typeof MODEL_TRACKS)[number];

export const MODEL_TRACK_LABELS: Record<ModelTrack, string> = {
  daily: "Daily",
  complex: "Complex",
  review: "Review",
};

/** One built-in track entry: a model by name, served by whichever provider lists it. */
export interface DefaultTrackModel {
  /** The model as its maker spells it; other providers' spellings match by identity. */
  readonly model: string;
  /**
   * Runs on a free account. Free entries close the Daily track and are never
   * used for Complex or Review work.
   */
  readonly free?: true;
}

/**
 * The built-in order of each track. An entry no enabled provider lists is
 * skipped, so the defaults fit whatever a machine has signed in.
 */
export const DEFAULT_MODEL_TRACKS: Readonly<Record<ModelTrack, ReadonlyArray<DefaultTrackModel>>> =
  {
    daily: [
      { model: "claude-opus-5-5" },
      { model: "gpt-6.1-sol" },
      { model: "muse-wonder-1.0" },
      { model: "gpt-6-luna", free: true },
    ],
    complex: [{ model: "claude-fable-5-2" }, { model: "gpt-6-astra" }],
    review: [{ model: "gpt-6.1-sol" }, { model: "muse-wonder-1.0" }, { model: "gemini-4-carbon" }],
  };
