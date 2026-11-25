import type { PhraseCatalog } from "../../phrases";

/** Japanese: helper threads another machine started, under their project (1484 AC-03, AC-04, AC-06). */
export const helperChatsJa: PhraseCatalog = {
  "From {project} on {machine}": "{machine} の {project} から",
  "From {project}": "{project} から",
  "From {machine}": "{machine} から",
  "{project} on {machine}: open the thread that asked for this":
    "{machine} の {project}: 依頼元のスレッドを開く",
  "{project}: open the thread that asked for this": "{project}: 依頼元のスレッドを開く",
  "{machine}: open the thread that asked for this": "{machine}: 依頼元のスレッドを開く",
  "A thread in {project} on {machine} asked for this. Open that thread.":
    "{machine} の {project} のスレッドからの依頼です。そのスレッドを開きます。",
  "A thread in {project} asked for this. Open that thread.":
    "{project} のスレッドからの依頼です。そのスレッドを開きます。",
  "A thread on {machine} asked for this. Open that thread.":
    "{machine} のスレッドからの依頼です。そのスレッドを開きます。",
  "· on {machine}": "· {machine}",
  "Helpers on other machines are blocked": "他のマシンのヘルパーがブロックされています",
  "{title} is blocked:": "{title} はブロックされています:",
};
