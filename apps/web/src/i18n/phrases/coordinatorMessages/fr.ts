import type { PhraseCatalog } from "../../phrases";

/** Messages between the coordinators of linked machines (1427 AC-18, AC-19). */
export const coordinatorMessagesFr: PhraseCatalog = {
  "From {machine}'s coordinator": "Du coordinateur de {machine}",
  "To {machine}'s coordinator": "Au coordinateur de {machine}",
  "On {machine}: {step}": "Sur {machine} : {step}",
  "From {machine}'s coordinator · {project}": "Du coordinateur de {machine} · {project}",
  "{count} more messages": "{count} messages de plus",
  "Sent {count} times": "Envoyé {count} fois",
  "Open {machine}'s coordinator": "Ouvrir le coordinateur de {machine}",
  "Messages between coordinators": "Messages entre coordinateurs",
  "Show the whole conversation": "Afficher toute la conversation",
  "No messages between coordinators yet.": "Aucun message entre coordinateurs pour l’instant.",
  Queued: "En file d’attente",
  Delivered: "Remis",
  Read: "Lu",
  Answered: "Répondu",
  Arriving: "En cours d’arrivée",
  "Waiting: this project is paused": "En attente : ce projet est en pause",
  "Not delivered: {machine} was offline for 24 hours":
    "Non remis : {machine} était hors ligne depuis 24 heures",
  "{machine}'s access was revoked": "L’accès de {machine} a été révoqué",
  Problem: "Problème",
  Finding: "Constat",
  Request: "Demande",
  Reply: "Réponse",
  "Thread on {machine}": "Fil sur {machine}",
  "Report on {machine}": "Rapport sur {machine}",
  "File on {machine}": "Fichier sur {machine}",
  "Pull request": "Pull request",
};
