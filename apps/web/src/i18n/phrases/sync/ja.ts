import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncJa: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Git で同期するには {machine} の SpecWithCode を更新してください。「すべてのファイルを比較…」は今すぐ使えます。",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} はオフラインです。同期には両方のマシンの接続が必要です。",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "このウィンドウは {machine} を読み取ることしかできないため、同期できません。{machine} で SpecWithCode を開くか、フルアクセスで接続してください。",
  "{machine} does not have this project.": "{machine} にはこのプロジェクトがありません。",
  "A personal project is not synced between machines.":
    "個人プロジェクトはマシン間で同期されません。",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "{machine} のプロジェクトフォルダは Git リポジトリではありません。「すべてのファイルを比較…」を使ってください。",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine} から応答がありません。接続を確認してから、もう一度確認してください。",
  "1 uncommitted file": "未コミットのファイル 1 件",
  "{n} uncommitted files": "未コミットのファイル {n} 件",
  "Changed since the plan": "計画の後に変更あり",
  "In use by {thread}": "{thread} が使用中",
  "Moved forward 1 commit": "1 コミット進めました",
  "Moved forward {n} commits": "{n} コミット進めました",
  "Moves forward 1 commit": "1 コミット進めます",
  "Moves forward {n} commits": "{n} コミット進めます",
  "Cloned from {remote}": "{remote} からクローンしました",
  "Clones it from {remote}": "{remote} からクローンします",
  "1 commit not pushed (listed as an extra)": "未プッシュのコミット 1 件 (追加分として表示)",
  "{n} commits not pushed (listed as an extra)": "未プッシュのコミット {n} 件 (追加分として表示)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "独自のコミットが 1 件あり、{b} 件遅れています。移動しません",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "独自のコミットが {a} 件あり、{b} 件遅れています。移動しません",
  "Not moved forward: 1 uncommitted file": "進めません: 未コミットのファイル 1 件",
  "Not moved forward: {n} uncommitted files": "進めません: 未コミットのファイル {n} 件",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "{branch} 上にあります。もう一方のマシンのブランチは、リモートにあれば fetch で届きます。チェックアウトはしません",
  "Not on a branch. Not moved": "ブランチ上にありません。移動しません",
  "No upstream. Its commits are listed as an extra":
    "アップストリームがありません。コミットは追加分として表示します",
  "Could not fetch: {reason}. The other repositories continue":
    "fetch できませんでした: {reason}。ほかのリポジトリは続行します",
  "Could not fetch. The other repositories continue":
    "fetch できませんでした。ほかのリポジトリは続行します",
  'Not in Git on a remote. Use "Compare all files…"':
    "リモートの Git にありません。「すべてのファイルを比較…」を使ってください",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "fetch していません: このリポジトリはリモートのミラーで、fetch するとブランチが動いてしまいます",
  "Sync did not change it: {reason}": "同期による変更はありません: {reason}",
  "Sync did not change it": "同期による変更はありません",
  "Follows {name}, which is not a branch of origin. Not moved":
    "{name} を追跡していますが、origin のブランチではありません。移動しません",
  "{upstream} is no longer on origin. Not moved":
    "{upstream} は origin にもうありません。移動しません",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "同期による変更はありません: ブランチがまだあるか origin に確認できませんでした",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "中断されたクローンが {path} を残し、削除できませんでした",
  "{path}: {reason}": "{path}: {reason}",
  "{path}: Sync did not change it": "{path}: 同期による変更はありません",
  "Not moved": "移動しません",
  "1 commit on {branch} that was never pushed":
    "{branch} の一度もプッシュされていないコミット 1 件",
  "{n} commits on {branch} that were never pushed":
    "{branch} の一度もプッシュされていないコミット {n} 件",
  "1 branch that exists only on {machine}": "{machine} にしかないブランチ 1 件",
  "{n} branches that exist only on {machine}": "{machine} にしかないブランチ {n} 件",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "マシン間の接続で {target} に直接、{name} 以下のブランチとして送ります。GitHub には何も送りません。",
  "1 uncommitted file in {repository}": "{repository} の未コミットのファイル 1 件",
  "{n} uncommitted files in {repository}": "{repository} の未コミットのファイル {n} 件",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "{target} にはフォルダ内のファイルではなく、{name} 以下のブランチとして届きます。{source} では何もコミットしません。",
  "1 stash in {repository}": "{repository} のスタッシュ 1 件",
  "{n} stashes in {repository}": "{repository} のスタッシュ {n} 件",
  "Stashes stay. Compare all files… can bring them":
    "スタッシュは残ります。「すべてのファイルを比較…」で持っていけます",
  "1 more branch in {repository} is not listed":
    "{repository} にはほかに表示していないブランチが 1 件あります",
  "{n} more branches in {repository} are not listed":
    "{repository} にはほかに表示していないブランチが {n} 件あります",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "名前からシークレットと判断しました。{source} に残ります: 同期はシークレットを送りません。",
  "Looks like a {kind}": "{kind} のようです",
  "Looks like a secret": "シークレットのようです",
  "Includes 1 commit not pushed on {branch}": "{branch} の未プッシュのコミット 1 件を含みます",
  "Includes {n} commits not pushed on {branch}": "{branch} の未プッシュのコミット {n} 件を含みます",
  "1 file left out": "除外したファイル 1 件",
  "{n} files left out": "除外したファイル {n} 件",
  "{target} already has it as branch {name}.":
    "{target} にはすでにブランチ {name} としてあります。",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target} には同じ名前の別の作業があるため、{name} として隣に届きました。そこで使うには、チェックアウトするかマージしてください。",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "{target} にブランチ {name} として届きました。そこで使うには、チェックアウトするかマージしてください。",
  "Nothing to send: {target} would get no new work.":
    "送るものはありません: {target} に新しい作業は届きません。",
  "Stays on {source}: the branch is no longer there.":
    "{source} に残ります: ブランチはもうありません。",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "{source} に残ります: {reason}。「すべてのファイルを比較…」で持っていけます。",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "{source} に残ります: サイズの上限を超えています。「すべてのファイルを比較…」で持っていけます。",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "{source} に残ります: 先に {target} の SpecWithCode を更新してください。",
  "Stays on {source}: {reason}.": "{source} に残ります: {reason}。",
  "Stays on {source}: it could not be sent.": "{source} に残ります: 送信できませんでした。",
  "Needs update · {version}": "要更新 · {version}",
  "Needs update": "要更新",
  "This window can only read {machine}": "このウィンドウは {machine} を読み取ることしかできません",
  "Not there": "なし",
  Repository: "リポジトリ",
  "Only on {machine} · Git does not carry these": "{machine} にのみ · Git では運ばれません",
  "Work that is only on {machine} could not be listed.":
    "{machine} にしかない作業を一覧にできませんでした。",
  "Secrets and files left out on {machine}": "{machine} のシークレットと除外したファイル",
  "Will be sent": "送信します",
  "Send anyway": "それでも送る",
  "1 more file is left out and not listed.":
    "ほかに 1 件のファイルを除外しており、一覧にはありません。",
  "{n} more files are left out and not listed.":
    "ほかに {n} 件のファイルを除外しており、一覧にはありません。",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "ファイル名で確認し、未追跡のファイルは先頭 64 KB も確認しています。送る前に一覧を確認してください。",
  "Extras from {machine}": "{machine} からの追加分",
  "The extras from {machine} were not sent.": "{machine} からの追加分は送られませんでした。",
  "Uncommitted files in {repository}": "{repository} の未コミットのファイル",
  "Compare all files…": "すべてのファイルを比較…",
  "Sync {project}": "{project} を同期",
  "{project} is in sync on {source} and {machine}":
    "{project} は {source} と {machine} で同期済みです",
  "Sync {project}: {source} and {machine}": "{project} を同期: {source} と {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "まず Git。各マシンがリモートから fetch して、早送り (fast-forward) のみで進めます。何も上書きせず、何もプッシュしません。コーディネーターはそのままです。",
  "Sync {machine} with": "{machine} の同期先",
  "Fetching on {source} and {machine}…": "{source} と {machine} で fetch 中…",
  "Syncing {source} and {machine}…": "{source} と {machine} を同期中…",
  "Sending the ticked extras…": "チェックした追加分を送信中…",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "{machine} の最上位のリポジトリだけを表示しています: フォルダがスキャンの上限を超えているため、中のリポジトリは省略しました。",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "進めるものもクローンするものもありません。送るには追加分にチェックを入れてください。",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "どちらかに Git の外のファイルがありますか？「すべてのファイルを比較…」は時間はかかりますが完全な方法です。",
  "Syncing…": "同期中…",
  Sync: "同期",
  "Same as {shown}": "{shown} と同じ",
  "Same as {shown} · as of {time}": "{shown} と同じ · {time} 時点",
  "{k} of {n} repositories differ": "{n} 件中 {k} 件のリポジトリに差分",
  "{k} of {n} repositories differ · as of {time}":
    "{n} 件中 {k} 件のリポジトリに差分 · {time} 時点",
  "Not checked yet": "未確認",
  "Sync…": "同期…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "未コミットのファイル 1 件は {source} に残ります: Git が運ぶのはコミットだけです。コミットするか、「詳細」で「フォルダ全体をコピー」を選んでください。",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "未コミットのファイル {count} 件は {source} に残ります: Git が運ぶのはコミットだけです。コミットするか、「詳細」で「フォルダ全体をコピー」を選んでください。",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "未コミットの作業は {source} に残ります: Git が運ぶのはコミットだけです。コミットするか、「詳細」で「フォルダ全体をコピー」を選んでください。",
  "Add to another machine": "別のマシンに追加",
  "Add {project} to another machine": "{project} を別のマシンに追加",
  "Add {project} to {machine}": "{project} を {machine} に追加",
  "Compare again": "もう一度比較",
  "Continue on {target} anyway, on its older commits":
    "それでも {target} で続行 (古いコミットのまま)",
  "Continue the coordinator on another machine": "コーディネーターを別のマシンで続行",
  "Copy the whole folder from {source}": "{source} からフォルダ全体をコピー",
  "Download from GitHub (recommended)": "GitHub からダウンロード (推奨)",
  "Folder on {machine}": "{machine} のフォルダ",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "先にプッシュするか、「詳細」で「フォルダ全体をコピー」を選んでください。どちらの場合も移動は進みます。",
  "Push these commits and continue the coordinator on {target}.":
    "これらのコミットをプッシュして、{target} でコーディネーターを続行します。",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "これらのコミットをそれぞれのリモートにプッシュして、{target} でコーディネーターを続行します。",
  "Sync again": "もう一度同期",
  "Sync again…": "もう一度同期…",
  "Run the same sync again": "同じ同期をもう一度実行",
  "Sync again with secrets": "シークレットも含めてもう一度同期",
  "Sync again before handing off the coordinator.":
    "コーディネーターを引き継ぐ前に、もう一度同期してください。",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "「もう一度同期」は変更分を持ってきます。先に比較し、変更されたファイルだけを移動します。「それでも {target} で続行」は、これらの差分があるままコーディネーターを移動します。「元に戻す」は {target} のフォルダを元に戻します。",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "このコピーは記録されていないため、それらなしでは移動できません。「もう一度同期」で持ってこられます。または、コーディネーターを {source} に残してください。{target} のコピーは残ります。",
  "Add this project to another machine": "このプロジェクトを別のマシンに追加",
  "{project} is on {machine}": "{project} は {machine} にあります",
  "{project} is on {machine} (added {when})": "{project} は {machine} にあります ({when}に追加)",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine} にはすでに {folder} にこのプロジェクトがあります。「すべてのファイルを比較」は 2 つのフォルダを比較し、{machine} に足りないものを追加します。コーディネーターは {source} に残ります。",
  "The coordinator continues on {target}.": "コーディネーターは {target} で続行します。",
  "The coordinator stays here until you sync again.":
    "もう一度同期するまで、コーディネーターはここに残ります。",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "ファイルは {target} にありますが、{problem}。もう一度同期してください。先に比較し、変更されたものだけを移動します。",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "ファイルは {target} にありますが、{problem}。「それでも {target} で続行」を選んだため、コーディネーターはこれらの差分があるまま移動しました。",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "ファイルは {target} にありますが、{problem}。「それでも {target} で続行」を選んだため、コーディネーターはこれらの差分があるまま移動します。",
  "The source changed. Compare again.": "元の内容が変わりました。もう一度比較してください。",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "元の内容が変わりました。記録済みのファイルはそのままコピーできます。新しい作業を含めるにはもう一度比較してください。",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "コピーの後に {source} が変わりました。コーディネーターを移動する前に、もう一度同期してください。",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "このプロジェクトには Git のリモートがないため、{machine} はクローン元がありません。代わりにフォルダをコピーしてください: マシンのメニュー > 別のマシンに追加… > フォルダ全体をコピー。",
  "{there} already has the coordinator, at {folder}.":
    "{there} にはすでにコーディネーターがあります ({folder})。",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there} にはすでにこのプロジェクトがあります ({folder})。同期で最新にします。",
  "{there} has this project in {n} folders. Pick one.":
    "{there} にはこのプロジェクトが {n} 個のフォルダにあります。1 つ選んでください。",
  "Sync finished for {project}: {source} and {machine}":
    "{project} の同期が終わりました: {source} と {machine}",
  "Sync ended, and not everything was moved or sent. Each repository says why.":
    "同期は終わりましたが、移動または送信されなかったものがあります。理由は各リポジトリに表示されます。",
  'No answer came for this repository, and it may have moved. "Check again" shows where it stands':
    "このリポジトリについて応答がなく、移動された可能性があります。「もう一度確認」で現在の状態がわかります",
  "{machine} answered in a way this version does not read. Update SpecWithCode on this machine, then check again.":
    "{machine} の応答は、このバージョンでは読み取れない形式でした。このマシンの SpecWithCode を更新してから、もう一度確認してください。",
  "Nothing was moved or sent.": "何も移動も送信もしていません。",
  "The rest of the extras from {machine} were not sent.":
    "{machine} の残りの追加分は送信されませんでした。",
  "Sent to {target}: {reason}.": "{target} に送信しました: {reason}。",
  "Sent to {target}.": "{target} に送信しました。",
  "Tick the uncommitted files of {repository} first.":
    "先に {repository} の未コミットのファイルにチェックを入れてください。",
  "Send anyway only applies once that repository's uncommitted files are ticked.":
    "「それでも送る」は、そのリポジトリの未コミットのファイルにチェックを入れたときだけ適用されます。",
  "{machine}: Needs update · {version}": "{machine}: 要更新 · {version}",
  "{machine}: Needs update": "{machine}: 要更新",
  "{machine} could not sync: {reason}.": "{machine} で同期できませんでした: {reason}。",
  "{machine} did not finish its part of the sync.":
    "{machine} は同期の担当分を完了しませんでした。",
  Repositories: "リポジトリ",
  "Sync again brings {source}'s version over. Moving without these paths keeps {source}'s changes there and leaves the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "「もう一度同期」は {source} の版を持ってきます。これらのパスなしで移動すると、{source} の変更はそこに残り、{target} のコピーはそのままになります。そこで作業を続けるにはコーディネーターを {source} に残します。{target} のコピーは残ります。",
  "Keep the coordinator on {source}": "コーディネーターを {source} に残す",
  "Move without this path": "このパスなしで移動",
  "Move without these {n} paths": "これら {n} 個のパスなしで移動",
  "The files are on {target}, but {problem}.": "ファイルは {target} にありますが、{problem}。",
  "The coordinator stays on {source}. The copied files stay on {target}.":
    "コーディネーターは {source} に残ります。コピーしたファイルは {target} に残ります。",
  "The coordinator stays here until you choose below.":
    "下で選ぶまで、コーディネーターはここに残ります。",
  "Files are copied. Hand off the coordinator once work here is idle.":
    "ファイルをコピーしました。ここの作業が落ち着いたらコーディネーターを引き継いでください。",
  "Linking {target}…": "{target} をリンク中…",
  "Linked: {source} can start work on {target}.":
    "リンクしました: {source} から {target} で作業を開始できます。",
  "Linked: {source} can start work on {target}, in {folder}.":
    "リンクしました: {source} から {target} の {folder} で作業を開始できます。",
  "Not linked yet. {reason}": "まだリンクされていません。{reason}",
  "No uncommitted changes on {source}.": "{source} に未コミットの変更はありません。",
  "Repositories new there download from GitHub or their Git host; one with unpushed commits or stashes is copied whole. Uncommitted and ignored files, and secrets unless you leave them out, come from this machine.":
    "向こうにないリポジトリは GitHub または Git ホストからダウンロードします。未プッシュのコミットやスタッシュがあるものは丸ごとコピーします。未コミットのファイルと無視されたファイル、除外しないかぎりシークレットも、このマシンから送ります。",
  "Also brings unpushed commits, local branches and stashes. Slower for large repositories.":
    "未プッシュのコミット、ローカルブランチ、スタッシュも持っていきます。大きなリポジトリでは遅くなります。",
  "Continues in a folder already saved there, which updates from origin. Always moves the coordinator there.":
    "向こうに保存済みのフォルダで続行し、origin から更新します。コーディネーターは必ずそこへ移ります。",
  "Compare again before previewing this changed source.":
    "変更されたこのソースをプレビューする前に、もう一度比較してください。",
  "The source changed. Compare again before copying.":
    "ソースが変更されました。コピーする前にもう一度比較してください。",
  "Not moved: its state could not be read": "移動しません: 状態を読み取れませんでした",
  "Sent straight to {target} over the link between the machines, as a branch under {name}. Nothing goes to GitHub.":
    "マシン間の接続で {target} に直接、{name} 以下のブランチとして送ります。GitHub には何も送りません。",
  "The branch it would arrive as is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "届くはずだったブランチが {target} でチェックアウトされているため、{name} として隣に届きました。そこで使うには、チェックアウトするかマージしてください。",
  "No answer came back. It may have arrived on {target}: check {target} before sending again.":
    "応答が返ってきませんでした。{target} に届いている可能性があります。もう一度送る前に {target} で確認してください。",
  "Not sent.": "送信されませんでした。",
  "{machine} sent extras and no answer came back. They may have arrived: check {target} before sending again.":
    "{machine} は追加分を送りましたが、応答が返ってきませんでした。届いている可能性があります。もう一度送る前に {target} で確認してください。",
  "Sync ended, and not every answer came back. Each line says what to check.":
    "同期は終わりましたが、返ってこなかった応答があります。確認することは各行に表示されます。",
  "A move to another machine is not finished. Finish or cancel it, then add a machine.":
    "別のマシンへの移動が終わっていません。完了するかキャンセルしてから、マシンを追加してください。",
  "The copy on {machine} is already shared with other machines. Unlink it there first.":
    "{machine} のコピーはすでに他のマシンと共有されています。先にそこでリンクを解除してください。",
  "The copy on {machine} does not hold its coordinator, so it cannot be the one that stays.":
    "{machine} のコピーにはコーディネーターがないため、残す側にはできません。",
  "A coordinator handoff is in progress on {machine}. Finish or retry it first.":
    "{machine} でコーディネーターの引き継ぎが進行中です。先に完了するか、やり直してください。",
  "The project on {machine} is paused. Resume it first.":
    "{machine} のプロジェクトは一時停止中です。先に再開してください。",
  "The project on {machine} is archived. Restore it first.":
    "{machine} のプロジェクトはアーカイブされています。先に復元してください。",
  "Only code projects can be linked across machines.":
    "マシン間でリンクできるのはコードプロジェクトだけです。",
  "The coordinator on {machine} is working. Let it finish or stop it, then link.":
    "{machine} のコーディネーターは作業中です。終わるのを待つか停止してから、リンクしてください。",
  "Project notes differ on {machine}.": "{machine} のプロジェクトノートに違いがあります。",
  "The copy's repository does not match the source.":
    "コピーのリポジトリがコピー元と一致しません。",
  "some files changed on {source} while copying":
    "コピー中に {source} で一部のファイルが変更されました",
  "the check of Root failed": "ルートリポジトリのチェックに失敗しました",
  "the check of {repository} failed": "{repository} のチェックに失敗しました",
  "the checks of {n} repositories failed": "{n} 件のリポジトリのチェックに失敗しました",
  "A copy to {machine} is not finished. Finish or cancel it, then add another machine.":
    "{machine} へのコピーが完了していません。完了するかキャンセルしてから、別のマシンを追加してください。",
  "A copy is not finished. Finish or cancel it, then add another machine.":
    "コピーが完了していません。完了するかキャンセルしてから、別のマシンを追加してください。",
  "Open the unfinished copy": "未完了のコピーを開く",
  "Finish handoff": "引き継ぎを完了",
  "Needs update: fetched only, not moved forward": "更新が必要: フェッチのみ、前進していません",
  "Needs update: not cloned": "更新が必要: クローンしていません",
  "Could not be read. Not moved": "読み取れませんでした。移動していません",
  "May have moved forward: the result could not be read. Check it before working in it":
    "前進した可能性があります: 結果を読み取れませんでした。作業する前に確認してください",
  "{repository} could not be read: what is only on {machine} is not known":
    "{repository} を読み取れませんでした: {machine} にだけあるものは不明です",
  "Which branches of {repository} are only on {machine} could not be read":
    "{repository} のどのブランチが {machine} にだけあるか読み取れませんでした",
  "Its state could not be read after the run": "実行後にその状態を読み取れませんでした",
  "Could not compare: a repository could not be read":
    "比較できません: リポジトリを読み取れませんでした",
};
