import { type RefObject, useInsertionEffect, useRef } from "react";

/**
 * A ref that holds the latest render's value, for handlers and effects that
 * must not change identity when it does. Assigned in an insertion effect,
 * before any layout or passive effect reads it, instead of during render, which
 * the React Compiler rejects and which leaves a whole component unoptimized.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}
