# Usage and limits

Open **Usage** from the account menu at the bottom of the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, and Cursor history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost, split by token type and by speed. These estimates are not your subscription bill.
**Premium** is what Fast and Ultrafast requests cost above standard rates. Cost that cannot be
split, such as a provider-reported cost for a model without public rates, shows as **Other**.
Select a model under **Breakdown** to see its trend, cache hit rate, and cost per million tokens.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including SpecWithCode-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on the
server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's dashboard API using the Cursor CLI login (`agent login`)
saved on the server. This includes headless SpecWithCode sessions and desktop usage across machines;
the same account counts once across connected environments. Without an accessible CLI login,
SpecWithCode shows a notice instead of incomplete local totals. Signing in to Cursor inside
SpecWithCode, or setting `CURSOR_API_KEY`, runs Cursor but does not feed this history. SpecWithCode does not estimate missing tokens from conversation text.
On macOS, choose **Enable Cursor usage** on Usage to allow SpecWithCode to read your existing CLI login
from Keychain. You can turn it off in **Settings → Providers → Usage providers**. macOS may ask
you to allow access on the server Mac.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Use absolute paths or `~/` paths in the account's environment settings; relative
environment paths depend on each project's working directory and cannot be reliably discovered
by Usage. Accounts sharing a history directory count once.

When your app and server support different providers, usage totals may cover only the providers
your app understands. Update the app to include newly supported providers.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing. When a model on **Usage** has no known price, select it under
**Breakdown** and choose **Set price** to open this table with that model added.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

To count one model as another, such as a preview model under its released name, enter the target
model ID under **Map to**. The mapped model no longer appears on **Usage**: its tokens and cost
move to the target model and use the target's price. Clear **Map to** or reset the row to show
the model on its own again.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude banked resets are not shown: reading them needs Claude Code's own sign-in token, which
Anthropic lets only Claude Code use, so redeem them in Claude Code. SpecWithCode reads Claude's
limits from Claude Code itself and never opens its Keychain item or `.credentials.json`. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. SpecWithCode cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Cursor reports
its allowance using the Cursor CLI login (`agent login`) or `CURSOR_AUTH_TOKEN`; signing in inside
SpecWithCode does not provide it. For an instance signed in inside SpecWithCode, limits appear only
when the CLI login is the same Cursor account. On macOS, the CLI login is read from Keychain once you
enable Cursor account usage. An explicit `CURSOR_API_KEY` does not report limits.
X Subscription accounts show one weekly **Included usage** bar; that Grok pool is shared with the
Grok apps and X. Earlier Cursor plans show monthly **Overall**, **Cursor Models** and **Other
Models** bars, and so does any account whose plan details Cursor does not return.
Keychain login is used for limits only with Cursor's default API endpoint. If you configure
a custom Cursor endpoint, use an explicit token or file-based CLI login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## When a provider runs out

When a turn stops on a usage limit, the banner above the composer counts down to the reset and
shows an **Auto-continue when the limit resets** checkbox. Tick it and the thread continues by itself
at the reset, even if the app restarted in between; the choice is saved per thread, for workers and
the coordinator alike. Claude threads get the reset from Claude's limit message (for example
"resets 5:20am (America/New_York)") when the CLI sends no reset event. Under the checkbox,
**Hand off now** offers **Continue with Codex** (or whichever provider is the fallback) and
**Continue on** another device of the project, for when waiting is not an option. Codex threads
also get **Check now**. Continuing hands the thread over with its context, in the
same worktree, and the stopped turn picks up where it left off. A thread the limit stopped on its
very first message has nothing to continue, so SpecWithCode sends that message again on the fallback. See
[Context in portable handoffs](portable-handoffs.md) for what the handoff carries. Switching back
works the same way from the model picker.

When another device has the same project and a provider there has room (its own account, below
**Switch before the limit**), the banner also offers **Continue on** that device. SpecWithCode starts a
new thread there with a written handoff: the thread's title, its branch, the first request and the
latest messages. The thread runs in a new worktree from the branch as pushed, so the other device's
own checkout is never switched; anything this device had not pushed stays behind. A device signed
in to the same full account is not offered, and a Claude instance billed per token never is.

