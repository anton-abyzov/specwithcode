// Coordinator provider snapshots for four harnesses, shaped like each server listing:
// ClaudeSkills (plugin `<plugin>:<leaf>` and `~/.claude/skills`), the Codex app server's
// `skills/list`, Copilot's ACP commands (skills marked by their input hint, run as `/name`)
// and AntigravitySkills (`~/.gemini/config/skills`). Each harness carries only what it loads.
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSkill,
} from "@specweave-studio/contracts";

export interface HarnessFixture {
  readonly id: "claude" | "codex" | "copilot" | "antigravity";
  readonly label: string;
  readonly driverKind: ProviderDriverKind;
  readonly snapshot: ServerProvider;
}

const skill = (
  name: string,
  path: string,
  scope: string,
  description: string,
  displayName?: string,
): ServerProviderSkill => ({
  name,
  path,
  scope,
  description,
  enabled: true,
  ...(displayName ? { displayName } : {}),
});

const SW = {
  do: "Work a SpecWeave increment task by task - claim, implement inside its Files, test, commit, done with evidence.",
  increment: "Plan work as a SpecWeave increment - one spec.md with Problem, Scope, ACs and Tasks.",
  "grill-me":
    "Interview the user relentlessly, in rounds, until every decision in a plan is settled.",
} as const;

const snapshot = (
  driver: string,
  skills: ReadonlyArray<ServerProviderSkill>,
  slashCommands: ReadonlyArray<{ readonly name: string; readonly description: string }>,
) => ({ driver, skills, slashCommands }) as unknown as ServerProvider;

export const HARNESSES: ReadonlyArray<HarnessFixture> = [
  {
    id: "claude",
    label: "Claude Code",
    driverKind: ProviderDriverKind.make("claudeAgent"),
    snapshot: snapshot(
      "claudeAgent",
      [
        ...(["do", "increment", "grill-me"] as const).map((leaf) =>
          skill(
            `sw:${leaf}`,
            `/Users/maria/.claude/plugins/marketplaces/specweave/plugins/specweave/skills/${leaf}/SKILL.md`,
            "plugin",
            SW[leaf],
          ),
        ),
        skill(
          "unslop",
          "/Users/maria/.claude/skills/unslop/SKILL.md",
          "user",
          "Cut AI tells from any writing.",
        ),
      ],
      // The Agent SDK init lists skills among the slash commands too.
      [
        { name: "compact", description: "Clear history but keep a summary" },
        { name: "review", description: "Review a pull request" },
        { name: "sw:do", description: SW.do },
        { name: "unslop", description: "Cut AI tells from any writing." },
      ],
    ),
  },
  {
    id: "codex",
    label: "Codex",
    driverKind: ProviderDriverKind.make("codex"),
    snapshot: snapshot(
      "codex",
      [
        ...(["do", "increment", "grill-me"] as const).map((leaf) =>
          skill(
            `sw:${leaf}`,
            `/Users/maria/.codex/plugins/cache/specweave/sw/3.1.14/skills/${leaf}/SKILL.md`,
            "user",
            SW[leaf],
            `SpecWeave ${leaf === "grill-me" ? "Grill Me" : leaf[0]!.toUpperCase() + leaf.slice(1)}`,
          ),
        ),
        skill(
          "asc-whats-new-writer",
          "/Users/maria/.agents/skills/asc-whats-new-writer/SKILL.md",
          "user",
          "Generate localized App Store release notes from git log.",
        ),
      ],
      [],
    ),
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    driverKind: ProviderDriverKind.make("acpRegistry"),
    snapshot: snapshot(
      "acpRegistry",
      ["unslop", "hyperframes", "asc-whats-new-writer"].map((name) =>
        skill(
          name,
          `acp://command/${name}`,
          "agent",
          name === "hyperframes"
            ? "Make, edit, animate or render any video with HyperFrames."
            : name === "unslop"
              ? "Cut AI tells from any writing."
              : "Generate localized App Store release notes from git log.",
        ),
      ),
      [
        { name: "compact", description: "Summarize conversation history" },
        { name: "review", description: "Run code review agent to analyze changes" },
        { name: "skills", description: "Manage skills for enhanced capabilities" },
      ],
    ),
  },
  {
    id: "antigravity",
    label: "Antigravity",
    driverKind: ProviderDriverKind.make("antigravity"),
    snapshot: snapshot(
      "antigravity",
      ["hyperframes", "asc-apple-ads"].map((name) =>
        skill(
          name,
          `/Users/maria/.gemini/config/skills/${name}/SKILL.md`,
          "user",
          name === "hyperframes"
            ? "Make, edit, animate or render any video with HyperFrames."
            : "Manage Apple Ads with asc.",
        ),
      ),
      [],
    ),
  },
];

/** Text typed into the coordinator and what each harness must receive from the composer. */
export const TYPED_PER_HARNESS: Record<HarnessFixture["id"], Record<string, string>> = {
  claude: {
    "/sw:do 0042": "$sw:do 0042",
    "/unslop the README": "$unslop the README",
    "/review": "/review",
    "/hyperframes intro": "/hyperframes intro",
  },
  codex: {
    "/sw:do 0042": "$sw:do 0042",
    "/asc-whats-new-writer": "$asc-whats-new-writer",
    "/unslop the README": "/unslop the README",
    "/continue": "/continue",
  },
  copilot: {
    "/unslop the README": "$unslop the README",
    "/sw:do 0042": "/sw:do 0042",
    "/review": "/review",
    "/compact": "/compact",
  },
  antigravity: {
    "/hyperframes intro": "$hyperframes intro",
    "/sw:do 0042": "/sw:do 0042",
    "/unslop the README": "/unslop the README",
  },
};
