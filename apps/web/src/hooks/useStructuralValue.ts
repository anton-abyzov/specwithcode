import { useState } from "react";

/**
 * `value`, or the one kept from an earlier render while `same` finds no
 * difference that matters. A list rebuilt with equal content then keeps its
 * identity, and the memoized children it feeds skip the render.
 */
export function useStructuralValue<T>(value: T, same: (kept: T, next: T) => boolean): T {
  const [kept, setKept] = useState(value);
  if (kept === value || same(kept, value)) return kept;
  // Adjusting state while rendering: React renders this component again at once,
  // before its children, with the new value kept.
  setKept(value);
  return value;
}
