#!/usr/bin/env node
// Scripted stand-in for the claude binary on a private verification server.
// No model, no network: it answers the Agent SDK control protocol and replies to
// each user message with scripted text. A message containing [[stream:N:MS]]
// sends N paragraphs, one assistant event every MS milliseconds; otherwise it answers at once.
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.219 (Claude Code)\n");
  process.exit(0);
}
const log = process.env.FAKE_CLAUDE_LOG;
const note = (s) => log && NodeFS.appendFileSync(log, s.slice(0, 400) + "\n");
// Flag names only: values can carry headers such as the MCP config.
note(
  `argv ${process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .join(" ")}`,
);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionId = randomUUID();
let initSent = false;
let queue = Promise.resolve();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  note(`in ${message.type} ${message.request?.subtype ?? ""}`);
  if (message.type === "control_request") {
    const subtype = message.request?.subtype;
    const response =
      subtype === "initialize"
        ? {
            commands: [],
            agents: [],
            models: [],
            output_style: "default",
            available_output_styles: ["default"],
            account: {
              email: "fixture@example.invalid",
              subscriptionType: "pro",
              tokenSource: "oauth",
            },
          }
        : subtype === "get_usage"
          ? {
              session: {},
              subscription_type: "pro",
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 1, resets_at: null },
                seven_day: { utilization: 1, resets_at: null },
              },
            }
          : {};
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response },
    });
    return;
  }
  if (message.type !== "user") return;
  queue = queue.then(() => reply(line));
});
async function reply(raw) {
  if (!initSent) {
    initSent = true;
    send({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: process.cwd(),
      model: "claude-sonnet-5-5",
      tools: [],
      mcp_servers: [],
      permissionMode: "bypassPermissions",
      apiKeySource: "none",
      slash_commands: [],
      output_style: "default",
      uuid: randomUUID(),
    });
  }
  const stream = raw.match(/\[\[stream:(\d+):(\d+)\]\]/);
  // A streamed reply carries its stream tag, so each stream's paragraphs are unique.
  const tag = (raw.match(/Stream (S\d+)/) ?? [])[1];
  const label = (raw.match(/Question (\d+)/) ?? [])[1] ?? (stream ? `stream ${tag ?? "S0"}` : "x");
  const count = stream ? Number(stream[1]) : 3;
  const pace = stream ? Number(stream[2]) : 0;
  const paragraphs = Array.from(
    { length: count },
    (_, i) =>
      `Reply ${label} paragraph ${i + 1}. ${"The worker reported progress on this line. ".repeat(5)}`,
  );
  // Without --include-partial-messages Claude Code delivers each content block as
  // its own assistant event; a streamed reply arrives one paragraph at a time.
  const id = `msg_${randomUUID()}`;
  const base = { session_id: sessionId, parent_tool_use_id: null };
  const text = paragraphs.join("\n\n");
  for (const [i, p] of paragraphs.entries()) {
    if (pace && i) await sleep(pace);
    send({
      ...base,
      type: "assistant",
      uuid: randomUUID(),
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: p }],
        stop_reason: i === paragraphs.length - 1 ? "end_turn" : null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  }
  send({
    ...base,
    type: "result",
    subtype: "success",
    uuid: randomUUID(),
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 10,
    num_turns: 1,
    result: text,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
  });
}
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
