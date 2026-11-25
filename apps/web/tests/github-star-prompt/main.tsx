// The GitHub star card (increment 1489) over a stand-in workspace. Query: ?theme=light|dark
import { createRoot } from "react-dom/client";
import { GitHubStarPromptCard } from "../../src/components/github/GitHubStarPromptCard";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const log = (answer: string) => {
  document.body.dataset.answer = answer;
};
createRoot(document.getElementById("root")!).render(
  <div className="h-screen p-8 text-sm text-muted-foreground">
    <p className="text-foreground font-medium">Thread: refactor settings sync</p>
    <p>The agent finished. Waiting for your next message.</p>
    <GitHubStarPromptCard
      onStar={() => log("star")}
      onAlreadyStarred={() => log("already")}
      onNotNow={() => log("not-now")}
    />
  </div>,
);
