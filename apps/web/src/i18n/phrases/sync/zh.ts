import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncZh: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "请在 {machine} 上更新 SpecWithCode，才能通过 Git 同步。“比较所有文件…”现在就能用。",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} 已离线。同步需要两台电脑都已连接。",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "此窗口只能读取 {machine}，因此无法同步它。请在 {machine} 上打开 SpecWithCode，或以完全访问权限连接它。",
  "{machine} does not have this project.": "{machine} 上没有这个项目。",
  "A personal project is not synced between machines.": "个人项目不会在电脑之间同步。",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "{machine} 上的项目文件夹不是 Git 仓库。请使用“比较所有文件…”。",
  "{machine} could not do it: {reason}.": "{machine} 无法完成：{reason}。",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine} 没有响应。请检查连接，然后重新检查。",
  "1 uncommitted file": "1 个未提交的文件",
  "{n} uncommitted files": "{n} 个未提交的文件",
  "Changed since the plan": "计划之后有变化",
  "In use by {thread}": "正被 {thread} 使用",
  "Moved forward 1 commit": "已前进 1 个提交",
  "Moved forward {n} commits": "已前进 {n} 个提交",
  "Moves forward 1 commit": "将前进 1 个提交",
  "Moves forward {n} commits": "将前进 {n} 个提交",
  "Cloned from {remote}": "已从 {remote} 克隆",
  "Clones it from {remote}": "将从 {remote} 克隆",
  "1 commit not pushed (listed as an extra)": "1 个提交未推送（列为附加项）",
  "{n} commits not pushed (listed as an extra)": "{n} 个提交未推送（列为附加项）",
  "Has 1 commit of its own and is {b} behind. Not moved": "有 1 个自己的提交，落后 {b} 个。未移动",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "有 {a} 个自己的提交，落后 {b} 个。未移动",
  "Not moved forward: 1 uncommitted file": "未前进：1 个未提交的文件",
  "Not moved forward: {n} uncommitted files": "未前进：{n} 个未提交的文件",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "在 {branch} 上。远程有另一台电脑的分支时，它会随 fetch 一起获取；不会检出任何内容",
  "Not on a branch. Not moved": "不在分支上。未移动",
  "No upstream. Its commits are listed as an extra": "没有上游。它的提交列为附加项",
  "Could not fetch: {reason}. The other repositories continue":
    "无法 fetch：{reason}。其他仓库继续",
  "Could not fetch. The other repositories continue": "无法 fetch。其他仓库继续",
  'Not in Git on a remote. Use "Compare all files…"': "不在远程 Git 中。请使用“比较所有文件…”",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "未 fetch：此仓库是其远程的镜像，fetch 会移动它的分支",
  "Sync did not change it: {reason}": "同步未更改它：{reason}",
  "Sync did not change it": "同步未更改它",
  "Not moved": "未移动",
  "1 commit on {branch} that was never pushed": "{branch} 上有 1 个从未推送的提交",
  "{n} commits on {branch} that were never pushed": "{branch} 上有 {n} 个从未推送的提交",
  "Sent straight to {target} over the link between the machines, as branch {name}. Nothing goes to GitHub.":
    "通过电脑之间的连接直接发送到 {target}，作为分支 {name}。不会发送到 GitHub。",
  "1 branch that exists only on {machine}": "1 个只在 {machine} 上存在的分支",
  "{n} branches that exist only on {machine}": "{n} 个只在 {machine} 上存在的分支",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "通过电脑之间的连接直接发送到 {target}，作为 {name} 下的分支。不会发送到 GitHub。",
  "1 uncommitted file in {repository}": "{repository} 中有 1 个未提交的文件",
  "{n} uncommitted files in {repository}": "{repository} 中有 {n} 个未提交的文件",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "以 {name} 下的分支到达 {target}，而不是作为其文件夹中的文件。不会在 {source} 上提交任何内容。",
  "1 stash in {repository}": "{repository} 中有 1 个 stash",
  "{n} stashes in {repository}": "{repository} 中有 {n} 个 stash",
  "Stashes stay. Compare all files… can bring them": "stash 保留原处。“比较所有文件…”可以带过去",
  "1 more branch in {repository} is not listed": "{repository} 中还有 1 个分支未列出",
  "{n} more branches in {repository} are not listed": "{repository} 中还有 {n} 个分支未列出",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "按名称判断为机密。它留在 {source} 上：同步不会发送机密。",
  "Looks like a {kind}": "看起来像{kind}",
  "Looks like a secret": "看起来像机密",
  "Not done: the machine gave no answer for this repository": "未完成：该电脑没有回复此仓库的结果",
  "Includes 1 commit not pushed on {branch}": "包含 {branch} 上 1 个未推送的提交",
  "Includes {n} commits not pushed on {branch}": "包含 {branch} 上 {n} 个未推送的提交",
  "1 file left out": "1 个文件被排除",
  "{n} files left out": "{n} 个文件被排除",
  "{target} already has it as branch {name}.": "{target} 已有它，分支为 {name}。",
  "{branch} is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{branch} 已在 {target} 上检出，因此它作为 {name} 放在旁边。要在那里使用，请检出或合并它。",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target} 上已有同名的其他工作，因此它作为 {name} 放在旁边。要在那里使用，请检出或合并它。",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "已作为分支 {name} 到达 {target}。要在那里使用，请检出或合并它。",
  "Nothing to send: {target} would get no new work.":
    "没有可发送的内容：{target} 不会得到新的工作。",
  "Stays on {source}: the branch is no longer there.": "留在 {source} 上：该分支已不存在。",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "留在 {source} 上：{reason}。“比较所有文件…”可以带过去。",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "留在 {source} 上：超出大小限制。“比较所有文件…”可以带过去。",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "留在 {source} 上：请先在 {target} 上更新 SpecWithCode。",
  "Stays on {source}: {target} could not be reached.": "留在 {source} 上：无法连接 {target}。",
  "Stays on {source}: {reason}.": "留在 {source} 上：{reason}。",
  "Stays on {source}: it could not be sent.": "留在 {source} 上：无法发送。",
  "Needs update · {version}": "需要更新 · {version}",
  "Needs update": "需要更新",
  "This window can only read {machine}": "此窗口只能读取 {machine}",
  "Not there": "不存在",
  Repository: "仓库",
  "Only on {machine} · Git does not carry these": "仅在 {machine} 上 · Git 不会带走这些",
  "Work that is only on {machine} could not be listed.": "无法列出只在 {machine} 上的工作。",
  "Secrets and files left out on {machine}": "{machine} 上的机密和被排除的文件",
  "Will be sent": "将发送",
  "Send anyway": "仍然发送",
  "1 more file is left out and not listed.": "还有 1 个文件被排除，未列出。",
  "{n} more files are left out and not listed.": "还有 {n} 个文件被排除，未列出。",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "按文件名检查，未跟踪的文件还会检查前 64 KB。发送前请先看一遍列表。",
  "Send anyway counts once the uncommitted files of that repository are ticked.":
    "勾选该仓库的未提交文件后，“仍然发送”才会生效。",
  "Extras from {machine}": "来自 {machine} 的附加项",
  "The extras from {machine} were not sent.": "来自 {machine} 的附加项未发送。",
  "Uncommitted files in {repository}": "{repository} 中未提交的文件",
  "Compare all files…": "比较所有文件…",
  "Sync {project}": "同步 {project}",
  "{project} is in sync on {source} and {machine}": "{project} 在 {source} 和 {machine} 上已同步",
  "Sync {project}: {source} and {machine}": "同步 {project}：{source} 和 {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "先用 Git。每台电脑从远程 fetch 并前进，仅限快进。不会覆盖任何内容，也不会推送任何内容。协调者保持原位。",
  "Sync {machine} with": "将 {machine} 同步到",
  "Fetching on {source} and {machine}…": "正在 {source} 和 {machine} 上 fetch…",
  "Nothing was changed on either machine.": "两台电脑上都没有更改任何内容。",
  "Syncing {source} and {machine}…": "正在同步 {source} 和 {machine}…",
  "Sending the ticked extras…": "正在发送勾选的附加项…",
  "{machine} did not run its part.": "{machine} 没有执行它的部分。",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "只列出了 {machine} 的顶层仓库：它的文件夹超出了扫描限制，因此跳过其中的仓库。",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "没有需要前进或克隆的内容。勾选附加项即可发送。",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "任一侧有 Git 之外的文件？“比较所有文件…”是较慢但完整的方式。",
  "Syncing…": "正在同步…",
  Sync: "同步",
  "Same as {shown}": "与 {shown} 相同",
  "Same as {shown} · as of {time}": "与 {shown} 相同 · 截至 {time}",
  "{k} of {n} repositories differ": "{n} 个仓库中有 {k} 个不同",
  "{k} of {n} repositories differ · as of {time}": "{n} 个仓库中有 {k} 个不同 · 截至 {time}",
  "Not checked yet": "尚未检查",
  "Sync…": "同步…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "1 个未提交的文件留在 {source} 上：Git 只带走提交。请提交它，或在“详情”中选择“复制整个文件夹”。",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "{count} 个未提交的文件留在 {source} 上：Git 只带走提交。请提交它们，或在“详情”中选择“复制整个文件夹”。",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "未提交的工作留在 {source} 上：Git 只带走提交。请提交它们，或在“详情”中选择“复制整个文件夹”。",
  "Add to another machine": "添加到另一台电脑",
  "Add {project} to another machine": "将 {project} 添加到另一台电脑",
  "Add {project} to {machine}": "将 {project} 添加到 {machine}",
  "Compare again": "重新比较",
  "Continue on {target} anyway, on its older commits": "仍在 {target} 上继续，使用它较旧的提交",
  "Continue the coordinator on another machine": "在另一台电脑上继续协调者",
  "Copy the whole folder from {source}": "从 {source} 复制整个文件夹",
  "Download from GitHub (recommended)": "从 GitHub 下载（推荐）",
  "Folder on {machine}": "{machine} 上的文件夹",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "请先推送，或在“详情”中选择“复制整个文件夹”。无论哪种方式，迁移都会继续。",
  "Push these commits and continue the coordinator on {target}.":
    "推送这些提交，并在 {target} 上继续协调者。",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "将这些提交推送到各自的远程，并在 {target} 上继续协调者。",
  "Sync again": "重新同步",
  "Sync again…": "重新同步…",
  "Run the same sync again": "再次运行相同的同步",
  "Sync again with secrets": "包含机密重新同步",
  "Sync again before handing off the coordinator.": "交接协调者之前请重新同步。",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "“重新同步”会带来已更改的内容；它先比较，只移动已更改的文件。“仍在 {target} 上继续”会带着这些差异迁移协调者。“撤销”会把 {target} 的文件夹恢复原样。",
  "Sync again brings {source}'s version over. Move without them keeps {source}'s changes there and the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "“重新同步”会带来 {source} 的版本。“不带它们迁移”会把 {source} 的更改留在那里，{target} 上的副本保持原样。“将协调者留在 {source}”可在那里继续工作；{target} 上的副本保留。",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "这次复制没有被捕获，因此无法不带它们迁移。“重新同步”会带来它们。或者将协调者留在 {source}；{target} 上的副本保留。",
  "Add this project to another machine": "将此项目添加到另一台电脑",
  "{project} is on {machine}": "{project} 在 {machine} 上",
  "{project} is on {machine} (added {when})": "{project} 在 {machine} 上（{when}添加）",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine} 已在 {folder} 有此项目。“比较所有文件”会比较两个文件夹，并添加 {machine} 缺少的内容。协调者留在 {source}。",
  "The coordinator continues on {target}.": "协调者在 {target} 上继续。",
  "The coordinator stays here until you sync again.": "在你重新同步之前，协调者留在这里。",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "文件已在 {target} 上，但{problem}。请重新同步：它先比较，只移动已更改的内容。",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "文件已在 {target} 上，但{problem}。你选择了“仍在 {target} 上继续”，因此协调者已带着这些差异迁移。",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "文件已在 {target} 上，但{problem}。你选择了“仍在 {target} 上继续”，因此协调者会带着这些差异迁移。",
  "The source changed. Compare again.": "来源已更改。请重新比较。",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "来源已更改。你仍可以复制已捕获的文件，或重新比较以获取更新的工作。",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "复制后 {source} 有更改。迁移协调者之前请重新同步。",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "此项目没有 Git 远程，因此 {machine} 无处克隆。请改为把它的文件夹复制过去：电脑菜单 > 添加到另一台电脑… > 复制整个文件夹。",
  "{there} already has the coordinator, at {folder}.": "{there} 已有协调者，位于 {folder}。",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there} 已有此项目，位于 {folder}。同步会将它更新到最新。",
  "{there} has this project in {n} folders. Pick one.":
    "{there} 上有 {n} 个文件夹包含此项目。请选择一个。",
};
