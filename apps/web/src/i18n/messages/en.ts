/**
 * English source strings. Every other catalog must translate every key here
 * (the `Messages` type enforces it). `{name}` marks a value; a plural message
 * picks its form from `{count}` with the language's own plural rules.
 */

export type PluralMessage = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & {
  readonly other: string;
};
export type Message = string | PluralMessage;

export const en = {
  // ── Language setting ──────────────────────────────────────
  /** Between two sentences of one message; Chinese full stops need no space. */
  "common.sentenceSpace": " ",
  "settings.language.title": "Language",
  "settings.language.description":
    "The language of SpecWithCode on this device. Some screens are still in English.",
  "settings.language.system": "System ({language})",

  // ── First-run wizard ──────────────────────────────────────
  "wizard.title": "Set up SpecWithCode",
  "wizard.stage.connect": "Computers",
  "wizard.stage.agents": "Agents",
  "wizard.stage.projects": "Projects",
  "wizard.close": "Close setup",
  "wizard.noun.mac": "Mac",
  "wizard.noun.machine": "machine",
  "wizard.computer": "Computer",
  "wizard.continue": "Continue",
  "wizard.back": "Back",
  "wizard.retry": "Retry",
  "wizard.closeTerminal": "Close",
  "wizard.toast.settingsNotSaved": "Your settings could not be saved. Try again.",
  "wizard.toast.historyNotImported": "Some history was not imported",
  "wizard.toast.imported": { one: "Imported {count} thread", other: "Imported {count} threads" },
  "wizard.toast.finishFailed": "Could not finish setup",

  "wizard.connection.title": "Connect your computers",
  "wizard.connection.description":
    "Agents run on the computers you choose here, so pick each one you want to work on.",
  "wizard.connection.legend": "Computers to set up",
  "wizard.connection.connected": "Connected",
  "wizard.connection.connecting": "Connecting…",
  "wizard.connection.addComputer": "Add a computer",
  "wizard.connection.telemetry":
    "Usage telemetry is off by default. SpecWithCode sends no product usage data unless you turn it on in the server's environment.",
  "wizard.connect.loadingSignIn": "Loading sign-in…",
  "wizard.connect.signIn": "Sign in",
  "wizard.connect.loadingComputers": "Loading computers…",
  "wizard.connect.noComputers": "No computers linked yet.",
  "wizard.connect.runThis":
    "Run this on each computer you want to connect. It makes the computer reachable from your other devices, with no Tailscale or port forwarding.",
  "wizard.connect.keepRunning":
    "Keep SpecWithCode running. Select the computers you want to set up above.",

  "wizard.pairing.failed": "Pairing failed.",
  "wizard.pairing.label": "Pairing link",
  "wizard.pairing.need": "Need a pairing link?",
  "wizard.pairing.pairing": "Pairing...",
  "wizard.pairing.pair": "Pair",
  "wizard.pairing.runThis": "Run this on the computer with your code.",
  "wizard.pairing.startFirst":
    "Start SpecWithCode first, or run {serve}. Add {tailscale} to use your tailnet.",

  "wizard.agents.title": "Connect your agents",
  "wizard.agents.description":
    "An agent writes the code, so at least one has to be signed in before your first chat. Cursor, OpenCode, Grok and others can be added after setup in Settings > Providers.",
  "wizard.agents.noTerminal": "This connection cannot control terminals.",
  "wizard.agents.anotherChatGpt": "Connect another ChatGPT account",
  "wizard.agents.readyToCode": "Ready to code.",
  "wizard.agents.ready": "Ready",
  "wizard.agents.checking": "Checking...",
  "wizard.agents.disabled": "Disabled",
  "wizard.agents.signIn": "Sign in",
  "wizard.agents.install": "Install",
  "wizard.terminal.runCommand": "Run {command} in this terminal.",
  "wizard.terminal.review": "Review the command, then press Enter to run it.",
  "wizard.terminal.openFailed": "Could not open the setup terminal.",
  "wizard.terminal.preparing": "Preparing command...",
  "wizard.terminal.label": "Install {driver}",

  "wizard.import.noPermission": "This connection cannot import projects or thread history.",
  "wizard.import.scanLimit": "Scan limit reached. Some projects or conversations may be missing.",
  "wizard.import.importedThreads": {
    one: "Imported {count} thread.",
    other: "Imported {count} threads.",
  },
  "wizard.import.skippedThreads": {
    one: "{count} thread could not be imported.",
    other: "{count} threads could not be imported.",
  },
  "wizard.import.someHistoryFailed": "Some thread history could not be imported.",
  "wizard.import.historyFailed": "Could not import thread history.",
  "wizard.import.yourProjects": "Your projects",
  "wizard.import.lookingInAgents": "Looking for projects from Claude Code and Codex…",
  "wizard.import.skip": "Do not import projects",
  "wizard.import.title": "Choose your projects",
  "wizard.import.description":
    "A project is a folder your agents work in, so choose the ones to bring in along with their conversations.",
  "wizard.import.selectedCount": "{selected} of {total} selected",
  "wizard.import.selectAll": "Select all",
  "wizard.import.selectNone": "Select none",
  "wizard.import.looking": "Looking for projects…",
  "wizard.import.checkFailed": "Could not check projects. {error}",
  "wizard.import.none": "No existing Claude Code or Codex projects found.",
  "wizard.import.importing": "Importing…",
  "wizard.import.importButton": { one: "Import {count} project", other: "Import {count} projects" },
  "wizard.import.otherFolders": "Other folders",
  "wizard.import.folderCount": { one: "{count} folder", other: "{count} folders" },
  "wizard.import.now": "now",

  // ── App update during setup ───────────────────────────────
  "update.downloadFailed": "Could not download update",
  "update.startFailed": "Could not start update download",
  "update.unexpected": "An unexpected error occurred.",
  "update.downloaded": "Update downloaded",
  "update.quitReopen": "Quit and reopen SpecWithCode to install it.",
  "update.productVersion": "SpecWithCode {version}",
  "update.productNewer": "A newer SpecWithCode",
  "update.available": "{product} is available. Update before you set up.",
  "update.downloading": "Downloading the update…",
  "update.downloadingPercent": "Downloading the update ({percent}%)…",
  "update.lastFailed": "The last install failed: {reason}",
  "update.ready": "{product} is ready to install.",
  "update.aria": "App update",
  "update.download": "Download update",
  "update.checking": "Checking…",
  "update.retry": "Retry update",
  "update.restart": "Restart to update",

  // ── Usage limit banner ────────────────────────────────────
  "limit.unavailable.missing": "not on this machine",
  "limit.unavailable.limited": "at its limit",
  "limit.unavailable.signedOut": "signed out",
  "limit.unavailable.perToken": "billed per token",
  "limit.unavailable.full": "full",
  "limit.unavailable.fullUntil": "full until {time}",
  "limit.unavailable.tooSmall": "context window too small",
  "limit.unavailable.unverified": "no recent usage reading",
  "limit.unavailable.providerWarning": "provider warning",
  "limit.unavailable.notReady": "not set up on this machine",
  "limit.unavailable.excluded": "excluded from automatic fallback",
  "limit.duration.minutes": "{count} min",
  "limit.duration.hours": "{count} h",
  "limit.duration.hoursMinutes": "{hours} h {minutes} min",
  "limit.duration.days": { other: "{count} days" },
  "limit.sentenceJoin": ". ",
  "limit.reset.unavailable": "Reset time unavailable",
  "limit.reset.in": "Resets in {duration} ({clock})",
  "limit.reset.at": "Reset at {clock}",
  "limit.next.waiting":
    "The reset is close, so this thread waits and resumes here instead of switching.",
  "limit.next.resumingNow": "Resuming here now that the limit has reset.",
  "limit.next.continuesAtReset": "This thread continues by itself at the reset.",
  "limit.next.continuingNow": "Continuing now that the limit has reset.",
  "limit.next.byRule": "Continuing with {label} by project rule.",
  "limit.title.credits": "API credits used up",
  "limit.title.included": "Included usage limit reached",
  "limit.title.usage": "Usage limit reached",
  "limit.creditsExhausted":
    "This API account has no credits left. Add funds to it, or continue on another account.",
  "limit.error.continueOn": "Could not continue on {label}.",
  "limit.error.resetPassed": "The reset time has passed. Retry the thread manually.",
  "limit.error.recovery": "Could not change limit recovery.",
  "limit.error.project": "Could not change the project setting.",
  "limit.auto.savedHint":
    "Saved for this thread. SpecWithCode continues the stopped turn by itself, even after a restart.",
  "limit.auto.whenUsage": "Auto-continue when usage is available",
  "limit.auto.whenReset": "Auto-continue when the limit resets",
  "limit.saving": "Saving...",
  "limit.project.global": "On for every project in Settings.",
  "limit.project.hint": "Also continues this project's threads already waiting on a limit.",
  "limit.project.label": "Auto-continue this project's threads when limits reset",
  "limit.noReset.withHandoffs":
    "The provider did not say when this limit resets, so the thread cannot continue by itself. Switch to another model or machine now, or send a message after the reset.",
  "limit.noReset":
    "The provider did not say when this limit resets, so the thread cannot continue by itself. Send a message after the reset.",
  "limit.orElsewhere": "Or switch to another model or machine now:",
  "limit.insteadOfWaiting": "Switch to another model or machine instead of waiting:",
  "limit.fallback.hint":
    "Switch this thread to {label} ({model}) and continue the stopped turn with its conversation",
  "limit.fallback.continueWith": "Continue with {label} · {model}",
  "limit.otherModelsAria": "Other fallback models",
  "limit.otherModels": "Other models",
  "limit.chooseModel": "Choose a model",
  "limit.device.hint":
    "Start a thread on {label} ({model}) with a written summary of this conversation. Changes not pushed from this device do not go with it.",
  "limit.device.fresh": "Start fresh on {label} (summary only)",
  "limit.device.continue": "Continue on {label}",
  "limit.checkRequested": "Check requested",
  "limit.checkNow": "Check now",
  "limit.snooze": "Snooze until reset",
  "limit.check.allowedOn": "Last check allowed ordinary usage; auto-continue is on.",
  "limit.check.allowedOff": "Last check allowed ordinary usage. Tick Auto-continue to continue.",
  "limit.check.denied": "This profile still denies ordinary usage.",
  "limit.check.changed": "The account or profile changed. Automatic recovery is blocked.",
  "limit.check.reconfirm":
    "Check now, then untick and tick Auto-continue again to confirm the current profile.",
  "limit.check.unverified":
    "Ordinary usage permission could not be verified. The thread remains stopped.",
  "limit.approaching.title": "{provider} has {percent}% of its usage left",
  "limit.approaching.question": "Switch this thread to {label} before the limit stops a turn?",
  "limit.approaching.switch": "Switch to {label}",
  "limit.approaching.notNow": "Not now",
  "limit.preswitch.blocked":
    "{model} neared its usage limit, so this thread moved before its next turn. It stays on the fallback: {reason}.",
  "limit.preswitch.hasRoom":
    "{model} neared its usage limit and has room again. The idle thread goes back on its own.",
  "limit.preswitch.noRoom":
    "{model} neared its usage limit. The idle thread goes back on its own once it has room.",

  // ── Fallback order and options ────────────────────────────
  "fallback.chip.ready": "Ready",
  "fallback.chip.unverified": "Usage unknown",
  "fallback.chip.full": "Usage full",
  "fallback.chip.fullUntil": "Full until {time}",
  "fallback.chip.limited": "At its limit",
  "fallback.chip.signedOut": "Signed out",
  "fallback.chip.perToken": "Billed per token",
  "fallback.chip.tooSmall": "Context too small",
  "fallback.chip.notReady": "Not set up",
  "fallback.chip.missing": "Not on this machine",
  "fallback.chip.excluded": "Excluded",
  "fallback.chip.unknownBilling": "Billing unknown",
  "fallback.family": "{family} family",
  "fallback.moveUp": "Move {label} up",
  "fallback.moveDown": "Move {label} down",
  "fallback.remove": "Remove {label}",
  "fallback.sameModelAria": "Same model on other providers, after {label}",
  "fallback.sameModelOn": "Same model on {provider}",
  "fallback.orderLabel": "Fallback order",
  "fallback.status.ready": "Can take a limited thread",
  "fallback.status.unverified": "Signed in, no recent usage reading",
  "fallback.status.current": "This thread's model",
  "fallback.status.excluded": "Excluded from automatic fallback",
  "fallback.status.disabled": "Turned off",
  "fallback.status.signedOut": "Signed out",
  "fallback.status.notReady": "Not set up on this machine",
  "fallback.status.limited": "At its limit",
  "fallback.status.full": "Full",
  "fallback.status.fullUntil": "Full until {time}",
  "fallback.status.perToken": "Billed per token: only when you name it or allow API credits",
  "fallback.status.neverAutomatic": "Bills a Google Cloud project: never automatic",
  "fallback.status.namedOnly": "Billing unknown: only when you name it",
  "fallback.access.notRead": "Plan usage not read",
  "fallback.access.reported": "Plan usage reported",
  "fallback.access.lastRead": "Last read {percent}% used",
  "fallback.access.planUsage": "Plan usage {percent}% used",
  "fallback.access.noUsage": "Signed in; provider reports no usage",
  "fallback.access.perToken": "Billed per token",
  "fallback.access.unknown": "Access unknown",
  "fallback.inOrder": "#{index} in order",
  "fallback.include": "Include",
  "fallback.exclude": "Exclude",
  "fallback.includeAria": "Include {model}",
  "fallback.excludeAria": "Exclude {model}",
  "fallback.providerModels": "{provider} models",
  "fallback.hideOlder": "Hide older versions",
  "fallback.showOlder": {
    one: "Show {count} older version",
    other: "Show {count} older versions",
  },
  "fallback.noProviders": "No providers on this machine yet.",
  "fallback.footnote":
    "Excluding a model keeps it out of every automatic switch on every provider; you can still pick it yourself. New models are allowed until you exclude them. Access shown here is only what SpecWithCode can see: GitHub Actions minutes, an X subscription or startup credits are not model access unless one of these providers is signed in with them.",
  "fallback.summary.models": { one: "{count} model", other: "{count} models" },
  "fallback.summary.ready": "{count} ready now",
  "fallback.summary.excluded": "{count} excluded",

  // ── Usage limit settings ──────────────────────────────────
  "limitSettings.mixed": "Mixed",
  "limitSettings.cancel": "Cancel",
  "limitSettings.action.ask": "Offer the fallback",
  "limitSettings.action.wait": "Wait for the reset",
  "limitSettings.action.switch": "Switch automatically",
  "limitSettings.switchAtOption": "At {percent}% left",
  "limitSettings.switchAtOptionDefault": "At {percent}% left (default)",
  "limitSettings.waitOption.never": "Never wait",
  "limitSettings.waitOption.hour": "Under 1 hour",
  "limitSettings.waitOption.twoHours": "Under 2 hours",
  "limitSettings.waitOption.minutes": "Under {minutes} min",
  "limitSettings.action.title": "When a provider runs out",
  "limitSettings.action.descriptionProject":
    "What this project's threads do when their provider hits a usage limit. Switching hands the thread over with its context, in the same worktree.",
  "limitSettings.action.description":
    "What threads do when their provider hits a usage limit. Projects can override it.",
  "limitSettings.order.title": "Fallback order",
  "limitSettings.order.description":
    "The models a limited thread continues on, best first. The first one that is signed in and has room takes the thread; a thread already on one skips it, so Codex threads can fall back to Claude from the same list.",
  "limitSettings.order.descriptionTiers":
    "Leave it empty to follow your model tiers instead; a list here replaces them for limits.",
  "limitSettings.order.descriptionWaits": "When none of these has room, the thread waits.",
  "limitSettings.order.descriptionAny": "After these, SpecWithCode tries any other ready provider.",
  "limitSettings.order.statusTiers": "Uses your model tiers",
  "limitSettings.order.statusAny": "Any ready provider",
  "limitSettings.order.addModel": "Add model",
  "limitSettings.order.addAria": "Add a fallback model",
  "limitSettings.order.noProviders": "No providers available",
  "limitSettings.listOnly.title": "Only these models",
  "limitSettings.listOnly.descriptionTiers":
    "Never continue a limited thread on a model outside your model tiers. When none of them has room, the thread waits for its reset.",
  "limitSettings.listOnly.descriptionOrder":
    "Never continue a limited thread on a model outside the fallback order. When none of them has room, the thread waits for its reset.",
  "limitSettings.options.title": "Where a limited thread can continue",
  "limitSettings.options.description":
    "The models on this machine a limited thread could move to, folded by family and grouped by provider, with older versions tucked away. Exclude a model to keep it out of automatic fallback; to set a family's minimum, exclude the models below it.",
  "limitSettings.options.none": "Nothing excluded",
  "limitSettings.options.count": "{count} excluded",
  "limitSettings.switchAt.title": "Switch before the limit",
  "limitSettings.switchAt.description":
    "With Switch automatically, the next turn starts on the fallback once the provider's lowest usage window has only this much left. With Offer the fallback, the thread suggests the switch at this point instead. Never mid-turn, and only to a provider with more left.",
  "limitSettings.switchAt.off": "Only when it stops",
  "limitSettings.switchAt.custom": "Custom…",
  "limitSettings.switchAt.customLabel": "Usage to switch at, in percent",
  "limitSettings.switchAt.customUnit": "% used",
  "limitSettings.switchAt.customError": "Enter a whole number from {min} to {max}.",
  "limitSettings.waitUnder.title": "Wait when the reset is close",
  "limitSettings.waitUnder.description":
    "When the usage that reached the limit or the threshold resets within this time, nothing switches, redeems or spends: the thread waits and resumes on the same provider at the reset. A weekly window that is also full keeps the wait from applying.",
  "limitSettings.subscription.title": "Continue on a new subscription automatically",
  "limitSettings.subscription.description":
    "When a thread is waiting on a usage limit and its CLI is signed in to another subscription that has room, continue the thread there without asking, whether or not auto-continue is on. A thread whose last report was blocked on a usage limit is told about the change too. A thread you stopped stays stopped. Off: the thread shows the change and waits for you to confirm it. The provider and model stay the same.",
  "limitSettings.redeem.title": "Redeem a banked reset first",
  "limitSettings.redeem.description":
    "When a turn stops on the limit and a fresh usage read confirms the account is at it, use one of the account's banked resets (Claude and Codex grant them) and continue on the same provider before any fallback. At most one per limit window, never while limits are simulated.",
  "limitSettings.spend.title": "Spend Codex credits first",
  "limitSettings.spend.description":
    "When a Codex turn stops on the plan limit and the account holds paid credits, continue that turn on credits before any fallback. SpecWithCode never buys credits or changes automatic reload.",
  "limitSettings.api.title": "Use API credits first",
  "limitSettings.api.description":
    "When a Claude subscription turn stops on the limit and a new usage read confirms it, continue that turn on the same model on a Claude instance billed to Anthropic API credits (its own API key or a Claude Console sign-in), before any fallback. With several API accounts, a turn that one refuses for lack of credits moves on to the next. The thread goes back to the subscription when the limit resets, or as soon as this is turned off. Never while limits are simulated. Without this, the limit banner still offers each account as a button.",
  "limitSettings.api.statusNext": "Continues on {name}, then the next of {count} API accounts",
  "limitSettings.api.statusOne": "Continues on {name} when it lists the thread's model",
  "limitSettings.api.statusNotReady": "{name} is not ready, so nothing moves",
  "limitSettings.api.statusNeeds": "Needs a Claude API account: add one with its key",
  "limitSettings.api.addKey": "Add an API key",
  "limitSettings.api.addAnother": "Add another",
  "limitSettings.redeem.confirmTitle": "Redeem banked resets automatically?",
  "limitSettings.redeem.confirmProject":
    "Turns in this project that stop on a confirmed usage limit will redeem one of the account's banked resets without asking, at most one per limit window. A redeemed reset is gone.",
  "limitSettings.redeem.confirmGlobal":
    "Turns that stop on a confirmed usage limit will redeem one of the account's banked resets without asking, at most one per limit window, in every project that does not override this. A redeemed reset is gone.",
  "limitSettings.redeem.confirm": "Redeem resets",
  "limitSettings.spend.confirmTitle": "Spend paid Codex credits automatically?",
  "limitSettings.spend.confirmProject":
    "Turns in this project that stop on the Codex plan limit will continue on the account's paid credits without asking. Credits cost money and are not refunded.",
  "limitSettings.spend.confirmGlobal":
    "Turns that stop on the Codex plan limit will continue on the account's paid credits without asking, in every project that does not override this. Credits cost money and are not refunded.",
  "limitSettings.spend.confirm": "Spend credits",
  "limitSettings.api.confirmTitle": "Use Claude API credits automatically?",
  "limitSettings.api.confirmProject":
    "Turns in this project that stop on a confirmed Claude subscription limit will continue on your Claude API-key instance without asking, moving on to your next API account if one runs out of credits, and the thread stays there until the limit resets. Every turn it runs there, and any thread it starts from there, is billed to the key's API organization at API rates. SpecWithCode cannot read or cap that balance; set a spend limit in the Claude Console.",
  "limitSettings.api.confirmGlobal":
    "Turns that stop on a confirmed Claude subscription limit will continue on your Claude API-key instance without asking, moving on to your next API account if one runs out of credits, in every project that does not override this, and the thread stays there until the limit resets. Every turn it runs there, and any thread it starts from there, is billed to the key's API organization at API rates. SpecWithCode cannot read or cap that balance; set a spend limit in the Claude Console.",
  "limitSettings.api.confirm": "Use API credits",
  "providerModels.count": { one: "{count} model", other: "{count} models" },
  "providerModels.favorites": { one: "{count} favorite", other: "{count} favorites" },
  "providerModels.hidden": { one: "{count} hidden", other: "{count} hidden" },
  "sidebar.needYou": { one: "needs you", other: "need you" },
  "sidebar.chatCount": { one: "{count} chat", other: "{count} chats" },
  "sidebar.openChatCount": { one: "{count} open chat", other: "{count} open chats" },
} as const satisfies Readonly<Record<string, Message>>;

export type MessageKey = keyof typeof en;

/** A full catalog: every key, with a plural message wherever English has one. */
export type Messages = {
  readonly [K in MessageKey]: (typeof en)[K] extends string ? string : PluralMessage;
};