The **When a provider runs out** rows under **Usage limits** in a project's settings (General tab)
set the rule for that project; the same rows under **Settings → General** set it for every project:

- **Switch automatically** (default): SpecWithCode continues a limited turn on the fallback without asking.
- **Offer the fallback**: the banner shows the continue action and nothing switches by itself.
- **Wait for the reset**: the banner keeps its resume actions only.

**Fallback model** picks the provider and model to continue on. Without one, SpecWithCode picks another
signed-in provider that is not full. A thread already running on the fallback goes back to the
project's recommended model. A Claude instance billed per token (its own API key, a token for another
endpoint, or Amazon Bedrock) is never picked as "another signed-in provider", because its turns
cost money: it
takes a thread only as the **Fallback model** you chose, as the project's recommended model, or through
**Use API credits first**.

A thread on its fallback names the model it runs on, then a small amber fallback mark, in the
thread list, the thread header and the model picker. The mark takes no words; hover over it (or,
in the thread header and the model picker, focus it with the keyboard) to see that the model is a
fallback, the model it stands in for, why it switched and how to switch back. On a narrow line the
provider's name goes first (its icon stays), before the PR and plan chips lose their room. On the
narrowest lines those chips can still wrap away (in the thread header they then leave the Tab
order too), and the running model's name stays whole, except beside the longest status, "Approval
requested", in a pane about 320 px wide, where it shortens. A screen reader always hears the
running provider, the model and the pick it stands in for.

In a project, a thread the coordinator starts runs on the project's **Recommended model for
threads** while that provider has room. When it has none (it is past **Switch before the limit** or
refuses new usage), the thread starts on the same model from another provider that serves it, in
the order set under **Also served by**: Claude Opus 5.5 on a Claude subscription, then Claude Opus
5.5 on GitHub Copilot, for example. Without another provider for the model, it starts on the model
the coordinator itself runs on, since the coordinator is using it right now, and failing that on
another signed-in provider with room. **Wait for the reset**, or a reset within **Wait when the
reset is close**, keeps the recommended model. A thread or the coordinator that stops on the limit
moves the same way, first to the same model elsewhere. Threads run on the coordinator's machine
unless the project's **Worker machine** names another one; a limit never moves them to another
machine by itself.

A provider that reports no usage (Copilot and the other agents set up under
[ACP providers](providers-acp.md)) counts as having room while it is signed in and ready, until a
turn on it stops on a limit; SpecWithCode then leaves it alone until that limit resets, or for five
hours when the stop named no reset time.

An ACP agent whose billing SpecWithCode cannot tell takes over only when you named it: in the
fallback order, as the project's recommended model or under **Also served by**. Advertising
the same model is not enough, and a coordinator running on such an agent does not approve it for
its workers. A verified GitHub Copilot instance keeps its subscription fallback. To keep a provider
out of every fallback, disable that provider instance in Settings; that holds even when an older
fallback order or project default still names it.

**Switch before the limit** (default 95%) is the share of the provider's fullest usage window at
which the thread moves on. With **Switch automatically**, an idle thread moves to the fallback
before its next turn. It never switches mid-turn, moves a thread once per usage window, and only to
a provider below the same share, so two full providers never trade a thread back and forth. If you
switch back by hand, SpecWithCode keeps your choice until the window resets. With **Offer the fallback**,
the thread suggests the switch above the composer at that share instead (**Switch to Codex** or
**Not now**, once per usage window).

**Wait when the reset is close** (default under 30 min) keeps a thread where it is when the usage
that is full resets soon: finishing on the same provider after a short wait beats moving the work.
When every window at or past the threshold resets within that time, nothing switches early, the
suggestion stays hidden, and a turn that stops on the limit is not switched, redeemed or paid for.
The banner says the thread waits, and SpecWithCode resumes it at the reset even where auto-resume is
off. If the thread is still stopped 10 minutes after the reset, the rule acts as usual. A window
without a reset time, or a full weekly window next to a nearly reset session one, counts as far
off. **Never wait** turns this off.

