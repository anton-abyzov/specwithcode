import type { PhraseCatalog } from "../../phrases";

/** Messages between the coordinators of linked machines (1427 AC-18, AC-19). */
export const coordinatorMessagesRu: PhraseCatalog = {
  "From {machine}'s coordinator": "От координатора {machine}",
  "To {machine}'s coordinator": "Координатору {machine}",
  "On {machine}: {step}": "На {machine}: {step}",
  "From {machine}'s coordinator · {project}": "От координатора {machine} · {project}",
  "{count} more messages": "Ещё сообщений: {count}",
  "Sent {count} times": "Отправлено раз: {count}",
  "Open {machine}'s coordinator": "Открыть координатора {machine}",
  "Messages between coordinators": "Сообщения между координаторами",
  "Show the whole conversation": "Показать весь разговор",
  "No messages between coordinators yet.": "Сообщений между координаторами пока нет.",
  Queued: "В очереди",
  Delivered: "Доставлено",
  Read: "Прочитано",
  Answered: "Есть ответ",
  Arriving: "Доставляется",
  "Waiting: this project is paused": "Ждёт: проект на паузе",
  "Not delivered: {machine} was offline for 24 hours":
    "Не доставлено: {machine} был офлайн 24 часа",
  "{machine}'s access was revoked": "Доступ {machine} отозван",
  Problem: "Проблема",
  Finding: "Находка",
  Request: "Запрос",
  Reply: "Ответ",
  "Thread on {machine}": "Тред на {machine}",
  "Report on {machine}": "Отчёт на {machine}",
  "File on {machine}": "Файл на {machine}",
  "Pull request": "Pull request",
  "Open coordinator": "Открыть координатора",
  "{status} when sent": "{status} при отправке",
};
