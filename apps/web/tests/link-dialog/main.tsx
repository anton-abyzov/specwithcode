/* The real "Link with a project on another machine" dialog on synthetic data (stubs.ts).
   `?case=` copies | empty | linked, `?theme=dark`, `?lang=` the interface language. */
import { createRoot } from "react-dom/client";
import { ProjectLinkDialog } from "../../src/components/studio/ProjectLinkDialog";
import { isLocale, setLocalePreference } from "../../src/i18n";
import { applyThemePalette } from "../../src/themePalette";
import { here } from "./stubs";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const lang = params.get("lang");
if (lang && isLocale(lang)) setLocalePreference(lang);

createRoot(document.getElementById("root")!).render(
  <ProjectLinkDialog open onOpenChange={() => {}} project={here} />,
);
