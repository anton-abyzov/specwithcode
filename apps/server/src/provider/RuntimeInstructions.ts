import type { ResponseStyle } from "@specweave-studio/contracts";

/**
 * Set on every provider process SpecWithCode starts, so Playwright stays out of
 * its debugger and never opens an HTML report window whatever the agent runs.
 * Cursor's SDK runs inside the server process and Managed Agents run remotely,
 * so neither has a child environment to set. The prose below covers what an
 * environment variable cannot.
 */
export const HEADLESS_BROWSER_ENVIRONMENT = {
  PWDEBUG: "0",
  PLAYWRIGHT_HTML_OPEN: "never",
} as const;

/**
 * `environment` with HEADLESS_BROWSER_ENVIRONMENT applied last, so an inherited
 * or provider-supplied value cannot turn it off. Every provider spawn site uses
 * this; providerSpawnSites.test.ts checks it.
 */
export function withHeadlessBrowserEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return { ...environment, ...HEADLESS_BROWSER_ENVIRONMENT };
}

/**
 * Child-process `env`/`extendEnv` options with the headless variables applied.
 * Without an explicit environment the child inherits the server's, so the
 * variables extend it rather than replace it.
 */
export function headlessChildProcessEnvironment(options: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
}): { readonly env: NodeJS.ProcessEnv; readonly extendEnv: boolean } {
  return options.env === undefined
    ? { env: { ...HEADLESS_BROWSER_ENVIRONMENT }, extendEnv: true }
    : { env: withHeadlessBrowserEnvironment(options.env), extendEnv: options.extendEnv ?? false };
}

export const STUDIO_HEADLESS_INSTRUCTIONS = `<browser_automation>
Run every automated browser check, screenshot, recording and scraper headless (headless: true; Python headless=True) and save evidence to files. Never fall back to a visible browser, Inspector, DevTools or the user's own browser without the user's approval. Stop only processes you started, by PID. Pass this rule to agents you delegate to.
</browser_automation>`;

/**
 * The thread's own branch pull request is detected by ThreadPullRequestService,
 * so only pull requests the server cannot see need the tool.
 */
const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_requests>
SpecWithCode tracks the pull request for this thread's own branch by itself. Register any other pull request you open or work on (each stack layer, another repository) with link_pull_request when that tool is available. To monitor one, call watch_pull_request and end your turn instead of polling; call unwatch_pull_request before handing the work back.
</pull_requests>`;

export const STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS = `<output_formatting>
Write dates in prose with the month name, day and year (October 17, 2026), not ISO timestamps, and give times in the user's timezone when known, otherwise the source's; never guess one. Leave code, commands, paths, URLs, identifiers, data and quoted errors exactly as they are.
</output_formatting>`;

/**
 * Plain-prose rules for both response styles, adapted from a subset of unslop
 * by Lauren Tan (pstack, MIT) plus the "what makes this look machine-generated?"
 * self-check from its earlier versions. See third-party-licenses.config.json.
 * Every agent receives this on every turn, so keep it short;
 * RuntimeInstructions.test.ts caps its length.
 */
export const STUDIO_WRITING_INSTRUCTIONS = `<writing>
- Take a position and say why; hedge only real uncertainty.
- Be specific: a number, file or command, not an adverb.
- Cut puffery, praise, closing offers, chatbot phrases ("Certainly!") and stock -ing tails ("ensuring...").
- Avoid em dashes; use a period or comma. Concise means fewer sentences, not dropped articles or verbs.
- Before sending, ask what makes this look machine-generated, and fix it.
</writing>`;

/** Shared by both styles: the app reads `**Blockers:**` to mark a thread Blocked. */
const REPORT_RULES =
  "When you are blocked, end with a paragraph opening **Blockers:** that asks the one question, with the options and your recommendation. Put long inventories, tables and logs in a file and give its full path. Never shorten errors, failing tests, security warnings or confirmations before destructive actions; quote errors exactly.";

/**
 * How every SpecWithCode agent writes, whatever its provider: the user's reply,
 * a worker's report to its coordinator, and the briefs it writes. Concise
 * follows Claude Code's Concise output style. Include the shared writing and
 * formatting blocks in both constants: Pi embeds these directly.
 */
export const STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS = `<response_style mode="concise">
- Lead with the result. Skip narration, restating the request and closing recaps.
- Answer a simple question in 1-3 sentences; use headers, tables or bullets only for real structure. Give full detail when asked.
- Reporting to a coordinator or parent thread, give a plain 1-3 line result with the path or link that proves it; use labeled paragraphs (**Outcome:**, **Evidence:**, **Blockers:**) only when the result needs them.
- ${REPORT_RULES}
- Ask workers and subagents you brief to report the same way.
</response_style>\n\n${STUDIO_WRITING_INSTRUCTIONS}\n\n${STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS}`;

export const STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS = `<response_style mode="detailed">
- Lead with the result, then the evidence, trade-offs, open questions and the steps that help the reader check the work. Structure long answers with short headers or lists.
- Reporting to a coordinator or parent thread, write the result as paragraphs that open with bold labels (**Outcome:**, **Evidence:**, **Blockers:**); **Blockers:** is none or the one question the user must answer.
- ${REPORT_RULES}
- Ask workers and subagents you brief to report the same way.
</response_style>\n\n${STUDIO_WRITING_INSTRUCTIONS}\n\n${STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS}`;

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
  /**
   * Settings > Agents instructions, already resolved for the project. Claude
   * receives them through its own system-prompt append, so it leaves this out.
   */
  readonly agentInstructions?: string | undefined;
}): string {
  const agentInstructions = runtime.agentInstructions?.trim() ?? "";
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const agentBlock =
    agentInstructions.length === 0
      ? ""
      : `<agent_instructions>\n${agentInstructions}\n</agent_instructions>\n\n`;
  return `${agentBlock}<runtime_info>You are running in SpecWithCode through the ${harness} harness${modelInfo}${effortInfo}; mention it only if asked. Embed images and videos with Markdown and absolute file paths.</runtime_info>\n\n${responseStyleInstructions(runtime.responseStyle)}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${STUDIO_HEADLESS_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
