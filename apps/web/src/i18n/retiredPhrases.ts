/**
 * Interface strings increment 1390 retired, grouped by the phase that retired them. Each entry
 * is the old text exactly as the source had it before that phase, so an old sentence can never
 * come back. `retiredPhrases.test.ts` reads these lists; this file is outside the stale-phrase
 * scan, so keeping a string here does not count as showing it.
 */

/**
 * Phase 1: a machine is no longer called Main or a Copy, nothing is "made main", and a second
 * coordinator is never started from a button.
 */
const PHASE_1_PHRASES: readonly string[] = [
  "Not shared",
  "{machine} is main now, with machines not yet following it",
  "These machines did not take the new main yet: {machines}. They keep refusing work from the old main only once they do.",
  "Not linked · also on {machine}",
  "This copy is not linked to the copies on {machine}. Link them from the project menu to share one coordinator.",
  "No other machine has a copy of this project.",
  "Connect to see its role",
  "This app cannot see this machine, so it cannot tell what this copy does.",
  "View this project on",
  "coordinator paused",
  "not linked",
  "Not linked: {machine} runs its own coordinator, threads and memory for this repository.",
  "Not linked: these are separate projects for this repository, each with its own coordinator, threads and memory. That does not stop you viewing or messaging any of them.",
  "This app isn't connected to {machine}, so its copy can't be shown. Connect it in Settings > Machines.",
  "Runs on {machine}",
  "Viewing moves nothing: work stays on each machine. Adding or moving the project asks first.",
  "Runs on {machine}. No copy on this device.",
  "Main",
  "Moving main",
  "Copy · main on {machine}",
  "Work for this project starts here. Copies on other machines take work from it.",
  "Main is on {machine}. This copy can also start work of its own.",
  "Work starts on {machine}. This copy takes work from there.",
  "Main is moving between machines right now.",
  "{main} must be unreachable for 10 minutes before {machine} can become main. That unlocks in {minutes} min.",
  "This window can only read {main}, so it cannot move main from there. Open SpecWithCode on {main}, or connect to it with full access, to make {machine} main.",
  "Connect {machine} first to make it main.",
  "{machine} cannot take over yet. Update SpecWithCode there, or connect to it with permission to change settings and run work.",
  "Main cannot move from this machine yet.",
  "{machine} cannot become main yet.",
  "{machine} is main now",
  "{machine} did not become main",
  "the old main",
  "Make {machine} main",
  "Make {machine} main?",
  "{main} has been unreachable for 10 minutes or more. {machine} becomes main and starts from the shared goal, memory and plan. The conversation on {main} stays there as history. Until {main} is back it can still start work on its own machine; then it gives way and lists what it ran meanwhile.",
  "Make {machine} main for {project}",
  "Main for {project} is {machine}. This copy takes work from there.",
  "Main for {project} is on another machine. This copy takes work from there.",
  "Write to {machine}'s coordinator",
  "Write to main's coordinator",
  "Write opens {machine}'s page for this project, where its coordinator answers. Nothing is sent from here.",
  "Write opens main's page for this project, where its coordinator answers. Nothing is sent from here.",
  "{main} has been unreachable for 10 minutes or more. Making {machine} main starts from the shared goal, memory and plan; the conversation on {main} stays there as history.",
  "Making {machine} main moves the coordinator and its conversation here from {main}, which becomes a copy.",
  "{machine} became main while {main} was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on {main} as history.",
  "{machine} became main while the old main was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on the old machine as history.",
  "Makes the project on {machine} part of this one. Main does not change, and threads and files stay where they are. You confirm what {machine} gives up first.",
  "{main} is unreachable: {machine} takes over and starts from the shared goal, memory and plan. You confirm first.",
  "Moves the coordinator and its conversation from {main} to {machine}. {main} becomes a copy. You confirm first.",
  "{machine} joins {project} as a copy. Main stays on {main}: linking does not change it.",
  "Main stays on {main}. To have main on {machine}, make {machine} main after linking.",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on, and its own are replaced if it becomes main. Its own coordinator stops, and that conversation stays on {machine} as history. Its workers keep running. Main stays on {main}. Files are not copied.",
  "Work for {project} starts on {machine}.",
  "Work for {project} starts on another machine.",
  "Connect {main} first. This window has not loaded main's copy on {main}, so it cannot make {machine} main yet.",
  "From {source}. Main stays on {main}.",
  "From {source}. Main stays where it is.",
  "From {source}. Main moves to {machine}.",
  "From {source}. Main moves to the machine you choose.",
  "From {source}. {source}'s copy is not linked to the project {machine} belongs to (Main: {main}).",
  "From {source}. {source}'s copy is not linked to the project {machine} belongs to.",
  "Only files are copied into {machine}'s copy. Main stays on {main}, and {source} is not linked to that project. To make them one project, link {source} to it from the machine menu.",
  "Only files are copied into {machine}'s copy. Its Main does not change, and {source} is not linked to that project. To make them one project, link {source} to it from the machine menu.",
  "Main cannot move to {machine} from here: {source} is not linked to the project {machine} belongs to. Link {source} to it from the machine menu first, or copy the files instead.",
  "Not available: that machine already has Main.",
  "Not available: it would move Main into a project this copy is not linked to.",
  "{machine} has a copy. Main stays on {main}.",
  "Not linked: the copy on {machine} belongs to a project whose Main is {main}, and {source} is not part of it. Nothing was linked.",
  "Not linked: the copy on {machine} belongs to another project, and {source} is not part of it. Nothing was linked.",
  "Pick the copy of {project} on another machine. Each copy keeps its own coordinator; Main stays on {main} and you can switch it any time.",
  "Pick the copy of {project} on another machine. Each copy keeps its own coordinator, and you can switch Main any time.",
  "Other copy",
  "No copy of {project} was found on another machine.",
  "Message {machine}'s coordinator for {project}.",
  "Send delivers your message to {machine}'s coordinator and opens its page, where the answer comes.",
  "Send delivers your message to main's coordinator and opens its page, where the answer comes.",
  "Files stay on this machine. Remove them to send the text to main, or open main's page to attach them there.",
];

