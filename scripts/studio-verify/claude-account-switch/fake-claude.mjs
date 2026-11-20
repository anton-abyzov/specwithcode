#!/usr/bin/env node
// Stand-in for the claude binary in a private test home: no model, no network,
// no token. It reads who is "signed in" the way Claude Code does, once when the
// process starts: a Console profile in the Anthropic profile folder outranks the
// claude.ai account recorded in `.claude.json`. A long-lived process keeps the
// account it started with, as a real `claude` keeps its token. Each reply names
// that account and this process, so a check can tell which sign-in served a turn.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
const home = process.env.HOME ?? "";
const readJson = (file) => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

function signedInAccount() {
  const profiles =
    process.env.ANTHROPIC_CONFIG_DIR ||
    NodePath.join(process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config"), "anthropic");
  const active = (() => {
    try {
      return NodeFS.readFileSync(NodePath.join(profiles, "active_config"), "utf8").trim();
    } catch {
      return "";
    }
  })();
  const profile = active
    ? readJson(NodePath.join(profiles, "configs", `${active}.json`))
    : undefined;
  if (profile) return { kind: "console", email: profile.email, organization: profile.organization };
  const configDir = process.env.CLAUDE_CONFIG_DIR || home;
  const account = readJson(NodePath.join(configDir, ".claude.json"))?.oauthAccount;
  if (!account?.emailAddress) return { kind: "signedOut" };
  return {
    kind: "claude.ai",
    email: account.emailAddress,
    organization: account.organizationName,
    plan: account.fixturePlan ?? "pro",
    fiveHour: account.fixtureFiveHourPercent ?? 10,
    sevenDay: account.fixtureSevenDayPercent ?? 20,
  };
}

const account = signedInAccount();
const print = (value) => process.stdout.write(`${value}\n`);

if (args.includes("--version")) {
  print("2.1.327 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (args.includes("--text")) {
    if (account.kind === "console") {
      print(`Profile: credentials-file · user_oauth · default`);
      print(`Email: ${account.email}`);
      print(`Organization: ${account.organization} · fixture-org`);
    } else if (account.kind === "claude.ai") {
      print(`Login method: Claude ${account.plan} account`);
      print(`Email: ${account.email}`);
    } else print("Not logged in");
    process.exit(0);
  }
  print(
    JSON.stringify(
      account.kind === "console"
        ? {
            loggedIn: true,
            authMethod: "oauth_token",
            apiProvider: "firstParty",
            email: account.email,
          }
        : account.kind === "claude.ai"
          ? {
              loggedIn: true,
              authMethod: "claude.ai",
              apiProvider: "firstParty",
              email: account.email,
              subscriptionType: account.plan,
            }
          : { loggedIn: false },
    ),
  );
  process.exit(account.kind === "signedOut" ? 1 : 0);
}
if (args[0] === "auth") process.exit(0);

const log = process.env.FAKE_CLAUDE_LOG;
// Flag names and the account kind only: values can carry headers and addresses.
if (log)
  NodeFS.appendFileSync(
    log,
    `${new Date().toISOString()} pid ${process.pid} ${account.kind} ${account.email ?? "-"} ${args
      .filter((arg) => arg.startsWith("--"))
      .join(" ")}\n`,
  );
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionId = NodeCrypto.randomUUID();
let initSent = false;
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
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
            account:
              account.kind === "claude.ai"
                ? {
                    email: account.email,
                    ...(account.organization ? { organization: account.organization } : {}),
                    subscriptionType: account.plan,
                    apiProvider: "firstParty",
                  }
                : { apiProvider: "firstParty" },
          }
        : subtype === "get_usage"
          ? account.kind === "claude.ai"
            ? {
                session: {},
                subscription_type: account.plan,
                rate_limits_available: true,
                rate_limits: {
                  five_hour: {
                    utilization: account.fiveHour,
                    resets_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
                  },
                  seven_day: {
                    utilization: account.sevenDay,
                    resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
                  },
                },
              }
            : { session: {}, rate_limits_available: false }
          : {};
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response },
    });
    return;
  }
  if (message.type !== "user") return;
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
      uuid: NodeCrypto.randomUUID(),
    });
  }
  const text = `Served by ${account.email ?? "nobody"} in claude process ${process.pid}.`;
  const base = { session_id: sessionId, parent_tool_use_id: null };
  send({
    ...base,
    type: "assistant",
    uuid: NodeCrypto.randomUUID(),
    message: {
      id: `msg_${NodeCrypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  send({
    ...base,
    type: "result",
    subtype: "success",
    uuid: NodeCrypto.randomUUID(),
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
});
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
