import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncRu: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Обновите SpecWithCode на {machine}, чтобы синхронизировать через Git. «Сравнить все файлы…» работает уже сейчас.",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} не в сети. Для синхронизации обе машины должны быть подключены.",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "Это окно может только читать {machine}, поэтому не может его синхронизировать. Откройте SpecWithCode на {machine} или подключитесь к нему с полным доступом.",
  "{machine} does not have this project.": "На {machine} нет этого проекта.",
  "A personal project is not synced between machines.":
    "Личный проект не синхронизируется между машинами.",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "Папка проекта на {machine} не является Git-репозиторием. Используйте «Сравнить все файлы…».",
  "{machine} did not answer. Check the connection, then check again.":
    "Нет ответа от {machine}. Проверьте подключение и проверьте снова.",
  "1 uncommitted file": "1 незакоммиченный файл",
  "{n} uncommitted files": "Незакоммиченных файлов: {n}",
  "Changed since the plan": "Изменилось с момента плана",
  "In use by {thread}": "Используется тредом «{thread}»",
  "Moved forward 1 commit": "Продвинуто вперёд: 1 коммит",
  "Moved forward {n} commits": "Продвинуто вперёд, коммитов: {n}",
  "Moves forward 1 commit": "Продвинется вперёд: 1 коммит",
  "Moves forward {n} commits": "Продвинется вперёд, коммитов: {n}",
  "Cloned from {remote}": "Клонирован из {remote}",
  "Clones it from {remote}": "Будет клонирован из {remote}",
  "1 commit not pushed (listed as an extra)": "1 коммит не отправлен (в списке дополнений)",
  "{n} commits not pushed (listed as an extra)":
    "Неотправленных коммитов: {n} (в списке дополнений)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "Есть 1 свой коммит, отстаёт на {b}. Не продвинуто",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "Своих коммитов: {a}, отстаёт на {b}. Не продвинуто",
  "Not moved forward: 1 uncommitted file": "Не продвинуто: 1 незакоммиченный файл",
  "Not moved forward: {n} uncommitted files": "Не продвинуто, незакоммиченных файлов: {n}",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "На ветке {branch}. Ветка другой машины придёт с fetch, если она есть в удалённом репозитории; ничего не переключается",
  "Not on a branch. Not moved": "Не на ветке. Не продвинуто",
  "No upstream. Its commits are listed as an extra":
    "Нет upstream. Его коммиты в списке дополнений",
  "Could not fetch: {reason}. The other repositories continue":
    "Не удалось выполнить fetch: {reason}. Остальные репозитории продолжают",
  "Could not fetch. The other repositories continue":
    "Не удалось выполнить fetch. Остальные репозитории продолжают",
  'Not in Git on a remote. Use "Compare all files…"':
    "Нет в удалённом Git-репозитории. Используйте «Сравнить все файлы…»",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "Fetch не выполнен: этот репозиторий зеркалирует удалённый, и fetch сдвинул бы его ветки",
  "Sync did not change it: {reason}": "Синхронизация его не изменила: {reason}",
  "Sync did not change it": "Синхронизация его не изменила",
  "Follows {name}, which is not a branch of origin. Not moved":
    "Следует за {name}, а это не ветка origin. Не продвинуто",
  "{upstream} is no longer on origin. Not moved": "{upstream} больше нет в origin. Не продвинуто",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "Синхронизация его не изменила: не удалось спросить origin, есть ли ещё эта ветка",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "Остановленное клонирование оставило {path}, и удалить папку не удалось",
  "{path}: {reason}": "{path}: {reason}",
  "{path}: Sync did not change it": "{path}: синхронизация его не изменила",
  "Not moved": "Не продвинуто",
  "1 commit on {branch} that was never pushed": "1 коммит в {branch}, который не был отправлен",
  "{n} commits on {branch} that were never pushed": "Неотправленных коммитов в {branch}: {n}",
  "1 branch that exists only on {machine}": "1 ветка, которая есть только на {machine}",
  "{n} branches that exist only on {machine}": "Веток, которые есть только на {machine}: {n}",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "Отправляются напрямую на {target} по связи между машинами, как ветки в {name}. В GitHub ничего не уходит.",
  "1 uncommitted file in {repository}": "1 незакоммиченный файл в {repository}",
  "{n} uncommitted files in {repository}": "Незакоммиченных файлов в {repository}: {n}",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "Придут на {target} веткой в {name}, а не файлами в папке. На {source} ничего не коммитится.",
  "1 stash in {repository}": "1 stash в {repository}",
  "{n} stashes in {repository}": "Stash в {repository}: {n}",
  "Stashes stay. Compare all files… can bring them":
    "Stash остаются. «Сравнить все файлы…» может их перенести",
  "1 more branch in {repository} is not listed": "Ещё 1 ветка в {repository} не показана",
  "{n} more branches in {repository} are not listed": "Ещё веток в {repository} не показано: {n}",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "Секрет по имени. Остаётся на {source}: синхронизация не отправляет секреты.",
  "Looks like a {kind}": "Похоже на {kind}",
  "Looks like a secret": "Похоже на секрет",
  "Includes 1 commit not pushed on {branch}": "Включает 1 неотправленный коммит в {branch}",
  "Includes {n} commits not pushed on {branch}": "Включает неотправленные коммиты в {branch}: {n}",
  "1 file left out": "1 файл пропущен",
  "{n} files left out": "Пропущено файлов: {n}",
  "{target} already has it as branch {name}.": "На {target} это уже есть как ветка {name}.",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "На {target} под этим именем другая работа, поэтому это пришло рядом как {name}. Чтобы использовать там, переключитесь на неё или слейте её.",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "На {target} как ветка {name}. Чтобы использовать там, переключитесь на неё или слейте её.",
  "Nothing to send: {target} would get no new work.":
    "Нечего отправлять: {target} не получит новой работы.",
  "Stays on {source}: the branch is no longer there.": "Остаётся на {source}: ветки больше нет.",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "Остаётся на {source}: {reason}. «Сравнить все файлы…» может это перенести.",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "Остаётся на {source}: превышен лимит размера. «Сравнить все файлы…» может это перенести.",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "Остаётся на {source}: сначала обновите SpecWithCode на {target}.",
  "Stays on {source}: {reason}.": "Остаётся на {source}: {reason}.",
  "Stays on {source}: it could not be sent.": "Остаётся на {source}: не удалось отправить.",
  "Needs update · {version}": "Нужно обновление · {version}",
  "Needs update": "Нужно обновление",
  "This window can only read {machine}": "Это окно может только читать {machine}",
  "Not there": "Отсутствует",
  Repository: "Репозиторий",
  "Only on {machine} · Git does not carry these": "Только на {machine} · Git это не переносит",
  "Work that is only on {machine} could not be listed.":
    "Не удалось получить список работы, которая есть только на {machine}.",
  "Secrets and files left out on {machine}": "Секреты и пропущенные файлы на {machine}",
  "Will be sent": "Будет отправлено",
  "Send anyway": "Всё равно отправить",
  "1 more file is left out and not listed.": "Ещё 1 файл пропущен и не показан.",
  "{n} more files are left out and not listed.": "Ещё пропущено и не показано файлов: {n}.",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "Проверено по имени файла; неотслеживаемые файлы проверяются ещё и по первым 64 KB. Просмотрите список перед отправкой.",
  "Extras from {machine}": "Дополнения с {machine}",
  "The extras from {machine} were not sent.": "Дополнения с {machine} не отправлены.",
  "Uncommitted files in {repository}": "Незакоммиченные файлы в {repository}",
  "Compare all files…": "Сравнить все файлы…",
  "Sync {project}": "Синхронизировать {project}",
  "{project} is in sync on {source} and {machine}":
    "{project} синхронизирован на {source} и {machine}",
  "Sync {project}: {source} and {machine}": "Синхронизация {project}: {source} и {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "Сначала Git. Каждая машина делает fetch из удалённого репозитория и продвигается вперёд, только fast-forward. Ничего не перезаписывается и ничего не отправляется. Координатор остаётся на месте.",
  "Sync {machine} with": "Синхронизировать {machine} с",
  "Fetching on {source} and {machine}…": "Выполняется fetch на {source} и {machine}…",
  "Syncing {source} and {machine}…": "Синхронизация {source} и {machine}…",
  "Sending the ticked extras…": "Отправка отмеченных дополнений…",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "Показан только верхний репозиторий на {machine}: его папка превышает лимиты сканирования, поэтому вложенные репозитории пропущены.",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "Нечего продвигать или клонировать. Отметьте дополнение, чтобы отправить его.",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "Есть файлы вне Git на одной из сторон? «Сравнить все файлы…» медленный, но полный способ.",
  "Syncing…": "Синхронизация…",
  Sync: "Синхронизировать",
  "Same as {shown}": "Совпадает с {shown}",
  "Same as {shown} · as of {time}": "Совпадает с {shown} · по состоянию на {time}",
  "{k} of {n} repositories differ": "Различаются {k} из {n} репозиториев",
  "{k} of {n} repositories differ · as of {time}":
    "Различаются {k} из {n} репозиториев · по состоянию на {time}",
  "Not checked yet": "Ещё не проверено",
  "Sync…": "Синхронизировать…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "1 незакоммиченный файл остаётся на {source}: Git переносит только коммиты. Закоммитьте его или выберите «Скопировать всю папку» в разделе «Подробности».",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "Незакоммиченные файлы ({count}) остаются на {source}: Git переносит только коммиты. Закоммитьте их или выберите «Скопировать всю папку» в разделе «Подробности».",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "Незакоммиченная работа остаётся на {source}: Git переносит только коммиты. Закоммитьте её или выберите «Скопировать всю папку» в разделе «Подробности».",
  "Add to another machine": "Добавить на другую машину",
  "Add {project} to another machine": "Добавить {project} на другую машину",
  "Add {project} to {machine}": "Добавить {project} на {machine}",
  "Compare again": "Сравнить снова",
  "Continue on {target} anyway, on its older commits":
    "Всё равно продолжить на {target}, на его старых коммитах",
  "Continue the coordinator on another machine": "Продолжить работу координатора на другой машине",
  "Copy the whole folder from {source}": "Скопировать всю папку с {source}",
  "Download from GitHub (recommended)": "Скачать с GitHub (рекомендуется)",
  "Folder on {machine}": "Папка на {machine}",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "Сначала отправьте их или выберите «Скопировать всю папку» в разделе «Подробности». Перенос состоится в любом случае.",
  "Push these commits and continue the coordinator on {target}.":
    "Отправить эти коммиты и продолжить работу координатора на {target}.",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "Отправить эти коммиты в их удалённые репозитории и продолжить работу координатора на {target}.",
  "Sync again": "Синхронизировать снова",
  "Sync again…": "Синхронизировать снова…",
  "Run the same sync again": "Повторить ту же синхронизацию",
  "Sync again with secrets": "Синхронизировать снова с секретами",
  "Sync again before handing off the coordinator.":
    "Синхронизируйте снова, прежде чем передавать координатора.",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "«Синхронизировать снова» переносит изменения: сначала сравнивает и перемещает только изменённые файлы. «Всё равно продолжить на {target}» переносит координатора с этими различиями. «Отменить» возвращает папку на {target} в прежнее состояние.",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "Состояние этой копии не сохранено, поэтому перенести без них нельзя. «Синхронизировать снова» перенесёт их. Или оставьте координатора на {source}; копия на {target} остаётся.",
  "Add this project to another machine": "Добавить этот проект на другую машину",
  "{project} is on {machine}": "{project} есть на {machine}",
  "{project} is on {machine} (added {when})": "{project} есть на {machine} (добавлен {when})",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "На {machine} этот проект уже есть в {folder}. «Сравнить все файлы» сравнивает две папки и добавляет то, чего не хватает на {machine}. Координатор остаётся на {source}.",
  "The coordinator continues on {target}.": "Координатор продолжает работу на {target}.",
  "The coordinator stays here until you sync again.":
    "Координатор остаётся здесь, пока вы не синхронизируете снова.",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "Файлы на {target}, но {problem}. Синхронизируйте снова: сначала идёт сравнение, переносится только изменённое.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "Файлы на {target}, но {problem}. Вы выбрали «Всё равно продолжить на {target}», поэтому координатор перенесён с этими различиями.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "Файлы на {target}, но {problem}. Вы выбрали «Всё равно продолжить на {target}», поэтому координатор переносится с этими различиями.",
  "The source changed. Compare again.": "Источник изменился. Сравните снова.",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "Источник изменился. Можно скопировать файлы в сохранённом состоянии или сравнить снова, чтобы взять более новую работу.",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "{source} изменился после копирования. Синхронизируйте снова, прежде чем переносить координатора.",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "У этого проекта нет удалённого Git-репозитория, поэтому клонировать на {machine} неоткуда. Скопируйте туда его папку: меню машины > Добавить на другую машину… > Скопировать всю папку.",
  "{there} already has the coordinator, at {folder}.":
    "На {there} координатор уже есть, в {folder}.",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "На {there} этот проект уже есть, в {folder}. Синхронизация обновит его.",
  "{there} has this project in {n} folders. Pick one.":
    "Папок с этим проектом на {there}: {n}. Выберите одну.",
  "Sync finished for {project}: {source} and {machine}":
    "Синхронизация {project} завершена: {source} и {machine}",
  "Sync ended, and not everything was moved or sent. Each repository says why.":
    "Синхронизация завершена, но не всё продвинуто или отправлено. Причина указана у каждого репозитория.",
  'No answer came for this repository, and it may have moved. "Check again" shows where it stands':
    "По этому репозиторию ответ не пришёл, и он мог продвинуться. «Проверить снова» покажет, в каком он состоянии",
  "{machine} answered in a way this version does not read. Update SpecWithCode on this machine, then check again.":
    "{machine} ответила так, что эта версия не может прочитать ответ. Обновите SpecWithCode на этой машине и проверьте снова.",
  "Nothing was moved or sent.": "Ничего не продвинуто и не отправлено.",
  "The rest of the extras from {machine} were not sent.":
    "Остальные дополнения с {machine} не отправлены.",
  "Sent to {target}: {reason}.": "Отправлено на {target}: {reason}.",
  "Sent to {target}.": "Отправлено на {target}.",
  "Tick the uncommitted files of {repository} first.":
    "Сначала отметьте незакоммиченные файлы в {repository}.",
  "Send anyway only applies once that repository's uncommitted files are ticked.":
    "«Всё равно отправить» действует, только когда отмечены незакоммиченные файлы этого репозитория.",
  "{machine}: Needs update · {version}": "{machine}: Нужно обновление · {version}",
  "{machine}: Needs update": "{machine}: Нужно обновление",
  "{machine} could not sync: {reason}.": "На {machine} не удалось синхронизировать: {reason}.",
  "{machine} did not finish its part of the sync.":
    "{machine} не завершила свою часть синхронизации.",
  Repositories: "Репозитории",
  "Sync again brings {source}'s version over. Moving without these paths keeps {source}'s changes there and leaves the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "«Синхронизировать снова» переносит версию с {source}. Перенос без этих путей оставляет изменения на {source}, а копию на {target} как есть. Оставьте координатора на {source}, чтобы продолжить работу там; копия на {target} остаётся.",
  "Keep the coordinator on {source}": "Оставить координатора на {source}",
  "Move without this path": "Перенести без этого пути",
  "Move without these {n} paths": "Перенести без этих путей: {n}",
  "The files are on {target}, but {problem}.": "Файлы на {target}, но {problem}.",
  "The coordinator stays on {source}. The copied files stay on {target}.":
    "Координатор остаётся на {source}. Скопированные файлы остаются на {target}.",
  "The coordinator stays here until you choose below.":
    "Координатор остаётся здесь, пока вы не выберете ниже.",
  "Files are copied. Hand off the coordinator once work here is idle.":
    "Файлы скопированы. Передайте координатора, когда работа здесь остановится.",
  "Linking {target}…": "Связываем {target}…",
  "Linked: {source} can start work on {target}.":
    "Связано: {source} может запускать работу на {target}.",
  "Linked: {source} can start work on {target}, in {folder}.":
    "Связано: {source} может запускать работу на {target}, в {folder}.",
  "Not linked yet. {reason}": "Пока не связано. {reason}",
  "No uncommitted changes on {source}.": "На {source} нет незакоммиченных изменений.",
  "Repositories new there download from GitHub or their Git host; one with unpushed commits or stashes is copied whole. Uncommitted and ignored files, and secrets unless you leave them out, come from this machine.":
    "Репозитории, которых там нет, скачиваются с GitHub или их Git-хостинга; репозиторий с неотправленными коммитами или stash копируется целиком. Незакоммиченные и игнорируемые файлы, а также секреты, если вы их не исключите, берутся с этой машины.",
  "Also brings unpushed commits, local branches and stashes. Slower for large repositories.":
    "Переносит также неотправленные коммиты, локальные ветки и stash. Медленнее для больших репозиториев.",
  "Continues in a folder already saved there, which updates from origin. Always moves the coordinator there.":
    "Продолжает в папке, уже сохранённой там; она обновляется из origin. Всегда переносит координатора туда.",
  "Compare again before previewing this changed source.":
    "Сравните снова, прежде чем открывать предпросмотр этого изменившегося источника.",
  "The source changed. Compare again before copying.":
    "Источник изменился. Сравните снова перед копированием.",
  "Not moved: its state could not be read": "Не продвинуто: не удалось прочитать состояние",
  "Sent straight to {target} over the link between the machines, as a branch under {name}. Nothing goes to GitHub.":
    "Отправляется напрямую на {target} по связи между машинами, как ветка под {name}. В GitHub ничего не уходит.",
  "The branch it would arrive as is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "Ветка, под именем которой это пришло бы, извлечена на {target}, поэтому это пришло рядом как {name}. Чтобы использовать там, переключитесь на неё или слейте её.",
  "No answer came back. It may have arrived on {target}: check {target} before sending again.":
    "Ответ не пришёл. Возможно, это дошло до {target}: проверьте на {target}, прежде чем отправлять снова.",
  "Not sent.": "Не отправлено.",
  "{machine} sent extras and no answer came back. They may have arrived: check {target} before sending again.":
    "{machine} отправила дополнения, но ответ не пришёл. Возможно, они дошли: проверьте на {target}, прежде чем отправлять снова.",
  "Sync ended, and not every answer came back. Each line says what to check.":
    "Синхронизация завершена, но пришли не все ответы. В каждой строке указано, что проверить.",
  "A move to another machine is not finished. Finish or cancel it, then add a machine.":
    "Перенос на другую машину не завершён. Завершите или отмените его, затем добавьте машину.",
  "The copy on {machine} is already shared with other machines. Unlink it there first.":
    "Копия на {machine} уже используется совместно с другими машинами. Сначала отвяжите её там.",
  "The copy on {machine} does not hold its coordinator, so it cannot be the one that stays.":
    "У копии на {machine} нет своего координатора, поэтому остаться может не она.",
  "A coordinator handoff is in progress on {machine}. Finish or retry it first.":
    "На {machine} идёт передача координатора. Сначала завершите или повторите её.",
  "The project on {machine} is paused. Resume it first.":
    "Проект на {machine} приостановлен. Сначала возобновите его.",
  "The project on {machine} is archived. Restore it first.":
    "Проект на {machine} в архиве. Сначала восстановите его.",
  "Only code projects can be linked across machines.":
    "Связывать между машинами можно только проекты с кодом.",
  "The coordinator on {machine} is working. Let it finish or stop it, then link.":
    "Координатор на {machine} работает. Дождитесь окончания или остановите его, затем связывайте.",
  "Project notes differ on {machine}.": "Заметки проекта на {machine} отличаются.",
  "The copy's repository does not match the source.":
    "Репозиторий копии не совпадает с источником.",
  "some files changed on {source} while copying":
    "некоторые файлы изменились на {source} во время копирования",
  "the check of Root failed": "проверка корневого репозитория не прошла",
  "the check of {repository} failed": "проверка {repository} не прошла",
  "the checks of {n} repositories failed": "проверки {n} репозиториев не прошли",
  "A copy to {machine} is not finished. Finish or cancel it, then add another machine.":
    "Копирование на {machine} не завершено. Завершите или отмените его, затем добавьте другую машину.",
  "A copy is not finished. Finish or cancel it, then add another machine.":
    "Копирование не завершено. Завершите или отмените его, затем добавьте другую машину.",
  "Open the unfinished copy": "Открыть незавершённое копирование",
  "Finish handoff": "Завершить передачу",
  "Needs update: fetched only, not moved forward":
    "Нужно обновление: только получено, не сдвинуто вперёд",
  "Needs update: not cloned": "Нужно обновление: не клонировано",
  "Could not be read. Not moved": "Не удалось прочитать. Не сдвинуто",
  "May have moved forward: the result could not be read. Check it before working in it":
    "Возможно, сдвинуто вперёд: результат не удалось прочитать. Проверьте, прежде чем работать в нём",
  "{repository} could not be read: what is only on {machine} is not known":
    "Не удалось прочитать {repository}: что есть только на {machine}, неизвестно",
  "Which branches of {repository} are only on {machine} could not be read":
    "Не удалось прочитать, какие ветки {repository} есть только на {machine}",
  "Its state could not be read after the run": "После запуска его состояние не удалось прочитать",
  "Could not compare: a repository could not be read":
    "Не удалось сравнить: репозиторий не удалось прочитать",
  "Over your local network": "По локальной сети",
  "Over SpecWithCode Connect": "Через SpecWithCode Connect",
  "Partly over your local network, the rest over SpecWithCode Connect":
    "Частично по локальной сети, остальное через SpecWithCode Connect",
  "{machine}: fetching…": "{machine}: получение…",
  "{machine}: still fetching after {seconds} s…":
    "{machine}: всё ещё получает, прошло {seconds} с…",
  "{machine}: fetched": "{machine}: получено",
  "{machine}: did not finish": "{machine}: не завершил",
  "{machine}: not answering": "{machine}: не отвечает",
  "{machine} did not answer within {minutes} minutes, so its check was stopped. Check again when it is less busy.":
    "{machine} не ответил за {minutes} мин., поэтому его проверка остановлена. Проверьте снова, когда он будет меньше загружен.",
};
