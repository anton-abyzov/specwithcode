import type { PhraseCatalog } from "../../phrases";

/** The Hand off dialog's plan: its groups and each machine's usage line (1390). */
export const handoffPt: PhraseCatalog = {
  "Queued ({n})": "Na fila ({n})",
  Queued: "Na fila",
  "Not running with unsaved work ({n})": "Parado, com trabalho não salvo ({n})",
  "Not running with unsaved work": "Parado, com trabalho não salvo",
  "Project folder work ({n})": "Trabalho na pasta do projeto ({n})",
  "Project folder work": "Trabalho na pasta do projeto",
  "Different {provider} account · {n}% left": "Outra conta do {provider} · {n}% restante",
  "Same {provider} account as {source}: adds no usage":
    "Mesma conta do {provider} que {source}: não acrescenta uso",
  "Usage unknown": "Uso desconhecido",
};
