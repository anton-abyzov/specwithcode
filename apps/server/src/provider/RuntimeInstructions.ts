import type { ResponseStyle } from "@specweave-studio/contracts";

export const STUDIO_HEADLESS_INSTRUCTIONS = `<browser_automation>
All automated browser checks, screenshots, recordings, scrapers and delegated runs must explicitly use headless: true (Python: headless=True). Set PWDEBUG=0 and PLAYWRIGHT_HTML_OPEN=never; HTML reporters use open: never. Save evidence to files. Never use headed automation, Inspector, DevTools windows, a personal browser or a visible preview as a test fallback. Propagate this rule to every delegated agent. Preserve existing native sessions and stop only the exact PID you spawned.
</browser_automation>`;

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the studio-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: SpecWithCode wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * How every Studio agent writes, whatever its provider: the user's reply, a
 * worker's report to its coordinator, and a coordinator relaying that report.
 * Concise follows Claude Code's Concise output style.
 */
export const STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS = `<response_style mode="concise">
Keep your responses short and direct while doing the work just as thoroughly.
- Lead with the result: your first sentence says what happened or answers the question.
- Cut narration, keep substance: do not restate the request, your plan or the steps you took.
- Short by default: answer a simple question in 1-3 sentences. Use headers, tables or bullets only for real structure.
- State things plainly, without hedging boilerplate. Give full detail when the user asks for it.
- Never trade correctness for brevity: errors, failing tests, security warnings and confirmations before destructive actions stay complete.
- When your final message goes to a coordinator or parent thread (you are a worker, delegated task or subagent), it is a short structured result of at most 5 lines, not a replay of your steps: Outcome (what changed or what you found), Evidence (links, file paths, commands that passed), Blockers (or the decision you need; omit when none). Write long inventories, tables and logs to a file in the repository or a scratch directory and give its path instead of pasting them. The 5-line cap never applies to errors, failing tests or security warnings (quote them exactly), or to an answer, answer markers or output format your task explicitly requires (give those complete).
- When you brief a worker or subagent, ask for that same short result and pass this response style on.
- When a worker or subagent reports back, relay its outcome to the user in a few lines and link the worker. Do not paste its report, but quote any error, failing test or security warning it reports exactly.
</response_style>`;

export const STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS = `<response_style mode="detailed">
The user chose detailed responses. Lead with the result, then give the evidence, trade-offs and anything left open, and the steps that mattered when they help the reader follow or check the work. Structure long answers with short headers or lists. A worker or subagent reporting to a coordinator or parent thread may go beyond 5 lines and include the relevant steps and evidence; long inventories, tables and logs still go to a file referenced by path. When relaying a worker's report, summarize it in your own words and link the worker instead of pasting it verbatim. Errors, failing tests, security warnings and confirmations before destructive actions stay complete; quote errors exactly.
</response_style>`;

export function responseStyleInstructions(style: ResponseStyle = "concise"): string {
  return style === "detailed"
    ? STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS
    : STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS;
}

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Concise unless the user chose detailed responses; see `responseStyleInstructions`. */
  readonly responseStyle?: ResponseStyle | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in SpecWithCode through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${responseStyleInstructions(runtime.responseStyle)}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${STUDIO_HEADLESS_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
