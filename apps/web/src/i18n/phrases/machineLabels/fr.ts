import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsFr: PhraseCatalog = {
  "Window on {machine}":
    "Fenêtre sur {machine}",
  "{machine}'s coordinator":
    "Coordinateur de {machine}",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "Affiche le coordinateur de {machine}. Cette fenêtre tourne sur {window}.",
  "this window":
    "cette fenêtre",
  "Coordinator on {machine} · {model}":
    "Coordinateur sur {machine} · {model}",
  "To {machine}'s coordinator":
    "Au coordinateur de {machine}",
  "Restart {machine} to update":
    "Redémarrer {machine} pour mettre à jour",
  "Update {machine} now":
    "Mettre à jour {machine} maintenant",
  "Retry update on {machine}":
    "Réessayer la mise à jour sur {machine}",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} n’est pas connectée. Les modifications seront possibles une fois reconnectée.",
  "{machine} · this window":
    "{machine} · cette fenêtre",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} rejoint {project}. Chaque machine garde son propre coordinateur : la liaison ne déplace rien.",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "Chaque machine garde son propre coordinateur. Pour continuer la conversation de {main} sur {machine}, utilisez Continuer ici après la liaison.",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "Lier {machine} à ce projet. {machine} abandonne son propre objectif et ses instructions : il suit désormais ceux de ce projet. Chaque machine garde son propre coordinateur, et les workers de {machine} continuent de tourner. Les fichiers ne sont pas copiés.",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} est un seul projet sur {main} et {machine}. Chaque machine garde son propre coordinateur.",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "Chaque machine garde son propre coordinateur, et les workers de {machine} continuent de tourner. Pour envoyer du travail à {machine} depuis {main}, choisissez Autoriser sur la carte de {machine} dans Réglages > Machines.",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "En faire un seul projet. Chaque machine garde son propre coordinateur, et les workers des deux continuent de tourner. Les fichiers ne sont pas copiés.",
};
