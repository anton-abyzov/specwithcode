import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HandoffSecretsStep } from "./HandoffSecretsStep";

const TRACKED_HINT =
  "Tracked in Git, so it travels with the repository's history. If it holds a secret, remove it from Git and rotate it.";

function render(hints: ReadonlyArray<{ path: string; source: string; hint: string }>) {
  return renderToStaticMarkup(
    <HandoffSecretsStep
      files={[]}
      hints={hints}
      selected={[]}
      included
      sourceLabel="M4"
      targetLabel="M3"
      homeSupported
      disabled={false}
      onChange={() => {}}
    />,
  );
}

/** The markup of one hint group, from its slot to the end of its list. */
function group(html: string, slot: string): string | null {
  const start = html.indexOf(`data-slot="${slot}"`);
  if (start < 0) return null;
  return html.slice(start, html.indexOf("</ul>", start));
}

describe("secret hints on the copy review", () => {
  it("heads tracked files as copied with the repository, apart from secrets left behind", () => {
    const html = render([
      { path: ".env", source: "Git", hint: TRACKED_HINT },
      { path: ".doppler.yaml", source: "Doppler", hint: "Set up Doppler there." },
    ]);
    const behind = group(html, "copy-secrets-hints");
    const tracked = group(html, "copy-secrets-tracked");
    expect(behind).toContain("Not copied");
    expect(behind).toContain(".doppler.yaml");
    expect(behind).not.toContain(".env<");
    expect(tracked).toContain("Copied with the repository");
    expect(tracked).toContain(".env");
    expect(tracked).toContain("travels with the repository");
    expect(tracked).not.toContain("Not copied");
  });

  it("shows no Not copied heading when every hint is a tracked file", () => {
    const html = render([{ path: "certs/server.pem", source: "Git", hint: TRACKED_HINT }]);
    expect(html).not.toContain("Not copied");
    expect(group(html, "copy-secrets-hints")).toBeNull();
    expect(group(html, "copy-secrets-tracked")).toContain("certs/server.pem");
  });
});
