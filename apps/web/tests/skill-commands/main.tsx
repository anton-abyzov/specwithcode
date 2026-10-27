// Headless fixture: the coordinator `/` menu built by the real coordinatorSlashItems and
// drawn by the real ComposerCommandMenu, for a Codex coordinator with the SpecWeave plugin
// and one personal skill, plus what the real send path makes of typed text. With
// `?harness=<id>` it draws that harness's coordinator menu instead (CoordinatorHarnesses.testkit.ts, or the
// catalogs captured on a real machine with `&data=live`).
import { ProviderDriverKind, type ServerProvider } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";
import { ComposerCommandMenu } from "../../src/components/chat/ComposerCommandMenu";
import { coordinatorSlashItems } from "../../src/components/studio/CoordinatorSlashMenu";
import { resolveLeadingSkillCommand } from "../../src/providerSkillSearch";
import {
  HARNESSES,
  TYPED_PER_HARNESS,
  type HarnessFixture,
} from "../../src/components/studio/CoordinatorHarnesses.testkit";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
document.body.classList.add("bg-background");
const query = params.get("q") ?? "";

const plugin = (leaf: string, displayName: string, description: string) => ({
  name: `sw:${leaf}`,
  displayName,
  description,
  path: `/Users/maria/.codex/plugins/cache/specweave/sw/3.1.14/skills/${leaf}/SKILL.md`,
  enabled: true,
});
const snapshot = {
  skills: [
    plugin(
      "do",
      "SpecWeave Do",
      "Work a SpecWeave increment task by task - claim, implement inside its Files, test, commit, done with evidence.",
    ),
    plugin("auto", "SpecWeave Auto", "Run an increment unattended until done"),
    plugin(
      "done",
      "SpecWeave Done",
      "Close a SpecWeave increment - every task done or skipped, specweave verify green, a fresh-context review.",
    ),
    plugin(
      "review",
      "SpecWeave Review",
      "Adversarial review of an increment before it ships, by a fresh context or another model family.",
    ),
    plugin(
      "handoff",
      "SpecWeave Handoff",
      "Hand work to another tool, account or machine and pick it up there, in two words.",
    ),
    plugin(
      "increment",
      "SpecWeave Increment",
      "Plan work as a SpecWeave increment - one spec.md with Problem, Scope, numbered ACs, Approach and Tasks.",
    ),
    plugin(
      "grill-me",
      "SpecWeave Grill Me",
      "Interview the user relentlessly, in rounds, until every decision in a plan is settled.",
    ),
    {
      name: "asc-whats-new-writer",
      description:
        "Generate engaging, localized App Store release notes (What's New) from git log.",
      path: "/Users/maria/.agents/skills/asc-whats-new-writer/SKILL.md",
      scope: "user",
      enabled: true,
    },
  ],
  slashCommands: [],
} as unknown as ServerProvider;
const provider = { driverKind: ProviderDriverKind.make("codex"), snapshot };
const items = coordinatorSlashItems(query, { onAppCommand: () => {}, provider, cwd: "/work" });
const typed = [
  "/sw:do 0042",
  "/sw:grill-me the pricing plan",
  "/continue",
  "/sw-do 0042",
  "please /sw:do",
];

const harnessId = params.get("harness");

interface LiveHarness {
  readonly id: HarnessFixture["id"];
  readonly label: string;
  readonly driverKind: string;
  readonly skills: ServerProvider["skills"];
}

async function loadHarness(): Promise<HarnessFixture | undefined> {
  if (params.get("data") !== "live") return HARNESSES.find((entry) => entry.id === harnessId);
  const live = (await (await fetch("/live-harnesses.json")).json()) as LiveHarness[];
  const entry = live.find((candidate) => candidate.id === harnessId);
  return entry
    ? {
        id: entry.id,
        label: entry.label,
        driverKind: ProviderDriverKind.make(entry.driverKind),
        snapshot: { skills: entry.skills, slashCommands: [] } as unknown as ServerProvider,
      }
    : undefined;
}

function HarnessMenu({ harness }: { harness: HarnessFixture }) {
  const harnessItems = coordinatorSlashItems(query, {
    onAppCommand: () => {},
    provider: { driverKind: harness.driverKind, snapshot: harness.snapshot },
    cwd: "/work",
  });
  const typedHere: Record<string, string> =
    params.get("data") === "live" ? {} : TYPED_PER_HARNESS[harness.id];
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 bg-background p-4 text-foreground">
      <h1
        className="font-medium text-sm"
        data-harness={harness.id}
        data-own={JSON.stringify(harness.snapshot.skills.map((skill) => `$${skill.name}`))}
      >
        {harness.label} coordinator: {harness.snapshot.skills.length} skills
      </h1>
      <div className="rounded-xl border bg-popover" data-menu>
        <ComposerCommandMenu
          listId="skill-commands"
          items={harnessItems}
          resolvedTheme={params.get("theme") === "light" ? "light" : "dark"}
          isLoading={false}
          triggerKind="slash-command"
          activeItemId={harnessItems[0]?.id ?? null}
          onHighlightedItemChange={() => {}}
          onSelect={() => {}}
        />
      </div>
      <div className="rounded-lg border p-3 font-mono text-xs" data-composer>
        /{query}
      </div>
      <table className="text-xs" data-send>
        <tbody>
          {Object.keys(typedHere).map((text) => {
            const sent = resolveLeadingSkillCommand(text, harness.snapshot, "/work");
            return (
              <tr key={text} data-typed={text} data-sent={sent} data-expected={typedHere[text]}>
                <td className="pe-4 font-mono">{text}</td>
                <td className="font-mono">{sent}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

if (harnessId) {
  const harness = await loadHarness();
  createRoot(document.getElementById("root")!).render(
    harness ? <HarnessMenu harness={harness} /> : <p data-missing>No harness {harnessId}</p>,
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 bg-background p-4 text-foreground">
      <div className="rounded-xl border bg-popover" data-menu>
        <ComposerCommandMenu
          listId="skill-commands"
          items={items}
          resolvedTheme={params.get("theme") === "light" ? "light" : "dark"}
          isLoading={false}
          triggerKind="slash-command"
          activeItemId={items[0]?.id ?? null}
          onHighlightedItemChange={() => {}}
          onSelect={() => {}}
        />
      </div>
      <div className="rounded-lg border p-3 font-mono text-xs" data-composer>
        /{query}
      </div>
      <table className="text-xs" data-send>
        <thead>
          <tr>
            <th className="pe-4 text-start">Typed</th>
            <th className="text-start">Sent to the provider</th>
          </tr>
        </thead>
        <tbody>
          {typed.map((text) => (
            <tr
              key={text}
              data-typed={text}
              data-sent={resolveLeadingSkillCommand(text, snapshot, "/work")}
            >
              <td className="pe-4 font-mono">{text}</td>
              <td className="font-mono">{resolveLeadingSkillCommand(text, snapshot, "/work")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>,
  );
}
