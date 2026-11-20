import type { PhraseCatalog } from "../../phrases";

/** Messages between the coordinators of linked machines (1427 AC-18, AC-19). */
export const coordinatorMessagesKo: PhraseCatalog = {
  "From {machine}'s coordinator": "{machine}의 코디네이터에서",
  "To {machine}'s coordinator": "{machine}의 코디네이터에게",
  "On {machine}: {step}": "{machine}에서: {step}",
  "From {machine}'s coordinator · {project}": "{machine}의 코디네이터에서 · {project}",
  "{count} more messages": "메시지 {count}개 더",
  "Sent {count} times": "{count}번 보냄",
  "Open {machine}'s coordinator": "{machine}의 코디네이터 열기",
  "Messages between coordinators": "코디네이터 간 메시지",
  "Show the whole conversation": "전체 대화 보기",
  "No messages between coordinators yet.": "아직 코디네이터 간 메시지가 없습니다.",
  Queued: "대기 중",
  Delivered: "전달됨",
  Read: "읽음",
  Answered: "답변함",
  Arriving: "도착 중",
  "Waiting: this project is paused": "대기: 이 프로젝트는 일시 중지됨",
  "Not delivered: {machine} was offline for 24 hours":
    "전달 안 됨: {machine}이(가) 24시간 동안 오프라인이었습니다",
  "{machine}'s access was revoked": "{machine}의 액세스가 취소되었습니다",
  Problem: "문제",
  Finding: "발견 사항",
  Request: "요청",
  Reply: "답장",
  "Thread on {machine}": "{machine}의 스레드",
  "Report on {machine}": "{machine}의 보고서",
  "File on {machine}": "{machine}의 파일",
  "Pull request": "풀 리퀘스트",
};
