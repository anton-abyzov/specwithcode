import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDownIcon, ArrowUpIcon, SparklesIcon, Trash2Icon, XIcon, RouteIcon } from "lucide-react";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

interface ModelEntry {
  instanceId: string;
  provider: string;
  model: string;
  unavailable?: string;
}

interface PreferenceRule {
  id: string;
  description: string;
  note?: string;
}

function Fixture() {
  const [complex, setComplex] = useState<ModelEntry[]>([
    { instanceId: "claudeAgent", provider: "Claude Code", model: "Opus 5.5" },
    { instanceId: "copilot", provider: "GitHub Copilot", model: "GPT-6 Astra" },
    { instanceId: "codex", provider: "OpenAI Codex", model: "GPT-5" },
  ]);

  const [routine, setRoutine] = useState<ModelEntry[]>([
    { instanceId: "claudeAgent", provider: "Claude Code", model: "Opus 5.5" },
    { instanceId: "copilot", provider: "GitHub Copilot", model: "Opus 5.5", unavailable: "usage limit held" },
    { instanceId: "claudeAgent", provider: "Claude Code", model: "Haiku 5.5" },
  ]);

  const [preferences, setPreferences] = useState<PreferenceRule[]>([
    { id: "pref-1", description: "\"database\", \"migration\": use Claude Code · Opus 5.5", note: "User preferred Opus for DB tasks" },
    { id: "pref-2", description: "\"readme\", \"docs\": avoid GitHub Copilot · GPT-6 Astra" },
    { id: "pref-3", description: "Summary tasks: treat as Routine" },
  ]);

  const [chipFeedbackSaved, setChipFeedbackSaved] = useState(false);

  return (
    <main className="mx-auto min-h-screen max-w-4xl space-y-8 p-6 sm:p-10 bg-background text-foreground">
      <div>
        <div className="flex items-center gap-2">
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">SpecWithCode</span>
          <span className="text-xs text-muted-foreground">Settings &gt; Providers &gt; Model lanes</span>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Model Lanes &amp; Learned Preferences</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ordered fallback lists for complex and routine tasks, plus per-project learned rules.
        </p>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-6 shadow-sm space-y-6">
        <section data-testid="complex-lane" className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Complex and creative lane</h2>
              <p className="text-xs text-muted-foreground">
                Frontier models for architecture, design, deep debugging and creative tasks. A worker starts on the first available model.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border/80 px-2.5 py-1 text-xs font-medium hover:bg-muted"
              >
                <SparklesIcon className="size-3 text-amber-500" />
                Seed from favorites
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Add model
              </button>
            </div>
          </div>
          <ol className="flex flex-col gap-1.5" aria-label="Complex lane order">
            {complex.map((entry, index) => (
              <li
                key={entry.instanceId + ":" + entry.model}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-3 py-2 text-sm"
              >
                <span className="w-5 text-right text-xs font-semibold text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {entry.provider} · {entry.model}
                </span>
                <button
                  type="button"
                  disabled={index === 0}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label="Move up"
                >
                  <ArrowUpIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={index === complex.length - 1}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label="Move down"
                >
                  <ArrowDownIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label="Remove"
                  onClick={() => setComplex(complex.filter((_, i) => i !== index))}
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
        </section>

        <hr className="border-border/60" />

        <section data-testid="routine-lane" className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Routine lane</h2>
              <p className="text-xs text-muted-foreground">
                Default models for well-specified work, led by Opus 5.5. When a provider is exhausted or limited, advances to the next available model.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border/80 px-2.5 py-1 text-xs font-medium hover:bg-muted"
              >
                <SparklesIcon className="size-3 text-amber-500" />
                Seed from favorites
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Add model
              </button>
            </div>
          </div>
          <ol className="flex flex-col gap-1.5" aria-label="Routine lane order">
            {routine.map((entry, index) => (
              <li
                key={entry.instanceId + ":" + entry.model + ":" + index}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-3 py-2 text-sm"
              >
                <span className="w-5 text-right text-xs font-semibold text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {entry.provider} · {entry.model}
                  {entry.unavailable ? (
                    <span className="ml-2 inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-normal text-amber-600 dark:text-amber-400">
                      {entry.unavailable}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  disabled={index === 0}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label="Move up"
                >
                  <ArrowUpIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={index === routine.length - 1}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label="Move down"
                >
                  <ArrowDownIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label="Remove"
                  onClick={() => setRoutine(routine.filter((_, i) => i !== index))}
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
        </section>

        <hr className="border-border/60" />

        <section data-testid="learned-preferences" className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Learned model preferences</h2>
              <p className="text-xs text-muted-foreground">
                Rules this project learned from your feedback in chat, or recorded by the coordinator. Prefer rules are tried first; avoid rules are skipped.
              </p>
            </div>
            {preferences.length > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline"
                onClick={() => setPreferences([])}
              >
                Reset all rules
              </button>
            ) : null}
          </div>

          <ul className="flex flex-col gap-2" aria-label="Learned model preferences list">
            {preferences.map((pref) => (
              <li
                key={pref.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/50 px-3.5 py-2.5 text-sm"
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{pref.description}</span>
                  {pref.note ? (
                    <span className="text-xs text-muted-foreground truncate">
                      Context: &ldquo;{pref.note}&rdquo;
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label={"Delete rule " + pref.id}
                  onClick={() => setPreferences(preferences.filter((p) => p.id !== pref.id))}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-6 shadow-sm space-y-4">
        <div>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">In Chat</span>
          <h2 className="mt-1 text-base font-semibold">Routing Chip &amp; Feedback Popover</h2>
          <p className="text-xs text-muted-foreground">
            Shows how the routing decision is displayed in the thread header, and how users teach the project directly from chat.
          </p>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-lg border border-border/60 bg-muted/20">
          <span className="text-xs font-semibold text-muted-foreground">Thread Header:</span>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            <RouteIcon className="size-3" />
            Lanes · Complex · Code
          </div>
        </div>

        <div data-testid="popover-preview" className="rounded-lg border border-border/70 bg-popover text-popover-foreground p-4 shadow-md max-w-lg space-y-3">
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <strong className="text-sm font-semibold">Model lane routing</strong>
            <span className="text-xs text-muted-foreground">Moved from baseline</span>
          </div>

          <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs">
            <dt className="text-muted-foreground font-medium">Model lane</dt>
            <dd className="font-semibold text-primary">Complex and creative</dd>

            <dt className="text-muted-foreground font-medium">Task class</dt>
            <dd>Code (named by coordinator)</dd>

            <dt className="text-muted-foreground font-medium">Runs on</dt>
            <dd className="font-medium">Claude Code · Opus 5.5 · Standard</dd>

            <dt className="text-muted-foreground font-medium">Cost</dt>
            <dd>Subscription usage</dd>

            <dt className="text-muted-foreground font-medium">Why</dt>
            <dd>Complex (architecture &amp; distributed algorithms): Claude Code · Opus 5.5.</dd>

            <dt className="text-muted-foreground font-medium">Skipped in lane</dt>
            <dd className="text-amber-600 dark:text-amber-400">
              Copilot managed · Opus 5.5: monthly quota exhausted
            </dd>
          </dl>

          <div className="border-t border-border/60 pt-3 bg-muted/20 -mx-4 -mb-4 p-4 rounded-b-lg space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">
              Teach this project:
            </div>
            {chipFeedbackSaved ? (
              <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                ✓ Learned preference saved for this project!
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className="rounded border border-border/80 bg-background px-2 py-1 text-xs hover:bg-muted font-medium"
                  onClick={() => setChipFeedbackSaved(true)}
                >
                  Prefer this model
                </button>
                <button
                  type="button"
                  className="rounded border border-border/80 bg-background px-2 py-1 text-xs hover:bg-muted font-medium"
                  onClick={() => setChipFeedbackSaved(true)}
                >
                  Avoid this model
                </button>
                <button
                  type="button"
                  className="rounded border border-border/80 bg-background px-2 py-1 text-xs hover:bg-muted font-medium"
                  onClick={() => setChipFeedbackSaved(true)}
                >
                  Treat as Routine
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
