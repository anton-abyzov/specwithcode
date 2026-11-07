// Synthetic data only: no server, account, provider or store.
import { createRoot } from "react-dom/client";
import { StudioOverview } from "../../src/components/studio/StudioOverview";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
createRoot(document.getElementById("root")!).render(<StudioOverview />);