Three more rows run before any fallback, under **Offer the fallback** and **Switch automatically**
alike (never under **Wait for the reset**), and all are off until you turn them on:

- **Redeem a banked reset first**: when a turn stops on the limit and the account holds a banked
  reset (Codex's own reset grants, the ones **Use reset** redeems by hand), SpecWithCode
  redeems one and continues the stopped turn on the same provider. Turning it on asks you to
  confirm, because a redeemed reset is gone. Before redeeming, SpecWithCode re-reads the account's usage
  and redeems only when that fresh read shows a window at its limit (a stopped turn alone is not
  proof); it redeems at most once per limit window, and never while `STUDIO_SIMULATE_USAGE_LIMIT`
  is set. If the limit is still there afterwards, the fallback rule takes over on the next sweep.
- **Spend Codex credits first**: when a Codex turn stops on the plan limit and the account holds
  paid credits (**Credits** on ChatGPT's usage page), SpecWithCode continues that turn on credits. Turning
  it on asks you to confirm, because credits cost money. The continuation is the same one-request
  permission as **Send using credits** in the composer: Codex re-reads the account before the turn
  and refuses if the account, model or balance changed. SpecWithCode never buys credits and never touches
  ChatGPT's **Automatic reload** setting. Claude's pay-as-you-go extra usage is a ChatGPT-style
  billing setting on the Claude side with no CLI switch; the Claude equivalent is the next row.
- **Use API credits first**: when a Claude subscription turn stops on the limit, SpecWithCode continues
  that turn on a Claude instance that has its own Anthropic API key, so it is billed to that key's
  API organization (for example the monthly API credits a Max plan includes once an API
  organization is linked). It runs after a banked reset and before any fallback. The thread stays
  on Claude and on the same model, and resumes the same Claude session: with one config home the
  session is resumed in place, with two it is copied across as in
  [Two Claude accounts](portable-handoffs.md#two-claude-accounts). Turning it on asks you to
  confirm, because API usage costs money, and the row names the instance it will use.

  SpecWithCode moves a turn only when all of this holds: the stop is current (its reset time is still
  ahead, or, when Claude named none, it happened in the last five hours) and happened on the
  subscription the thread is on, the thread is not snoozed, the stop was not a simulated one, the
  API-key instance lists the thread's model, and a usage read taken at that moment, past the cache,
  shows the subscription at its limit. With **Snooze limited threads** on, every stop is snoozed
  until its reset, so there a snooze until the reset does not hold the turn back; snooze the
  thread to another time, or turn this row off, to keep it waiting. A usage read that fails moves
  nothing; SpecWithCode tries it again on the next two sweeps and then leaves that stop alone. A banked
  reset is tried the same way before any API credit is spent. A stop on a limit the usage read
  does not show as full (some per-model weekly limits, or a window read just under 100%) is not
  confirmed, so that turn stays stopped and you continue it yourself. Just before it moves the turn, SpecWithCode looks at
  the thread again, so one you snoozed, settled or moved in the meantime stays put. It never moves
  while `STUDIO_SIMULATE_USAGE_LIMIT` is set.

  A moved thread stays on the API-key instance, and its later turns are billed there, until the
  limit that stopped it resets; then, while idle, it goes back to the subscription before its next
  turn. It also goes back as soon as the subscription's usage read shows no limit, after 15 idle
  minutes when Claude named no reset time, and at once when you turn the row off. It does not move
  while it is working, while its session still hosts background work, or while a message is queued
  for it. A thread you moved to the
  API-key instance yourself stays there, and so does one you move back there after SpecWithCode
  returned it. Two limits remain: a thread you settled while it was on the API-key instance goes
  back only after its next turn, and a thread or scheduled task started from a moved thread
  starts on the API-key instance and stays there until you change its model. SpecWithCode cannot read
  or cap the API organization's balance: set a spend limit in the Claude Console.

  To set it up, link the API organization and create a key in the Claude Console, then add a
  second Claude instance under **Settings → Providers** with an environment variable named
  `ANTHROPIC_API_KEY`, marked sensitive, holding the key, and no custom endpoint
  (`ANTHROPIC_BASE_URL`) or other token. Leave its config home empty to share sessions with your
  subscription instance. SpecWithCode keeps the value in its server secret store, not in the settings
  file. An instance that reaches Claude through a router or proxy token is never used by this
  row. **Add an API key** on the row (or in the limit banner) does all of that in one step: paste
  the key, optionally name the account, and SpecWithCode adds the instance. A key that is not
  scoped to a workspace (a Claude Console user key, `sk-ant-usr…`) is refused with "This API key
  is not scoped to a workspace" unless each request names one: fill in **Workspace ID**
  (`wrkspc_…`, from Settings → Workspaces in the Claude Console) and the app sends it with
  `ANTHROPIC_CUSTOM_HEADERS`.

  With several API accounts (for example hackathon credits on more than one organization), add
  one instance per key. When an account runs out of credits, Claude answers "Credit balance too
  low"; SpecWithCode stops that turn like a usage limit (the banner reads **API credits used up**)
  and, with this row on, continues it on the next API-key instance that lists the thread's model,
  without a usage read, since an API key has none. The way back still leads to the subscription
  the first move came from.

### Continue on API credits by hand

The limit banner offers your API accounts without any rule: when a turn stops on the limit and
another instance of the same provider bills an API account and lists the thread's model, the
banner shows **Continue on API credits** (one account) or **Continue on** each account by name.
One click moves the thread there and continues the stopped turn on the same model; nothing is
bought, and that account's credits pay per token. This works for Claude (an instance with its own
`ANTHROPIC_API_KEY`), Grok (an instance with `XAI_API_KEY`, billed to the xAI team's credits
instead of a SuperGrok plan) and Codex signed in with an OpenAI API key (billed to the OpenAI
platform's credits; ChatGPT plan credits keep **Continue using credits**). A thread already on an
API account that ran out of credits is offered the other accounts. When no API account exists yet,
the banner offers **Add an API key** for Claude and Grok. A thread you move this way stays on the
API account until you pick another model; only threads the **Use API credits first** rule moved go
back by themselves.

The composer's model picker follows an automatic switch, so the next message goes to the provider
the thread now runs on. The thread keeps its permission mode: in **Supervised**, Codex runs in its
read-only sandbox and asks before writing, so a continued turn that must edit files needs the
thread in **Auto-accept edits** or above, as it would on Codex from the start.

SpecWithCode sets `SPECWEAVE_STUDIO_THREAD_ID` for Claude and Codex turns. SpecWeave's
`auto-handoff` hooks see it and only write local checkpoints inside SpecWithCode (the latest one for a
thread at `~/.specweave/checkpoints/studio/<thread>.json`); SpecWithCode itself decides when to switch,
so the CLI and SpecWithCode never both hand off the same turn. When the thread moves to another
provider, the handoff starts with that checkpoint note (the increment, the task, what to do next
and where the diff is), ahead of the conversation history, as long as it belongs to the thread's
worktree and fits in the handoff budget.

To try this without spending an allowance, start the server with
`STUDIO_SIMULATE_USAGE_LIMIT=claudeAgent` (a comma-separated list of provider instance ids). Every
turn on a listed instance then stops before it reaches the provider with a usage-limit error that
resets in an hour. Use it only in a test home.

## Connect a CLIProxyAPI hub

To see Codex accounts pooled in a hub, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The Codex accounts appear under **Usage → Limits** with their banked reset credits; select an
account and choose **Use reset** to redeem one. They also show their paid credit balance. Claude
accounts in a hub are skipped and never sent a request: Anthropic does not let other apps use or
relay Claude.ai sign-ins ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). No hub plugin is required.

### A hub on the same machine

When CLIProxyAPI is installed on the machine an environment runs on, **Usage providers** lists it as
**CLI Proxy found on** that environment, with its loopback address and whether it is running. SpecWithCode
looks in `~/.local/share/specweave/proxy`, `~/.cli-proxy-api` and Homebrew's `etc` folder, and reads
the port from the hub's own config.

- **Add this hub** appears when the install keeps its management key in a file next to it. The
  server reads the key itself and stores it in its secret store; the key never reaches the browser.
- **Add with key** appears otherwise. It opens the usual dialog with the address filled in, and you
  paste the key.

A hub you already added is not offered again. Its row says **Not running** while the hub is stopped.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

The management key is the most powerful secret in this setup. CLIProxyAPI's `api-call` management
endpoint makes requests with any pooled account's OAuth token, so whoever holds the key can use
every account on the hub. SpecWithCode keeps the key in its secret store and never sends it to a browser.
It also protects the key in two ways:

- SpecWithCode sends the key only over https, loopback (`127.0.0.1`, `localhost`, `[::1]`) or a Tailscale
  address (`*.ts.net`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`). A plain-http LAN address is refused.
- Changing the hub's URL to a different origin discards the saved key. Enter it again for the new
  hub.

Keep the hub itself private: bind CLIProxyAPI to `127.0.0.1`, leave remote management off, and use
a long random management key and client API keys. Read
[SpecWithCode security boundaries](../studio/security.md) before you route subscription accounts through
a hub.

## Usage in a project

Under a project's message box, a small chip shows one ring per provider with the window that has
the least left, such as `Claude 58% left` and `Codex 90% left`. It turns amber at 20% left and red
at 5% left. Select it to see every window with its reset time, each pooled account, and banked resets.
From there, open **Usage → Limits** or the project's own token usage. Banked resets are shown but not
spent here; use one from Limits. The chip reads what Limits
already holds, so opening it never asks a provider for anything. The same breakdown heads the
project's **Usage** tab.

## Usage in the model picker

In a chat, the model button shows what is left for the selected model: a ring and `62%`, or `Limit`
when its limit is reached. On a narrow window only the ring shows; hover or focus the button to read
the full sentence. Open the picker to see every model with its room after the provider name, and
select a provider on the left to see its windows on this machine, with the ones every model shares
listed before the ones that cap a single model family (`Weekly · Fable`).

A model is greyed out only when a fresh read (under 15 minutes old) shows a limit it uses is spent,
or the provider itself refuses new turns. The row says which limit and when it resets, and its
shortcut keeps its number but does nothing. A limit on one family (Fable) leaves the other Claude
models selectable, and Claude through GitHub Copilot is a separate account, so it stays selectable
when your Claude subscription is out. Anything the app can't vouch for stays selectable and says so:
`Checking usage…`, `Usage unknown`, an old read (`~46%`, `Limit?`), a limit that has reset since it
was read, an offline machine, a provider that doesn't report usage, or a sign-in billed per token.

While a turn runs, the picker names the model it runs on; a new pick applies from your next message.
A model that ran out while selected stays selected; what your next message does follows
[When a provider runs out](#when-a-provider-runs-out).

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while SpecWithCode is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen SpecWithCode to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.

### Included limit reached, but credits remain

The included weekly allowance and your paid Codex credits are separate. A full
allowance does not mean your credit balance is empty. The stopped chat's recovery
card shows the reported balance and **Continue using credits** for eligible Codex
accounts. Click it to submit one continuation on that chat's current model using
existing credits. It does not purchase credits, change automatic reload, or enable
future automatic spending. Requests that received no provider answer resend their
original prompt and attachments; existing conversations continue in context.

If the action is disabled, refresh the selected account under **Settings → Providers**
and return to the chat. The account, model, route and credit observation must still
match; a stale balance is not spending permission. A provider rejection remains
visible even when credits are reported. **Check now** checks included usage; it does
not authorize paid continuation. For automatic recovery, explicitly enable
**Spend Codex credits first** in the provider fallback settings.

Once a later run starts successfully or completes, the earlier timeline warning
reads **Usage limit resolved — chat continued** in muted text. This records chat
recovery, including switching providers; it does not claim the original provider's
weekly allowance has reset. Merely submitting or queueing a request is insufficient.
