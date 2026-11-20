import type { PhraseCatalog } from "../../phrases";

/** The Hand off dialog's plan: its groups and each machine's usage line (1390). */
export const handoffKo: PhraseCatalog = {
  "Queued ({n})": "대기열 ({n})",
  Queued: "대기열",
  "Not running with unsaved work ({n})": "실행 중이 아니며 저장하지 않은 작업 있음 ({n})",
  "Not running with unsaved work": "실행 중이 아니며 저장하지 않은 작업 있음",
  "Project folder work ({n})": "프로젝트 폴더 작업 ({n})",
  "Project folder work": "프로젝트 폴더 작업",
  "Different {provider} account · {n}% left": "다른 {provider} 계정 · {n}% 남음",
  "Same {provider} account as {source}: adds no usage":
    "{source}와 같은 {provider} 계정: 사용량이 늘지 않음",
  "Usage unknown": "사용량 알 수 없음",
};