/**
 * Phase 2: the machine menu's Send entry and the Send and Copy names of its dialog
 * (Wording table 3) became Sync and Add.
 */
const PHASE_2_PHRASES: readonly string[] = [
  "Send to another machine…",
  "Move {project} to {machine}",
  "Copy {project} to {machine}",
  "Move {project} to another machine",
  "Copy {project} to another machine",
  "{there} has {n} copies of this project. Pick the one to send to.",
  "{there} already has Main, at {folder}, so there is nothing to move.",
  "Work continues on {there}, and this copy stops starting work.",
  "Push this machine's commits, then move Main to {into}.",
  "Linking the copy on {target}…",
  "Linked: {source} can send work to the copy on {target}.",
  "Keep Main on {source}",
  "Copy again",
  "Move project",
];

/**
 * Sleep and silence never start a handoff (AC-36), so their settings and the sentences that
 * promised an automatic move or return are gone.
 */
const SLEEP_START_PHRASES: readonly string[] = [
  "Continue automatically when a machine stops answering",
  "Threads in handoff mode continue on your chosen Mac after this long. Off means they wait for your click. Coordinator threads never move this way.",
  "Automatic takeover",
  "Grace time",
  "Hands work to the Away target when this Mac sleeps. The target waits the grace time first, and nothing moves if you're back sooner. Mac only.",
  "How long the target waits after the lid closes before it takes over.",
  "Leave automatically when the lid closes",
  "Where Away sends your threads, routines and coordinators. Also used when this machine sleeps; locking the screen doesn't count.",
  "After work left while it slept. Ask shows one button to bring it back.",
  // Only a lid-close session honoured it, and none starts any more.
  "Bring back automatically on power",
  // Replaced by sentences that say what an unconfirmed machine may still do.
  "Waiting for {machine} to confirm that silence no longer moves threads. Until it answers, a thread it could continue pauses here when it goes quiet.",
];

/**
 * Strings the Hand off dialog and progress view retired (increment 1390, Phase 3):
 * a thread is handed off, not moved, and "ready to move" is no longer how a row reads.
 * Only the strings that change removed are here; an entry that still does its old job
 * keeps its old name until its own change.
 */
const PHASE_3_PHRASES: readonly string[] = [
  "This server can't move threads to another machine yet.",
  "Leave this machine: hand its threads, routines and coordinator on",
  "Nothing ready to move",
  "Move 1 thread",
  "Can't move",
  "Its conversation and file changes go with it. This copy stops and stays here to read.",
  "Review readiness before moving the selected threads. They continue on the machine you pick. Anything that can't move stays here, untouched.",
  "Nothing is running here that's set to keep ready to move.",
];

