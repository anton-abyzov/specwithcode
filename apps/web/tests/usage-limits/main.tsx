// The real pooled Limits view over fictional accounts.
// `?theme=dark` picks the theme. Nothing here talks to a server.
import { createRoot } from "react-dom/client";
import { UsageLimitsPooled } from "../../src/components/usage/UsageLimitsPooled";
import { applyThemePalette } from "../../src/themePalette";
import { fixturePresentations, NOW } from "./data";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
Date.now = () => NOW;

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-6xl p-6">
    <UsageLimitsPooled presentations={fixturePresentations as never} now={NOW} />
  </main>,
);
