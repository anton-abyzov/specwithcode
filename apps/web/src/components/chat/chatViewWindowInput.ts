/** A suspended embedded chat keeps its session mounted without owning window input. */
export function registerChatViewWindowInput<K extends "keydown" | "paste">(
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  enabled: boolean,
  capture = true,
): () => void {
  if (!enabled) return () => {};
  window.addEventListener(type, handler, capture);
  return () => window.removeEventListener(type, handler, capture);
}
