import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsKo: PhraseCatalog = {
  "Window on {machine}":
    "창: {machine}",
  "{machine}'s coordinator":
    "{machine}의 코디네이터",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "{machine}의 코디네이터를 보고 있습니다. 이 창은 {window}에서 실행됩니다.",
  "this window":
    "이 창",
  "Coordinator on {machine} · {model}":
    "{machine}의 코디네이터 · {model}",
  "To {machine}'s coordinator":
    "{machine}의 코디네이터에게",
  "Restart {machine} to update":
    "{machine} 다시 시작해 업데이트",
  "Update {machine} now":
    "지금 {machine} 업데이트",
  "Retry update on {machine}":
    "{machine}에서 업데이트 다시 시도",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine}이(가) 연결되어 있지 않습니다. 다시 연결되면 변경할 수 있습니다.",
  "{machine} · this window":
    "{machine} · 이 창",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine}이(가) {project}에 합류합니다. 각 머신은 자체 코디네이터를 유지합니다. 연결해도 아무것도 옮겨지지 않습니다.",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "각 머신은 자체 코디네이터를 유지합니다. {main}의 대화를 {machine}에서 이어 가려면 연결한 뒤 여기서 계속을 사용하세요.",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "{machine}을(를) 이 프로젝트에 연결합니다. {machine}은(는) 자체 목표와 지침을 포기하고 이제부터 이 프로젝트의 것을 따릅니다. 각 머신은 자체 코디네이터를 유지하며, {machine}의 워커는 계속 실행됩니다. 파일은 복사되지 않습니다.",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project}은(는) {main}과(와) {machine}에서 하나의 프로젝트입니다. 각 머신은 자체 코디네이터를 유지합니다.",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "각 머신은 자체 코디네이터를 유지하며, {machine}의 워커는 계속 실행됩니다. {main}에서 {machine}(으)로 작업을 보내려면 설정 > 머신에서 {machine} 카드의 허용을 선택하세요.",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "하나의 프로젝트로 만듭니다. 각 머신은 자체 코디네이터를 유지하며, 양쪽의 워커는 계속 실행됩니다. 파일은 복사되지 않습니다.",
};
