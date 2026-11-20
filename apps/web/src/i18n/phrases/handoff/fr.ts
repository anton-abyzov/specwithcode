import type { PhraseCatalog } from "../../phrases";

/** The Hand off dialog's plan: its groups and each machine's usage line (1390). */
export const handoffFr: PhraseCatalog = {
  "Queued ({n})": "En file d’attente ({n})",
  Queued: "En file d’attente",
  "Not running with unsaved work ({n})": "À l’arrêt, avec du travail non enregistré ({n})",
  "Not running with unsaved work": "À l’arrêt, avec du travail non enregistré",
  "Project folder work ({n})": "Travail dans le dossier du projet ({n})",
  "Project folder work": "Travail dans le dossier du projet",
  "Different {provider} account · {n}% left": "Autre compte {provider} · {n} % restants",
  "Same {provider} account as {source}: adds no usage":
    "Même compte {provider} que {source} : n’ajoute aucune utilisation",
  "Usage unknown": "Utilisation inconnue",
};
