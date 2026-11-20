import type { PhraseCatalog } from "../../phrases";

/** The Hand off dialog's plan: its groups and each machine's usage line (1390). */
export const handoffEs: PhraseCatalog = {
  "Queued ({n})": "En cola ({n})",
  Queued: "En cola",
  "Not running with unsaved work ({n})": "Sin ejecutar, con trabajo sin guardar ({n})",
  "Not running with unsaved work": "Sin ejecutar, con trabajo sin guardar",
  "Project folder work ({n})": "Trabajo en la carpeta del proyecto ({n})",
  "Project folder work": "Trabajo en la carpeta del proyecto",
  "Different {provider} account · {n}% left": "Otra cuenta de {provider} · queda un {n} %",
  "Same {provider} account as {source}: adds no usage":
    "La misma cuenta de {provider} que {source}: no añade uso",
  "Usage unknown": "Uso desconocido",
};
