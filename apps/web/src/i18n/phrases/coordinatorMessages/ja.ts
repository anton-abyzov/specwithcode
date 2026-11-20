import type { PhraseCatalog } from "../../phrases";

/** Messages between the coordinators of linked machines (1427 AC-18, AC-19). */
export const coordinatorMessagesJa: PhraseCatalog = {
  "From {machine}'s coordinator": "{machine} のコーディネーターから",
  "To {machine}'s coordinator": "{machine} のコーディネーターへ",
  "On {machine}: {step}": "{machine} で: {step}",
  "From {machine}'s coordinator · {project}": "{machine} のコーディネーターから · {project}",
  "{count} more messages": "ほか {count} 件のメッセージ",
  "Sent {count} times": "{count} 回送信",
  "Open {machine}'s coordinator": "{machine} のコーディネーターを開く",
  "Messages between coordinators": "コーディネーター間のメッセージ",
  "Show the whole conversation": "会話全体を表示",
  "No messages between coordinators yet.": "コーディネーター間のメッセージはまだありません。",
  Queued: "キュー待ち",
  Delivered: "配信済み",
  Read: "既読",
  Answered: "返信済み",
  Arriving: "到着中",
  "Waiting: this project is paused": "待機中: このプロジェクトは一時停止中です",
  "Not delivered: {machine} was offline for 24 hours":
    "未配信: {machine} が 24 時間オフラインでした",
  "{machine}'s access was revoked": "{machine} のアクセスが取り消されました",
  Problem: "問題",
  Finding: "所見",
  Request: "依頼",
  Reply: "返信",
  "Thread on {machine}": "{machine} のスレッド",
  "Report on {machine}": "{machine} のレポート",
  "File on {machine}": "{machine} のファイル",
  "Pull request": "プルリクエスト",
  "Open coordinator": "コーディネーターを開く",
  "{status} when sent": "送信時: {status}",
};
