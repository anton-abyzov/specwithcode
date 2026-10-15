import { createRoot } from "react-dom/client";
import { UsageLimitsSection } from "../../src/components/usage/UsageLimits";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
document.body.style.backgroundColor = dark ? "#1f1f1f" : "#fafafa";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto min-h-screen max-w-5xl p-4 sm:p-8">
    <h1 className="mb-4 text-lg font-semibold">Usage / All environments · Limits</h1>
    <UsageLimitsSection selectedEnvironmentIds={null} now={Date.now()} />
  </main>,
);
