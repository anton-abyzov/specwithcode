// The real first-run setup (WelcomeWizard and its steps) over stand-in answers,
// for the shared walker to go through. Query:
//   ?entry=start        the desktop app with SpecWithCode Connect: setup opens on the sign-in
//   ?entry=connection   a browser, or a build without Connect: it opens on the connection step
//   ?theme=light|dark
//   ?fixture=motion     the frame with its pictures and a busy step, for motion.mjs
// The language follows the browser's, as in the app.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WelcomeWizard } from "../../src/components/onboarding/WelcomeWizard";
import { fixture } from "./mocks";
import { MotionFixture } from "./motionFixture";
import "../access-recommendation/fixture.css";

document.documentElement.classList.toggle("dark", fixture.theme === "dark");
// A stand-in desktop bridge: setup opens on the sign-in only in the desktop app.
if (fixture.entry === "start") Object.assign(window, { desktopBridge: {} });

function App() {
  const [done, setDone] = useState(false);
  if (done) return <main data-fixture-done="">Workspace</main>;
  return (
    <WelcomeWizard
      localAvailable
      firstRun
      onDone={() => {
        fixture.calls.push(["done"]);
        setDone(true);
      }}
    />
  );
}

const motion = new URLSearchParams(location.search).get("fixture") === "motion";
createRoot(document.getElementById("root")!).render(motion ? <MotionFixture /> : <App />);
