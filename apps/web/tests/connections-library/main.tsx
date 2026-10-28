import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionsLibrarySettings } from "../../src/components/settings/ConnectionsLibrarySettings";
import { setFixture, setProject } from "./mocks";
import "./fixture.css";
function App() {
  const [project, updateProject] = useState(false);
  return (
    <>
      <div
        className="mx-auto flex max-w-4xl flex-wrap gap-4 p-4 text-sm"
        aria-label="Test controls"
      >
        <label>
          Fixture state{" "}
          <select aria-label="Fixture state" onChange={(e) => setFixture(e.target.value)}>
            {[
              "ready",
              "offline",
              "denied",
              "error",
              "loading",
              "empty",
              "invalid",
              "folders",
              "grid",
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={project}
            onChange={(e) => {
              updateProject(e.target.checked);
              setProject(e.target.checked);
            }}
          />{" "}
          Project scope
        </label>
      </div>
      <ConnectionsLibrarySettings />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
