/**
 * Design features that work end to end in this build. The gallery shows a
 * "Make something new" entry only for a feature that is on; the lane that
 * ships slides or design-system creation turns its flag on in the same change.
 */
export const DESIGN_FEATURES = {
  slides: true,
  designSystems: true,
} as const satisfies Record<string, boolean>;