/** Exact old phrases: never quoted in the source again, and never a catalog key. */
export const RETIRED_PHRASES: readonly string[] = [
  ...PHASE_1_PHRASES,
  ...PHASE_2_PHRASES,
  ...SLEEP_START_PHRASES,
  ...PHASE_3_PHRASES,
];

/** Phase 1: retired words that were plain text in a component. */
const PHASE_1_TEXT: readonly string[] = [
  "Start a coordinator here",
  "Take over automatically",
  "Take over coordinator here",
  "Main is not reachable from here.",
  "Main did not confirm the message.",
  "This copy takes work from there.",
  "Another machine took over this coordinator.",
  "This copy has not confirmed its coordinator yet.",
  "Copy on ${machineName}, not this computer.",
  "Runs on ${machineName}, not this computer",
  "${here} runs workers",
  "'s coordinator runs again",
  "Each coordinator keeps the threads it started. Nothing moved.",
  "Take over did not finish. Retry it.",
  "Unlink the copy on ${label}",
  "Take over the coordinator on",
  "Take over after",
  "before the other copy takes over.",
  "Make this machine the coordinator again",
  "Plans the work and can send it to every copy.",
  "until you start a coordinator here.",
  "that copy runs workers",
  "the other copy runs workers",
  "to take over automatically.",
];

/** Phase 2: the Send and Copy names of the dialog that were plain text in a component. */
const PHASE_2_TEXT: readonly string[] = [
  "Send this project to another machine",
  "Send to another machine",
  "Copy to send to",
  "Git only, no file copy",
  "Copy everything",
  "Copy changes again",
  "Start a new copy",
  "Copy again with secrets",
  "Measure and compare again",
  "measure and compare again for newer work",
  "Hand off coordinator now",
  "Hand off anyway",
  "Move project to ",
  "${projectTitle} is synced to ${copyDoneOn}",
  " (copied ${when})",
  "Sync ${projectTitle} to ${sync.machine}",
  "Sync compares the two folders and adds what",
  "The coordinator now runs on ${targetLabel}.",
  "continue the project on ${targetLabel}.",
  "Only what it is missing is copied.",
  "Add to another machine… > Review files to transfer.",
  "Copy again: it compares first and moves only what changed.",
  "Copy again brings",
  "Copy again before moving the coordinator.",
  "Copy again before handing off the coordinator.",
];

/** Retired words that were plain text in a component, matched anywhere in the source. */
/** Phase 3's template text, matched anywhere in the source. */
const PHASE_3_TEXT: readonly string[] = [
  "Move ${projectName}'s running threads",
  "Move ${state.movable} threads",
  "'s coordinator stays on ${props.machineName}.",
  "is running on ${props.machineName} that's set to keep ready to move.",
  "Nothing was running here that's set to keep ready to move.",
  "Move to ${best.machineLabel}",
  "Move to ${props.machine}",
  "Moved to ${props.result.machine}",
  'Move "${props.title}"',
];

export const RETIRED_TEXT: readonly string[] = [
  ...PHASE_1_TEXT,
  ...PHASE_2_TEXT,
  ...PHASE_3_TEXT,
];

/** Phase 1: role words. "Main machine" is a settings label of its own (D-20). */
const PHASE_1_BANNED: readonly RegExp[] = [
  /\bMain\b(?! machine)/u,
  /\b[Mm]ake \{\w+\} main\b/u,
  /\bmain on \{/u,
  /\b(is|became|become|becomes) main\b/u,
  /\b[Mm]oving main\b/u,
  /\bmove[sd]? [Mm]ain\b/u,
  /\bmain's\b/u,
  /takes work from/u,
  /[Tt]ake over (the )?coordinator/u,
  /Take over automatically/u,
  /[Ss]tart a coordinator here/u,
  /Not linked:/u,
];

/** Phase 2: the old entry and the old method. */
const PHASE_2_BANNED: readonly RegExp[] = [
  /Send (this project )?to another machine/u,
  /Git only, no file copy/u,
];

/** Patterns no phrase key may match, for the phases shipped so far. */
export const BANNED: readonly RegExp[] = [...PHASE_1_BANNED, ...PHASE_2_BANNED];
