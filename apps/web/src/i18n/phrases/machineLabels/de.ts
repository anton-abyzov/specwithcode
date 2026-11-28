import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsDe: PhraseCatalog = {
  "Window on {machine}": "Fenster auf {machine}",
  "{machine}'s coordinator": "Koordinator von {machine}",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "Zeigt den Koordinator von {machine}. Dieses Fenster läuft auf {window}.",
  "this window": "dieses Fenster",
  "Coordinator on {machine} · {model}": "Koordinator auf {machine} · {model}",
  "To {machine}'s coordinator": "An den Koordinator von {machine}",
  "Restart {machine} to update": "{machine} zum Aktualisieren neu starten",
  "Update {machine} now": "{machine} jetzt aktualisieren",
  "Retry update on {machine}": "Aktualisierung auf {machine} wiederholen",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} ist nicht verbunden. Änderungen sind möglich, sobald die Verbindung wieder steht.",
  "{machine} · this window": "{machine} · dieses Fenster",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} tritt {project} bei. Jede Maschine behält ihren eigenen Koordinator: Verknüpfen verschiebt nichts.",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "Jede Maschine behält ihren eigenen Koordinator. Um das Gespräch von {main} auf {machine} fortzusetzen, nutze nach dem Verknüpfen „Hier fortsetzen“.",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "{machine} mit diesem Projekt verknüpfen. {machine} gibt sein eigenes Ziel und seine Anweisungen auf: Ab jetzt gelten die dieses Projekts. Jede Maschine behält ihren eigenen Koordinator, und die Worker auf {machine} laufen weiter. Dateien werden nicht kopiert.",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} ist ein Projekt auf {main} und {machine}. Jede Maschine behält ihren eigenen Koordinator.",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "Jede Maschine behält ihren eigenen Koordinator, und die Worker auf {machine} laufen weiter. Um {machine} von {main} aus Arbeit zu schicken, wähle „Erlauben“ auf der Karte von {machine} unter Einstellungen > Rechner.",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "Zu einem Projekt machen. Jede Maschine behält ihren eigenen Koordinator, und die Worker auf beiden laufen weiter. Dateien werden nicht kopiert.",
  // Why the machine menu cannot open a machine (1517).
  "Could not connect to {machine}. Choose Connect… to try again.":
    "Verbindung zu {machine} fehlgeschlagen. Wähle „Verbinden…“, um es erneut zu versuchen.",
  "Waiting for approval: type {code} on {machine} or on a device it allows":
    "Wartet auf Freigabe: Gib {code} auf {machine} oder auf einem Gerät ein, das {machine} erlaubt",
  "{machine} is offline on SpecWithCode Connect": "{machine} ist in SpecWithCode Connect offline",
  "Choose Connect… to open {machine}": "Wähle „Verbinden…“, um {machine} zu öffnen",
  "Sign in to SpecWithCode Connect on this device to open {machine}":
    "Melde dich auf diesem Gerät bei SpecWithCode Connect an, um {machine} zu öffnen",
  "Away from {machine}? Type the code in SpecWithCode on a phone or computer {machine} already allows.":
    "Nicht bei {machine}? Gib den Code in SpecWithCode auf einem Telefon oder Computer ein, den {machine} bereits erlaubt.",
  "Away from a machine? Type its code in SpecWithCode on a phone or computer that machine already allows.":
    "Nicht bei einer Maschine? Gib ihren Code in SpecWithCode auf einem Telefon oder Computer ein, den diese Maschine bereits erlaubt.",
};
