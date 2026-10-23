export { createPreviewFramePainter } from "@specweave-studio/client-runtime/preview/server-browser-stream";
const sinks = new Set<{
  onFrame: (frame: Uint8Array) => void;
  onGone?: () => void;
  onHostSetup?: () => void;
}>();
export function createPreviewStreamClient(
  _target: unknown,
  events: { onFrame: (frame: Uint8Array) => void; onGone?: () => void; onHostSetup?: () => void },
) {
  sinks.add(events);
  return { send: () => {}, stop: () => sinks.delete(events) };
}
Object.assign(window, {
  feedLiveFrame: (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    for (const sink of sinks) sink.onFrame(bytes);
  },
  loseLiveHost: () => {
    for (const sink of [...sinks]) sink.onHostSetup?.();
  },
  liveSinkCount: () => sinks.size,
});
