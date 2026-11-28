/**
 * The parts of a screen viewer's own window (1519) that need no Electron: its
 * address, its title, where it is allowed to go, and the size and place it
 * remembers per machine.
 */

export const SCREEN_VIEWER_WINDOW_ROLE = "screen-viewer";
/** The route a viewer window shows; the renderer uses hash history. */
export const SCREEN_VIEWER_ROUTE_PREFIX = "/screen/";
export const SCREEN_VIEWER_DEFAULT_SIZE = { width: 1280, height: 840 } as const;
export const SCREEN_VIEWER_MIN_SIZE = { width: 480, height: 320 } as const;
/** Machines whose window place is remembered; the oldest is forgotten first. */
export const SCREEN_VIEWER_REMEMBERED = 32;
const TITLE_MAX = 120;

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The machine's name rides in the route's search, so the page can name it too. */
export const screenViewerWindowUrl = (
  desktopUrl: string,
  environmentId: string,
  name: string,
): string =>
  `${desktopUrl.replace(/\/$/, "")}/#${SCREEN_VIEWER_ROUTE_PREFIX}${encodeURIComponent(environmentId)}?name=${encodeURIComponent(name)}`;

/** The plain name a page supplied, bounded; empty when there is none. */
export const screenViewerMachineName = (name: unknown): string =>
  typeof name === "string"
    ? name
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, TITLE_MAX)
    : "";

/** "Screen of Work Mac", from a name a page supplied: one plain line, bounded. */
export const screenViewerWindowTitle = (name: unknown): string => {
  const plain = screenViewerMachineName(name);
  return plain === "" ? "Screen of another machine" : `Screen of ${plain}`;
};

/**
 * Whether the window's document may go to `targetUrl`: only its own address.
 * Route changes inside the page are hash changes and never reach this check.
 */
export const isScreenViewerNavigationAllowed = (windowUrl: string, targetUrl: string): boolean => {
  try {
    const own = new URL(windowUrl);
    const target = new URL(targetUrl);
    return (
      own.host !== "" &&
      target.username === "" &&
      target.password === "" &&
      own.protocol === target.protocol &&
      own.host === target.host &&
      own.pathname === target.pathname &&
      own.search === target.search &&
      own.hash === target.hash
    );
  } catch {
    return false;
  }
};

/**
 * Whether a route change inside the page keeps the window on its own machine.
 * The renderer routes by hash, which no navigation event can stop, so the
 * window checks each one after it happens and goes back when it left.
 */
export const isScreenViewerRouteKept = (windowUrl: string, targetUrl: string): boolean => {
  const route = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}${parsed.hash.split("?")[0]}`;
    } catch {
      return null;
    }
  };
  const own = route(windowUrl);
  return own !== null && own === route(targetUrl);
};

const isBounds = (value: unknown): value is WindowBounds => {
  if (typeof value !== "object" || value === null) return false;
  const bounds = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every(
    (key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]),
  );
};

/** The remembered places, oldest first. Anything unreadable is forgotten, never an error. */
export const parseViewerPlaces = (text: string | null): Map<string, WindowBounds> => {
  const places = new Map<string, WindowBounds>();
  if (text === null) return places;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return places;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return places;
  for (const [environmentId, bounds] of Object.entries(value as Record<string, unknown>)) {
    if (!isBounds(bounds) || bounds.width < 1 || bounds.height < 1) continue;
    places.set(environmentId, {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
  return places;
};

export const rememberViewerPlace = (
  places: Map<string, WindowBounds>,
  environmentId: string,
  bounds: WindowBounds,
): string => {
  places.delete(environmentId);
  places.set(environmentId, bounds);
  while (places.size > SCREEN_VIEWER_REMEMBERED) {
    const oldest = places.keys().next().value;
    if (oldest === undefined) break;
    places.delete(oldest);
  }
  return JSON.stringify(Object.fromEntries(places));
};

/**
 * Where the window opens: the remembered place when enough of it is on a
 * connected display, otherwise the default size, centred, shifted a little
 * per window already open so two new windows do not sit exactly on top.
 */
export const placeViewerWindow = (input: {
  readonly saved: WindowBounds | undefined;
  readonly workAreas: ReadonlyArray<WindowBounds>;
  readonly openCount: number;
}): WindowBounds | { readonly width: number; readonly height: number } => {
  const { saved, workAreas } = input;
  if (saved !== undefined) {
    const visible = workAreas.some((area) => {
      const width =
        Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
      const height =
        Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
      return width >= 120 && height >= 80;
    });
    if (visible)
      return {
        ...saved,
        width: Math.max(saved.width, SCREEN_VIEWER_MIN_SIZE.width),
        height: Math.max(saved.height, SCREEN_VIEWER_MIN_SIZE.height),
      };
  }
  const area = workAreas[0];
  if (area === undefined) return { ...SCREEN_VIEWER_DEFAULT_SIZE };
  const width = Math.min(SCREEN_VIEWER_DEFAULT_SIZE.width, area.width);
  const height = Math.min(SCREEN_VIEWER_DEFAULT_SIZE.height, area.height);
  const shift = (input.openCount % 6) * 28;
  return {
    x: Math.round(area.x + (area.width - width) / 2 + shift),
    y: Math.round(area.y + (area.height - height) / 2 + shift),
    width,
    height,
  };
};
