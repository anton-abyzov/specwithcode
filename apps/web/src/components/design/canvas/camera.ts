import { useSyncExternalStore } from "react";
import { fitRect, zoomAt, type Camera, type Point, type Rect } from "./geometry";

/**
 * The canvas camera lives outside React: pan and zoom write one transform on
 * the world layer and a `--zoom` variable the overlay scales by, so moving the
 * view never re-renders nodes. Components that show the zoom subscribe.
 */
export class CameraStore {
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private world: HTMLElement | null = null;
  private viewport: HTMLElement | null = null;
  private listeners = new Set<() => void>();
  private viewListeners = new Set<() => void>();
  private frame = 0;
  private viewFrame = 0;

  get = () => this.camera;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Every pan and zoom, once per frame: for overlays that follow a node on screen. */
  subscribeView = (listener: () => void) => {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  };

  /** The viewport element, for overlays that track its size. */
  viewportElement() {
    return this.viewport;
  }

  attach(world: HTMLElement | null, viewport: HTMLElement | null) {
    this.world = world;
    this.viewport = viewport;
    this.write();
  }

  viewportSize() {
    const rect = this.viewport?.getBoundingClientRect();
    return { width: rect?.width ?? 1200, height: rect?.height ?? 800 };
  }

  /** Screen point relative to the viewport's top-left. */
  localPoint(clientX: number, clientY: number): Point {
    const rect = this.viewport?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }

  set(next: Camera) {
    if (next.x === this.camera.x && next.y === this.camera.y && next.zoom === this.camera.zoom)
      return;
    const zoomChanged = next.zoom !== this.camera.zoom;
    this.camera = next;
    this.write();
    if (zoomChanged) this.notify();
  }

  panBy(dx: number, dy: number) {
    this.set({ ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy });
  }

  zoomTo(zoom: number, anchor?: Point) {
    const size = this.viewportSize();
    this.set(zoomAt(this.camera, zoom, anchor ?? { x: size.width / 2, y: size.height / 2 }));
  }

  fit(rect: Rect, maxZoom = 1) {
    this.set(fitRect(rect, this.viewportSize(), maxZoom));
  }

  private write() {
    const world = this.world;
    if (world === null) return;
    const { x, y, zoom } = this.camera;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    world.style.setProperty("--zoom", String(zoom));
    this.notifyView();
  }

  private notifyView() {
    if (this.viewListeners.size === 0 || this.viewFrame !== 0) return;
    const run = () => {
      this.viewFrame = 0;
      for (const listener of this.viewListeners) listener();
    };
    if (typeof requestAnimationFrame === "function") this.viewFrame = requestAnimationFrame(run);
    else run();
  }

  private notify() {
    // Coalesce zoom readouts to one update per frame during a wheel gesture.
    if (this.frame !== 0) return;
    const run = () => {
      this.frame = 0;
      for (const listener of this.listeners) listener();
    };
    if (typeof requestAnimationFrame === "function") this.frame = requestAnimationFrame(run);
    else run();
  }
}

export function useCameraZoom(store: CameraStore): number {
  return useSyncExternalStore(store.subscribe, () => store.get().zoom);
}
