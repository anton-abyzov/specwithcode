import { createRoot } from "react-dom/client";
import { UsagePage } from "../../src/components/usage/UsagePage";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";
const dark = new URLSearchParams(location.search).get("theme") !== "light";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
localStorage.setItem(
  "studio:usage-page-preferences:v1",
  JSON.stringify({ metric: "cost", windowDays: 30 }),
);
createRoot(document.getElementById("root")!).render(<UsagePage />);
