import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncKo: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Git으로 동기화하려면 {machine}의 SpecWithCode를 업데이트하세요. '모든 파일 비교…'는 지금도 사용할 수 있습니다.",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine}이(가) 오프라인입니다. 동기화하려면 두 컴퓨터가 모두 연결되어 있어야 합니다.",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "이 창은 {machine}을(를) 읽기만 할 수 있어 동기화할 수 없습니다. {machine}에서 SpecWithCode를 열거나 전체 접근 권한으로 연결하세요.",
  "{machine} does not have this project.": "{machine}에는 이 프로젝트가 없습니다.",
  "A personal project is not synced between machines.":
    "개인 프로젝트는 컴퓨터 간에 동기화되지 않습니다.",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "{machine}의 프로젝트 폴더는 Git 저장소가 아닙니다. '모든 파일 비교…'를 사용하세요.",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine}이(가) 응답하지 않았습니다. 연결을 확인한 뒤 다시 확인하세요.",
  "1 uncommitted file": "커밋하지 않은 파일 1개",
  "{n} uncommitted files": "커밋하지 않은 파일 {n}개",
  "Changed since the plan": "계획 이후 변경됨",
  "In use by {thread}": "{thread}에서 사용 중",
  "Moved forward 1 commit": "커밋 1개 앞으로 이동함",
  "Moved forward {n} commits": "커밋 {n}개 앞으로 이동함",
  "Moves forward 1 commit": "커밋 1개 앞으로 이동",
  "Moves forward {n} commits": "커밋 {n}개 앞으로 이동",
  "Cloned from {remote}": "{remote}에서 클론함",
  "Clones it from {remote}": "{remote}에서 클론",
  "1 commit not pushed (listed as an extra)": "푸시하지 않은 커밋 1개(추가 항목으로 표시)",
  "{n} commits not pushed (listed as an extra)": "푸시하지 않은 커밋 {n}개(추가 항목으로 표시)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "자체 커밋 1개가 있고 {b}개 뒤처져 있습니다. 이동 안 함",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "자체 커밋 {a}개가 있고 {b}개 뒤처져 있습니다. 이동 안 함",
  "Not moved forward: 1 uncommitted file": "이동 안 함: 커밋하지 않은 파일 1개",
  "Not moved forward: {n} uncommitted files": "이동 안 함: 커밋하지 않은 파일 {n}개",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "{branch}에 있습니다. 다른 컴퓨터의 브랜치는 원격에 있으면 fetch로 함께 받아오며, 체크아웃은 하지 않습니다",
  "Not on a branch. Not moved": "브랜치에 있지 않습니다. 이동 안 함",
  "No upstream. Its commits are listed as an extra":
    "upstream이 없습니다. 커밋은 추가 항목으로 표시됩니다",
  "Could not fetch: {reason}. The other repositories continue":
    "fetch하지 못했습니다: {reason}. 다른 저장소는 계속 진행됩니다",
  "Could not fetch. The other repositories continue":
    "fetch하지 못했습니다. 다른 저장소는 계속 진행됩니다",
  'Not in Git on a remote. Use "Compare all files…"':
    "원격의 Git에 없습니다. '모든 파일 비교…'를 사용하세요",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "fetch하지 않음: 이 저장소는 원격을 미러링하므로 fetch하면 브랜치가 이동합니다",
  "Sync did not change it: {reason}": "동기화로 변경되지 않음: {reason}",
  "Sync did not change it": "동기화로 변경되지 않음",
  "Follows {name}, which is not a branch of origin. Not moved":
    "{name}을(를) 추적하지만 origin의 브랜치가 아닙니다. 이동 안 함",
  "{upstream} is no longer on origin. Not moved":
    "{upstream}이(가) origin에 더 이상 없습니다. 이동 안 함",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "동기화로 변경되지 않음: 브랜치가 아직 있는지 origin에 확인하지 못했습니다",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "중단된 클론이 {path}을(를) 남겼고 삭제하지 못했습니다",
  "{path}: {reason}": "{path}: {reason}",
  "{path}: Sync did not change it": "{path}: 동기화로 변경되지 않음",
  "Not moved": "이동 안 함",
  "1 commit on {branch} that was never pushed": "{branch}에서 한 번도 푸시하지 않은 커밋 1개",
  "{n} commits on {branch} that were never pushed": "{branch}에서 한 번도 푸시하지 않은 커밋 {n}개",
  "1 branch that exists only on {machine}": "{machine}에만 있는 브랜치 1개",
  "{n} branches that exist only on {machine}": "{machine}에만 있는 브랜치 {n}개",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "컴퓨터 사이의 연결을 통해 {target}에 {name} 아래의 브랜치로 바로 보냅니다. GitHub에는 아무것도 보내지 않습니다.",
  "1 uncommitted file in {repository}": "{repository}의 커밋하지 않은 파일 1개",
  "{n} uncommitted files in {repository}": "{repository}의 커밋하지 않은 파일 {n}개",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "{target}에 폴더 속 파일이 아니라 {name} 아래의 브랜치로 도착합니다. {source}에서는 아무것도 커밋하지 않습니다.",
  "1 stash in {repository}": "{repository}의 stash 1개",
  "{n} stashes in {repository}": "{repository}의 stash {n}개",
  "Stashes stay. Compare all files… can bring them":
    "stash는 그대로 남습니다. 모든 파일 비교…로 가져올 수 있습니다",
  "1 more branch in {repository} is not listed":
    "{repository}의 브랜치 1개가 더 있지만 목록에 없습니다",
  "{n} more branches in {repository} are not listed":
    "{repository}의 브랜치 {n}개가 더 있지만 목록에 없습니다",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "이름으로 보아 비밀 파일입니다. {source}에 남습니다: 동기화는 비밀을 보내지 않습니다.",
  "Looks like a {kind}": "{kind}처럼 보입니다",
  "Looks like a secret": "비밀로 보입니다",
  "Includes 1 commit not pushed on {branch}": "{branch}의 푸시하지 않은 커밋 1개 포함",
  "Includes {n} commits not pushed on {branch}": "{branch}의 푸시하지 않은 커밋 {n}개 포함",
  "1 file left out": "제외된 파일 1개",
  "{n} files left out": "제외된 파일 {n}개",
  "{target} already has it as branch {name}.": "{target}에 이미 브랜치 {name}(으)로 있습니다.",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target}에 같은 이름의 다른 작업이 있어 그 옆에 {name}(으)로 도착했습니다. 그곳에서 사용하려면 체크아웃하거나 병합하세요.",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "{target}에 브랜치 {name}(으)로 있습니다. 그곳에서 사용하려면 체크아웃하거나 병합하세요.",
  "Nothing to send: {target} would get no new work.":
    "보낼 것이 없습니다: {target}에 새 작업이 생기지 않습니다.",
  "Stays on {source}: the branch is no longer there.":
    "{source}에 남습니다: 브랜치가 더 이상 없습니다.",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "{source}에 남습니다: {reason}. '모든 파일 비교…'로 가져올 수 있습니다.",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "{source}에 남습니다: 크기 제한을 넘습니다. '모든 파일 비교…'로 가져올 수 있습니다.",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "{source}에 남습니다: 먼저 {target}의 SpecWithCode를 업데이트하세요.",
  "Stays on {source}: {target} could not be reached.":
    "{source}에 남습니다: {target}에 연결할 수 없었습니다.",
  "Stays on {source}: {reason}.": "{source}에 남습니다: {reason}.",
  "Stays on {source}: it could not be sent.": "{source}에 남습니다: 보낼 수 없었습니다.",
  "Needs update · {version}": "업데이트 필요 · {version}",
  "Needs update": "업데이트 필요",
  "This window can only read {machine}": "이 창은 {machine}을(를) 읽기만 할 수 있습니다",
  "Not there": "없음",
  Repository: "저장소",
  "Only on {machine} · Git does not carry these": "{machine}에만 있음 · Git이 옮기지 않는 항목",
  "Work that is only on {machine} could not be listed.":
    "{machine}에만 있는 작업을 나열하지 못했습니다.",
  "Secrets and files left out on {machine}": "{machine}의 비밀과 제외된 파일",
  "Will be sent": "보낼 예정",
  "Send anyway": "그래도 보내기",
  "1 more file is left out and not listed.": "제외되어 목록에 없는 파일이 1개 더 있습니다.",
  "{n} more files are left out and not listed.": "제외되어 목록에 없는 파일이 {n}개 더 있습니다.",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "파일 이름으로 확인하고, 추적하지 않는 파일은 처음 64 KB로 확인합니다. 보내기 전에 목록을 살펴보세요.",
  "Extras from {machine}": "{machine}의 추가 항목",
  "The extras from {machine} were not sent.": "{machine}의 추가 항목을 보내지 않았습니다.",
  "Uncommitted files in {repository}": "{repository}의 커밋하지 않은 파일",
  "Compare all files…": "모든 파일 비교…",
  "Sync {project}": "{project} 동기화",
  "{project} is in sync on {source} and {machine}":
    "{project}이(가) {source}와(과) {machine}에서 동기화되어 있습니다",
  "Sync {project}: {source} and {machine}": "{project} 동기화: {source} 및 {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "Git이 먼저입니다. 각 컴퓨터가 원격에서 fetch한 뒤 fast-forward로만 앞으로 이동합니다. 아무것도 덮어쓰지 않고 푸시하지도 않습니다. 코디네이터는 그대로 있습니다.",
  "Sync {machine} with": "{machine}과(와) 동기화할 컴퓨터",
  "Fetching on {source} and {machine}…": "{source}와(과) {machine}에서 fetch하는 중…",
  "Syncing {source} and {machine}…": "{source}와(과) {machine} 동기화 중…",
  "Sending the ticked extras…": "체크한 추가 항목을 보내는 중…",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "{machine}의 최상위 저장소만 표시됩니다: 폴더가 검사 한도를 넘어 그 안의 저장소는 건너뜁니다.",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "앞으로 이동하거나 클론할 것이 없습니다. 보낼 추가 항목을 체크하세요.",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "어느 쪽이든 Git 밖에 있는 파일이 있나요? 모든 파일 비교…는 느리지만 빠짐없는 방법입니다.",
  "Syncing…": "동기화 중…",
  Sync: "동기화",
  "Same as {shown}": "{shown}과(와) 같음",
  "Same as {shown} · as of {time}": "{shown}과(와) 같음 · {time} 기준",
  "{k} of {n} repositories differ": "저장소 {n}개 중 {k}개 다름",
  "{k} of {n} repositories differ · as of {time}": "저장소 {n}개 중 {k}개 다름 · {time} 기준",
  "Not checked yet": "아직 확인 안 됨",
  "Sync…": "동기화…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "커밋하지 않은 파일 1개는 {source}에 남습니다: Git은 커밋만 옮깁니다. 커밋하거나 '세부 정보'에서 '폴더 전체 복사'를 선택하세요.",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "커밋하지 않은 파일 {count}개는 {source}에 남습니다: Git은 커밋만 옮깁니다. 커밋하거나 '세부 정보'에서 '폴더 전체 복사'를 선택하세요.",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "커밋하지 않은 작업은 {source}에 남습니다: Git은 커밋만 옮깁니다. 커밋하거나 '세부 정보'에서 '폴더 전체 복사'를 선택하세요.",
  "Add to another machine": "다른 컴퓨터에 추가",
  "Add {project} to another machine": "다른 컴퓨터에 {project} 추가",
  "Add {project} to {machine}": "{machine}에 {project} 추가",
  "Compare again": "다시 비교",
  "Continue on {target} anyway, on its older commits": "그래도 {target}에서 계속, 이전 커밋 상태로",
  "Continue the coordinator on another machine": "다른 컴퓨터에서 코디네이터 이어 가기",
  "Copy the whole folder from {source}": "{source}에서 폴더 전체 복사",
  "Download from GitHub (recommended)": "GitHub에서 다운로드(권장)",
  "Folder on {machine}": "{machine}의 폴더",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "먼저 푸시하거나 '세부 정보'에서 '폴더 전체 복사'를 선택하세요. 어느 쪽이든 이동은 진행됩니다.",
  "Push these commits and continue the coordinator on {target}.":
    "이 커밋을 푸시하고 {target}에서 코디네이터를 이어 갑니다.",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "이 커밋을 각 원격에 푸시하고 {target}에서 코디네이터를 이어 갑니다.",
  "Sync again": "다시 동기화",
  "Sync again…": "다시 동기화…",
  "Run the same sync again": "같은 동기화 다시 실행",
  "Sync again with secrets": "비밀 포함해 다시 동기화",
  "Sync again before handing off the coordinator.": "코디네이터를 넘기기 전에 다시 동기화하세요.",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "'다시 동기화'는 바뀐 내용을 가져옵니다. 먼저 비교하고 바뀐 파일만 옮깁니다. '그래도 {target}에서 계속'은 이 차이를 둔 채 코디네이터를 옮깁니다. '실행 취소'는 {target}의 폴더를 원래대로 되돌립니다.",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "이 사본은 캡처되지 않아 제외하고 이동할 수 없습니다. '다시 동기화'로 가져올 수 있습니다. 또는 코디네이터를 {source}에 두세요. {target}의 사본은 남습니다.",
  "Add this project to another machine": "이 프로젝트를 다른 컴퓨터에 추가",
  "{project} is on {machine}": "{project}이(가) {machine}에 있습니다",
  "{project} is on {machine} (added {when})": "{project}이(가) {machine}에 있습니다({when} 추가)",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine}에는 이미 {folder}에 이 프로젝트가 있습니다. '모든 파일 비교'는 두 폴더를 비교해 {machine}에 없는 것을 추가합니다. 코디네이터는 {source}에 남습니다.",
  "The coordinator continues on {target}.": "코디네이터가 {target}에서 이어집니다.",
  "The coordinator stays here until you sync again.":
    "다시 동기화할 때까지 코디네이터는 여기에 남습니다.",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "파일은 {target}에 있지만 {problem}. '다시 동기화'는 먼저 비교하고 바뀐 것만 옮깁니다.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "파일은 {target}에 있지만 {problem}. '그래도 {target}에서 계속'을 선택했으므로 코디네이터가 이 차이를 둔 채 이동했습니다.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "파일은 {target}에 있지만 {problem}. '그래도 {target}에서 계속'을 선택했으므로 코디네이터가 이 차이를 둔 채 이동합니다.",
  "The source changed. Compare again.": "원본이 바뀌었습니다. '다시 비교'하세요.",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "원본이 바뀌었습니다. 캡처한 파일을 그대로 복사하거나, 더 새로운 작업을 위해 다시 비교할 수 있습니다.",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "복사한 뒤 {source}이(가) 바뀌었습니다. 코디네이터를 옮기기 전에 다시 동기화하세요.",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "이 프로젝트에는 Git 원격이 없어 {machine}이(가) 클론할 곳이 없습니다. 대신 폴더를 그곳에 복사하세요: 컴퓨터 메뉴 > 다른 컴퓨터에 추가… > 폴더 전체 복사.",
  "{there} already has the coordinator, at {folder}.":
    "{there}에는 이미 {folder}에 코디네이터가 있습니다.",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there}에는 이미 {folder}에 이 프로젝트가 있습니다. 동기화하면 최신 상태가 됩니다.",
  "{there} has this project in {n} folders. Pick one.":
    "{there}의 폴더 {n}개에 이 프로젝트가 있습니다. 하나를 선택하세요.",
  "Sync finished for {project}: {source} and {machine}":
    "{project} 동기화 종료: {source}와(과) {machine}",
  "Sync ended, and not everything was moved or sent. Each repository says why.":
    "동기화가 끝났지만 이동하거나 보내지 못한 항목이 있습니다. 이유는 각 저장소에 표시됩니다.",
  'No answer came for this repository, and it may have moved. "Check again" shows where it stands':
    "이 저장소에 대한 응답이 오지 않았으며 이동되었을 수 있습니다. '다시 확인'으로 현재 상태를 볼 수 있습니다",
  "{machine} answered in a way this version does not read. Update SpecWithCode on this machine, then check again.":
    "{machine}이(가) 이 버전에서 읽을 수 없는 형식으로 응답했습니다. 이 컴퓨터의 SpecWithCode를 업데이트한 뒤 다시 확인하세요.",
  "Nothing was moved or sent.": "이동하거나 보낸 것이 없습니다.",
  "The rest of the extras from {machine} were not sent.":
    "{machine}의 나머지 추가 항목은 보내지 않았습니다.",
  "Sent to {target}: {reason}.": "{target}(으)로 보냄: {reason}.",
  "Sent to {target}.": "{target}(으)로 보냈습니다.",
  "Tick the uncommitted files of {repository} first.":
    "먼저 {repository}의 커밋하지 않은 파일을 체크하세요.",
  "Send anyway only applies once that repository's uncommitted files are ticked.":
    "그래도 보내기는 해당 저장소의 커밋하지 않은 파일을 체크한 경우에만 적용됩니다.",
  "{machine}: Needs update · {version}": "{machine}: 업데이트 필요 · {version}",
  "{machine}: Needs update": "{machine}: 업데이트 필요",
  "{machine} could not sync: {reason}.": "{machine}에서 동기화하지 못했습니다: {reason}.",
  "{machine} did not finish its part of the sync.":
    "{machine}이(가) 동기화에서 맡은 작업을 끝내지 못했습니다.",
  Repositories: "저장소",
  "Sync again brings {source}'s version over. Moving without these paths keeps {source}'s changes there and leaves the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "'다시 동기화'는 {source}의 버전을 가져옵니다. 이 경로들을 제외하고 이동하면 {source}의 변경 사항은 그곳에 남고 {target}의 사본은 그대로 유지됩니다. 그곳에서 계속 작업하려면 코디네이터를 {source}에 두세요. {target}의 사본은 남습니다.",
  "Keep the coordinator on {source}": "코디네이터를 {source}에 유지",
  "Move without this path": "이 경로를 제외하고 이동",
  "Move without these {n} paths": "이 경로 {n}개를 제외하고 이동",
  "The files are on {target}, but {problem}.": "파일은 {target}에 있지만 {problem}.",
  "The coordinator stays on {source}. The copied files stay on {target}.":
    "코디네이터는 {source}에 남습니다. 복사한 파일은 {target}에 남습니다.",
  "The coordinator stays here until you choose below.":
    "아래에서 선택할 때까지 코디네이터는 여기에 남습니다.",
  "Files are copied. Hand off the coordinator once work here is idle.":
    "파일을 복사했습니다. 이곳의 작업이 한가해지면 코디네이터를 넘기세요.",
  "Linking {target}…": "{target} 연결 중…",
  "Linked: {source} can start work on {target}.":
    "연결됨: {source}에서 {target}의 작업을 시작할 수 있습니다.",
  "Linked: {source} can start work on {target}, in {folder}.":
    "연결됨: {source}에서 {target}의 {folder}에 있는 작업을 시작할 수 있습니다.",
  "Not linked yet. {reason}": "아직 연결되지 않았습니다. {reason}",
  "No uncommitted changes on {source}.": "{source}에 커밋하지 않은 변경 사항이 없습니다.",
  "Repositories new there download from GitHub or their Git host; one with unpushed commits or stashes is copied whole. Uncommitted and ignored files, and secrets unless you leave them out, come from this machine.":
    "그곳에 없는 저장소는 GitHub 또는 Git 호스트에서 다운로드합니다. 푸시하지 않은 커밋이나 스태시가 있는 저장소는 통째로 복사합니다. 커밋하지 않은 파일과 무시된 파일, 그리고 제외하지 않는 한 비밀도 이 컴퓨터에서 가져옵니다.",
  "Also brings unpushed commits, local branches and stashes. Slower for large repositories.":
    "푸시하지 않은 커밋, 로컬 브랜치, 스태시도 가져옵니다. 큰 저장소에서는 더 느립니다.",
  "Continues in a folder already saved there, which updates from origin. Always moves the coordinator there.":
    "그곳에 이미 저장된 폴더에서 계속하며, 폴더는 origin에서 업데이트됩니다. 코디네이터는 항상 그곳으로 이동합니다.",
  "Compare again before previewing this changed source.":
    "변경된 이 원본을 미리 보기 전에 다시 비교하세요.",
  "The source changed. Compare again before copying.":
    "원본이 변경되었습니다. 복사하기 전에 다시 비교하세요.",
  "Not moved: its state could not be read": "이동 안 함: 상태를 읽을 수 없습니다",
  "Sent straight to {target} over the link between the machines, as a branch under {name}. Nothing goes to GitHub.":
    "컴퓨터 사이의 연결을 통해 {target}에 {name} 아래의 브랜치로 바로 보냅니다. GitHub에는 아무것도 보내지 않습니다.",
  "The branch it would arrive as is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "도착할 브랜치가 {target}에서 체크아웃되어 있어 그 옆에 {name}(으)로 도착했습니다. 그곳에서 사용하려면 체크아웃하거나 병합하세요.",
  "No answer came back. It may have arrived on {target}: check {target} before sending again.":
    "응답이 돌아오지 않았습니다. {target}에 도착했을 수 있습니다. 다시 보내기 전에 {target}에서 확인하세요.",
  "Not sent.": "보내지 않았습니다.",
  "{machine} sent extras and no answer came back. They may have arrived: check {target} before sending again.":
    "{machine}에서 추가 항목을 보냈지만 응답이 돌아오지 않았습니다. 도착했을 수 있습니다. 다시 보내기 전에 {target}에서 확인하세요.",
  "Sync ended, and not every answer came back. Each line says what to check.":
    "동기화가 끝났지만 돌아오지 않은 응답이 있습니다. 확인할 내용은 각 줄에 표시됩니다.",
  "A move to another machine is not finished. Finish or cancel it, then add a machine.":
    "다른 컴퓨터로의 이동이 끝나지 않았습니다. 완료하거나 취소한 다음 컴퓨터를 추가하세요.",
  "The copy on {machine} is already shared with other machines. Unlink it there first.":
    "{machine}의 사본은 이미 다른 컴퓨터와 공유되어 있습니다. 먼저 그곳에서 연결을 해제하세요.",
  "The copy on {machine} does not hold its coordinator, so it cannot be the one that stays.":
    "{machine}의 사본에는 코디네이터가 없어 남는 쪽이 될 수 없습니다.",
  "A coordinator handoff is in progress on {machine}. Finish or retry it first.":
    "{machine}에서 코디네이터 인계가 진행 중입니다. 먼저 완료하거나 다시 시도하세요.",
  "The project on {machine} is paused. Resume it first.":
    "{machine}의 프로젝트가 일시 중지되어 있습니다. 먼저 다시 시작하세요.",
  "The project on {machine} is archived. Restore it first.":
    "{machine}의 프로젝트가 보관되어 있습니다. 먼저 복원하세요.",
  "Only code projects can be linked across machines.":
    "코드 프로젝트만 컴퓨터 간에 연결할 수 있습니다.",
  "The coordinator on {machine} is working. Let it finish or stop it, then link.":
    "{machine}의 코디네이터가 작업 중입니다. 끝나기를 기다리거나 중지한 다음 연결하세요.",
  "Project notes differ on {machine}.": "{machine}의 프로젝트 노트가 다릅니다.",
  "The copy's repository does not match the source.": "사본의 저장소가 원본과 일치하지 않습니다.",
  "some files changed on {source} while copying":
    "복사하는 동안 {source}에서 일부 파일이 변경되었습니다",
  "the check of Root failed": "루트 저장소 검사에 실패했습니다",
  "the check of {repository} failed": "{repository} 검사에 실패했습니다",
  "the checks of {n} repositories failed": "저장소 {n}개의 검사에 실패했습니다",
};
