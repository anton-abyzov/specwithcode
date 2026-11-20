import type { PhraseCatalog } from "../../phrases";

/** The Hand off dialog's plan: its groups and each machine's usage line (1390). */
export const handoffRu: PhraseCatalog = {
  "Queued ({n})": "В очереди ({n})",
  Queued: "В очереди",
  "Not running with unsaved work ({n})": "Не выполняется, есть несохранённая работа ({n})",
  "Not running with unsaved work": "Не выполняется, есть несохранённая работа",
  "Project folder work ({n})": "Работа в папке проекта ({n})",
  "Project folder work": "Работа в папке проекта",
  "Different {provider} account · {n}% left": "Другой аккаунт {provider} · осталось {n}%",
  "Same {provider} account as {source}: adds no usage":
    "Тот же аккаунт {provider}, что и на {source}: лимит не добавится",
  "Usage unknown": "Использование неизвестно",
};
