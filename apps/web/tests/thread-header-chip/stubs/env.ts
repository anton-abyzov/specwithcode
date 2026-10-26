// `?electron=1` renders the header as the desktop app does, inside its title bar's drag region.
export const isElectron = new URLSearchParams(location.search).get("electron") === "1";
