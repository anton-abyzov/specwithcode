import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CoordinatorReplySources } from "../../src/components/studio/CoordinatorReplySources";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";
import "../../src/components/studio/shell/shell.css";
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const source = {
  kind: "thread" as const,
  threadId: "mobile-docs",
  environmentId: "m4",
  title: "Mobile app link on /code page",
};
function Fixture() {
  const [opened, setOpened] = useState("");
  const open = (id: string, env: string) => setOpened(`${env}/${id}`);
  return (
    <main
      style={{ maxWidth: 760, margin: "40px auto", padding: 24, fontFamily: "Inter, sans-serif" }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 28 }}>SpecWithCode coordinator</h1>
      <p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
        Message from Mobile app link on /code page ›
      </p>
      <article style={{ margin: "22px 0 32px" }}>
        <CoordinatorReplySources sources={[source]} onOpenThread={open} />
        <p style={{ fontSize: 15, lineHeight: 1.65 }}>
          #2256 is merged and the docs site is deploying. The mobile app link is now part of the
          /code page.
        </p>
      </article>
      <details className="sws-checked-wake">
        <summary>
          Checked <CoordinatorReplySources inline sources={[source]} onOpenThread={open} /> · 3
          times
        </summary>
        <p>CI is still running.</p>
      </details>
      <article style={{ marginTop: 32 }}>
        <CoordinatorReplySources
          sources={[
            source,
            {
              kind: "thread",
              threadId: "release",
              environmentId: "remote",
              title: "Release verification on another machine",
            },
          ]}
          onOpenThread={open}
        />
        <p style={{ lineHeight: 1.65 }}>
          Both workers reported back. The next check is the published page.
        </p>
      </article>
      <article style={{ marginTop: 32 }}>
        <CoordinatorReplySources
          sources={[
            {
              kind: "pull_request",
              url: "https://github.com/example/repo/pull/1436",
              title: "PR #1436",
            },
          ]}
          onOpenThread={open}
        />
        <p>The pull request checks passed.</p>
      </article>
      <output
        data-opened
        style={{ display: "block", marginTop: 36, fontSize: 12, color: "var(--muted-foreground)" }}
      >
        {opened || "Isolated fixture · navigation uses synthetic threads"}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
