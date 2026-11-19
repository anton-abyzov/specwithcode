import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncDe: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Aktualisiere SpecWithCode auf {machine}, um mit Git zu synchronisieren. „Alle Dateien vergleichen…“ funktioniert schon jetzt.",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} ist offline. Für die Synchronisierung müssen beide Rechner verbunden sein.",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "Dieses Fenster kann {machine} nur lesen und deshalb nicht synchronisieren. Öffne SpecWithCode auf {machine} oder verbinde dich mit vollem Zugriff.",
  "{machine} does not have this project.": "{machine} hat dieses Projekt nicht.",
  "A personal project is not synced between machines.":
    "Ein persönliches Projekt wird nicht zwischen Rechnern synchronisiert.",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "Der Projektordner auf {machine} ist kein Git-Repository. Verwende „Alle Dateien vergleichen…“.",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine} hat nicht geantwortet. Prüfe die Verbindung und prüfe dann erneut.",
  "1 uncommitted file": "1 nicht committete Datei",
  "{n} uncommitted files": "{n} nicht committete Dateien",
  "Changed since the plan": "Seit dem Plan geändert",
  "In use by {thread}": "Von {thread} genutzt",
  "Moved forward 1 commit": "Um 1 Commit vorgerückt",
  "Moved forward {n} commits": "Um {n} Commits vorgerückt",
  "Moves forward 1 commit": "Rückt 1 Commit vor",
  "Moves forward {n} commits": "Rückt {n} Commits vor",
  "Cloned from {remote}": "Von {remote} geklont",
  "Clones it from {remote}": "Wird von {remote} geklont",
  "1 commit not pushed (listed as an extra)": "1 nicht gepushter Commit (als Extra aufgeführt)",
  "{n} commits not pushed (listed as an extra)":
    "{n} nicht gepushte Commits (als Extra aufgeführt)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "Hat 1 eigenen Commit und liegt {b} zurück. Nicht vorgerückt",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "Hat {a} eigene Commits und liegt {b} zurück. Nicht vorgerückt",
  "Not moved forward: 1 uncommitted file": "Nicht vorgerückt: 1 nicht committete Datei",
  "Not moved forward: {n} uncommitted files": "Nicht vorgerückt: {n} nicht committete Dateien",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "Auf {branch}. Der Branch des anderen Rechners kommt mit dem Fetch, wenn der Remote ihn hat; nichts wird ausgecheckt",
  "Not on a branch. Not moved": "Auf keinem Branch. Nicht vorgerückt",
  "No upstream. Its commits are listed as an extra":
    "Kein Upstream. Seine Commits werden als Extra aufgeführt",
  "Could not fetch: {reason}. The other repositories continue":
    "Fetch fehlgeschlagen: {reason}. Die anderen Repositorys laufen weiter",
  "Could not fetch. The other repositories continue":
    "Fetch fehlgeschlagen. Die anderen Repositorys laufen weiter",
  'Not in Git on a remote. Use "Compare all files…"':
    "Nicht in Git auf einem Remote. Verwende „Alle Dateien vergleichen…“",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "Kein Fetch: Dieses Repository spiegelt seinen Remote, und ein Fetch würde seine Branches verschieben",
  "Sync did not change it: {reason}": "Von der Synchronisierung nicht geändert: {reason}",
  "Sync did not change it": "Von der Synchronisierung nicht geändert",
  "Follows {name}, which is not a branch of origin. Not moved":
    "Folgt {name}, das kein Branch von origin ist. Nicht vorgerückt",
  "{upstream} is no longer on origin. Not moved":
    "{upstream} gibt es auf origin nicht mehr. Nicht vorgerückt",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "Von der Synchronisierung nicht geändert: origin konnte nicht gefragt werden, ob es den Branch noch gibt",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "Ein abgebrochener Klon hat {path} zurückgelassen, und der Ordner ließ sich nicht entfernen",
  "{path}: {reason}": "{path}: {reason}",
  "{path}: Sync did not change it": "{path}: von der Synchronisierung nicht geändert",
  "Not moved": "Nicht vorgerückt",
  "1 commit on {branch} that was never pushed": "1 Commit auf {branch}, der nie gepusht wurde",
  "{n} commits on {branch} that were never pushed":
    "{n} Commits auf {branch}, die nie gepusht wurden",
  "1 branch that exists only on {machine}": "1 Branch, den es nur auf {machine} gibt",
  "{n} branches that exist only on {machine}": "{n} Branches, die es nur auf {machine} gibt",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "Geht über die Verbindung zwischen den Rechnern direkt an {target}, als Branches unter {name}. Nichts geht an GitHub.",
  "1 uncommitted file in {repository}": "1 nicht committete Datei in {repository}",
  "{n} uncommitted files in {repository}": "{n} nicht committete Dateien in {repository}",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "Kommt auf {target} als Branch unter {name} an, nicht als Dateien in seinem Ordner. Auf {source} wird nichts committet.",
  "1 stash in {repository}": "1 Stash in {repository}",
  "{n} stashes in {repository}": "{n} Stashes in {repository}",
  "Stashes stay. Compare all files… can bring them":
    "Stashes bleiben. Alle Dateien vergleichen… kann sie mitbringen",
  "1 more branch in {repository} is not listed":
    "1 weiterer Branch in {repository} ist nicht aufgeführt",
  "{n} more branches in {repository} are not listed":
    "{n} weitere Branches in {repository} sind nicht aufgeführt",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "Dem Namen nach ein Geheimnis. Es bleibt auf {source}: Die Synchronisierung sendet keine Geheimnisse.",
  "Looks like a {kind}": "Sieht nach {kind} aus",
  "Looks like a secret": "Sieht nach einem Geheimnis aus",
  "Includes 1 commit not pushed on {branch}": "Enthält 1 nicht gepushten Commit auf {branch}",
  "Includes {n} commits not pushed on {branch}": "Enthält {n} nicht gepushte Commits auf {branch}",
  "1 file left out": "1 Datei ausgelassen",
  "{n} files left out": "{n} Dateien ausgelassen",
  "{target} already has it as branch {name}.": "{target} hat es bereits als Branch {name}.",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target} hat unter diesem Namen andere Arbeit, daher ist es daneben als {name} angekommen. Um es dort zu nutzen, checke es aus oder merge es.",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "Auf {target} als Branch {name}. Um es dort zu nutzen, checke es aus oder merge es.",
  "Nothing to send: {target} would get no new work.":
    "Nichts zu senden: {target} würde keine neue Arbeit bekommen.",
  "Stays on {source}: the branch is no longer there.":
    "Bleibt auf {source}: Der Branch ist nicht mehr da.",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "Bleibt auf {source}: {reason}. „Alle Dateien vergleichen…“ kann es mitbringen.",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "Bleibt auf {source}: Es überschreitet eine Größengrenze. „Alle Dateien vergleichen…“ kann es mitbringen.",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "Bleibt auf {source}: Aktualisiere zuerst SpecWithCode auf {target}.",
  "Stays on {source}: {reason}.": "Bleibt auf {source}: {reason}.",
  "Stays on {source}: it could not be sent.":
    "Bleibt auf {source}: Es konnte nicht gesendet werden.",
  "Needs update · {version}": "Update nötig · {version}",
  "Needs update": "Update nötig",
  "This window can only read {machine}": "Dieses Fenster kann {machine} nur lesen",
  "Not there": "Nicht vorhanden",
  Repository: "Repository",
  "Only on {machine} · Git does not carry these": "Nur auf {machine} · Git überträgt diese nicht",
  "Work that is only on {machine} could not be listed.":
    "Arbeit, die nur auf {machine} liegt, konnte nicht aufgelistet werden.",
  "Secrets and files left out on {machine}": "Geheimnisse und ausgelassene Dateien auf {machine}",
  "Will be sent": "Wird gesendet",
  "Send anyway": "Trotzdem senden",
  "1 more file is left out and not listed.":
    "1 weitere Datei ist ausgelassen und nicht aufgeführt.",
  "{n} more files are left out and not listed.":
    "{n} weitere Dateien sind ausgelassen und nicht aufgeführt.",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "Geprüft nach Dateiname, nicht verfolgte Dateien zusätzlich anhand ihrer ersten 64 KB. Sieh die Liste durch, bevor du sendest.",
  "Extras from {machine}": "Extras von {machine}",
  "The extras from {machine} were not sent.": "Die Extras von {machine} wurden nicht gesendet.",
  "Uncommitted files in {repository}": "Nicht committete Dateien in {repository}",
  "Compare all files…": "Alle Dateien vergleichen…",
  "Sync {project}": "{project} synchronisieren",
  "{project} is in sync on {source} and {machine}":
    "{project} ist auf {source} und {machine} synchron",
  "Sync {project}: {source} and {machine}": "{project} synchronisieren: {source} und {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "Zuerst Git. Jeder Rechner holt per Fetch vom Remote und rückt vor, nur per Fast-Forward. Nichts wird überschrieben und nichts gepusht. Der Koordinator bleibt, wo er ist.",
  "Sync {machine} with": "{machine} synchronisieren mit",
  "Fetching on {source} and {machine}…": "Fetch auf {source} und {machine}…",
  "Syncing {source} and {machine}…": "{source} und {machine} werden synchronisiert…",
  "Sending the ticked extras…": "Angehakte Extras werden gesendet…",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "Nur das oberste Repository von {machine} ist aufgeführt: Sein Ordner überschreitet die Scan-Grenzen, daher werden die Repositorys darin übersprungen.",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "Nichts vorzurücken oder zu klonen. Hake ein Extra an, um es zu senden.",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "Dateien außerhalb von Git auf einer der Seiten? Alle Dateien vergleichen… ist der langsame, vollständige Weg.",
  "Syncing…": "Wird synchronisiert…",
  Sync: "Synchronisieren",
  "Same as {shown}": "Wie {shown}",
  "Same as {shown} · as of {time}": "Wie {shown} · Stand {time}",
  "{k} of {n} repositories differ": "{k} von {n} Repositorys weichen ab",
  "{k} of {n} repositories differ · as of {time}":
    "{k} von {n} Repositorys weichen ab · Stand {time}",
  "Not checked yet": "Noch nicht geprüft",
  "Sync…": "Synchronisieren…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "1 nicht committete Datei bleibt auf {source}: Git überträgt nur Commits. Committe sie oder wähle unter „Details“ „Ganzen Ordner kopieren“.",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "{count} nicht committete Dateien bleiben auf {source}: Git überträgt nur Commits. Committe sie oder wähle unter „Details“ „Ganzen Ordner kopieren“.",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "Nicht committete Arbeit bleibt auf {source}: Git überträgt nur Commits. Committe sie oder wähle unter „Details“ „Ganzen Ordner kopieren“.",
  "Add to another machine": "Auf anderem Rechner hinzufügen",
  "Add {project} to another machine": "{project} auf anderem Rechner hinzufügen",
  "Add {project} to {machine}": "{project} auf {machine} hinzufügen",
  "Compare again": "Erneut vergleichen",
  "Continue on {target} anyway, on its older commits":
    "Trotzdem auf {target} fortsetzen, auf seinen älteren Commits",
  "Continue the coordinator on another machine": "Koordinator auf einem anderen Rechner fortsetzen",
  "Copy the whole folder from {source}": "Ganzen Ordner von {source} kopieren",
  "Download from GitHub (recommended)": "Von GitHub herunterladen (empfohlen)",
  "Folder on {machine}": "Ordner auf {machine}",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "Pushe es zuerst oder wähle unter „Details“ „Ganzen Ordner kopieren“. Der Umzug läuft so oder so weiter.",
  "Push these commits and continue the coordinator on {target}.":
    "Diese Commits pushen und den Koordinator auf {target} fortsetzen.",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "Diese Commits zu ihren Remotes pushen und den Koordinator auf {target} fortsetzen.",
  "Sync again": "Erneut synchronisieren",
  "Sync again…": "Erneut synchronisieren…",
  "Run the same sync again": "Dieselbe Synchronisierung erneut ausführen",
  "Sync again with secrets": "Erneut synchronisieren, mit Geheimnissen",
  "Sync again before handing off the coordinator.":
    "Synchronisiere erneut, bevor du den Koordinator übergibst.",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "„Erneut synchronisieren“ holt, was sich geändert hat; es vergleicht zuerst und überträgt nur geänderte Dateien. „Trotzdem auf {target} fortsetzen“ zieht den Koordinator mit diesen Unterschieden um. „Rückgängig“ stellt den Ordner auf {target} wieder her.",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "Diese Kopie wurde nicht erfasst, daher kannst du nicht ohne sie umziehen. „Erneut synchronisieren“ holt sie. Oder behalte den Koordinator auf {source}; die Kopie auf {target} bleibt.",
  "Add this project to another machine": "Dieses Projekt auf einem anderen Rechner hinzufügen",
  "{project} is on {machine}": "{project} ist auf {machine}",
  "{project} is on {machine} (added {when})": "{project} ist auf {machine} (hinzugefügt {when})",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine} hat dieses Projekt bereits unter {folder}. „Alle Dateien vergleichen“ vergleicht die beiden Ordner und ergänzt, was {machine} fehlt. Der Koordinator bleibt auf {source}.",
  "The coordinator continues on {target}.": "Der Koordinator wird auf {target} fortgesetzt.",
  "The coordinator stays here until you sync again.":
    "Der Koordinator bleibt hier, bis du erneut synchronisierst.",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "Die Dateien sind auf {target}, aber {problem}. „Erneut synchronisieren“: Es vergleicht zuerst und überträgt nur, was sich geändert hat.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "Die Dateien sind auf {target}, aber {problem}. Du hast „Trotzdem auf {target} fortsetzen“ gewählt, daher ist der Koordinator mit diesen Unterschieden umgezogen.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "Die Dateien sind auf {target}, aber {problem}. Du hast „Trotzdem auf {target} fortsetzen“ gewählt, daher zieht der Koordinator mit diesen Unterschieden um.",
  "The source changed. Compare again.": "Die Quelle hat sich geändert. Erneut vergleichen.",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "Die Quelle hat sich geändert. Du kannst die erfassten Dateien trotzdem kopieren oder erneut vergleichen, um neuere Arbeit zu holen.",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "{source} hat sich nach dem Kopieren geändert. Synchronisiere erneut, bevor du den Koordinator umziehst.",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "Dieses Projekt hat keinen Git-Remote, daher kann {machine} von nirgends klonen. Kopiere stattdessen seinen Ordner dorthin: Rechnermenü > Auf anderem Rechner hinzufügen… > Ganzen Ordner kopieren.",
  "{there} already has the coordinator, at {folder}.":
    "{there} hat den Koordinator bereits, unter {folder}.",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there} hat dieses Projekt bereits, unter {folder}. Die Synchronisierung bringt es auf den neuesten Stand.",
  "{there} has this project in {n} folders. Pick one.":
    "{there} hat dieses Projekt in {n} Ordnern. Wähle einen aus.",
  "Sync finished for {project}: {source} and {machine}":
    "Synchronisierung von {project} beendet: {source} und {machine}",
  "Sync ended, and not everything was moved or sent. Each repository says why.":
    "Die Synchronisierung ist beendet, aber nicht alles wurde vorgerückt oder gesendet. Bei jedem Repository steht der Grund.",
  'No answer came for this repository, and it may have moved. "Check again" shows where it stands':
    "Für dieses Repository kam keine Antwort; es kann vorgerückt sein. „Erneut prüfen“ zeigt, wo es steht",
  "{machine} answered in a way this version does not read. Update SpecWithCode on this machine, then check again.":
    "{machine} hat so geantwortet, dass diese Version es nicht lesen kann. Aktualisiere SpecWithCode auf diesem Rechner und prüfe dann erneut.",
  "Nothing was moved or sent.": "Nichts wurde vorgerückt oder gesendet.",
  "The rest of the extras from {machine} were not sent.":
    "Die übrigen Extras von {machine} wurden nicht gesendet.",
  "Sent to {target}: {reason}.": "An {target} gesendet: {reason}.",
  "Sent to {target}.": "An {target} gesendet.",
  "Tick the uncommitted files of {repository} first.":
    "Hake zuerst die nicht committeten Dateien von {repository} an.",
  "Send anyway only applies once that repository's uncommitted files are ticked.":
    "Trotzdem senden gilt erst, wenn die nicht committeten Dateien dieses Repositorys angehakt sind.",
  "{machine}: Needs update · {version}": "{machine}: Update nötig · {version}",
  "{machine}: Needs update": "{machine}: Update nötig",
  "{machine} could not sync: {reason}.": "{machine} konnte nicht synchronisieren: {reason}.",
  "{machine} did not finish its part of the sync.":
    "{machine} hat seinen Teil der Synchronisierung nicht abgeschlossen.",
  Repositories: "Repositorys",
  "Sync again brings {source}'s version over. Moving without these paths keeps {source}'s changes there and leaves the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "„Erneut synchronisieren“ holt die Version von {source}. Ein Umzug ohne diese Pfade lässt die Änderungen von {source} dort und die Kopie auf {target}, wie sie ist. Behalte den Koordinator auf {source}, um dort weiterzuarbeiten; die Kopie auf {target} bleibt.",
  "Keep the coordinator on {source}": "Koordinator auf {source} behalten",
  "Move without this path": "Ohne diesen Pfad umziehen",
  "Move without these {n} paths": "Ohne diese {n} Pfade umziehen",
  "The files are on {target}, but {problem}.": "Die Dateien sind auf {target}, aber {problem}.",
  "The coordinator stays on {source}. The copied files stay on {target}.":
    "Der Koordinator bleibt auf {source}. Die kopierten Dateien bleiben auf {target}.",
  "The coordinator stays here until you choose below.":
    "Der Koordinator bleibt hier, bis du unten wählst.",
  "Files are copied. Hand off the coordinator once work here is idle.":
    "Die Dateien sind kopiert. Übergib den Koordinator, sobald hier nichts mehr läuft.",
  "Linking {target}…": "{target} wird verknüpft…",
  "Linked: {source} can start work on {target}.":
    "Verknüpft: {source} kann auf {target} Arbeit starten.",
  "Linked: {source} can start work on {target}, in {folder}.":
    "Verknüpft: {source} kann auf {target} Arbeit starten, in {folder}.",
  "Not linked yet. {reason}": "Noch nicht verknüpft. {reason}",
  "No uncommitted changes on {source}.": "Keine nicht committeten Änderungen auf {source}.",
  "Repositories new there download from GitHub or their Git host; one with unpushed commits or stashes is copied whole. Uncommitted and ignored files, and secrets unless you leave them out, come from this machine.":
    "Repositorys, die dort neu sind, werden von GitHub oder ihrem Git-Host heruntergeladen; eines mit nicht gepushten Commits oder Stashes wird ganz kopiert. Nicht committete und ignorierte Dateien sowie Geheimnisse, sofern du sie nicht auslässt, kommen von diesem Rechner.",
  "Also brings unpushed commits, local branches and stashes. Slower for large repositories.":
    "Bringt auch nicht gepushte Commits, lokale Branches und Stashes mit. Bei großen Repositorys langsamer.",
  "Continues in a folder already saved there, which updates from origin. Always moves the coordinator there.":
    "Macht in einem dort schon gespeicherten Ordner weiter, der sich von origin aktualisiert. Zieht den Koordinator immer dorthin um.",
  "Compare again before previewing this changed source.":
    "Vergleiche erneut, bevor du für diese geänderte Quelle eine Vorschau öffnest.",
  "The source changed. Compare again before copying.":
    "Die Quelle hat sich geändert. Vergleiche erneut, bevor du kopierst.",
  "Not moved: its state could not be read":
    "Nicht vorgerückt: Der Zustand konnte nicht gelesen werden",
  "Sent straight to {target} over the link between the machines, as a branch under {name}. Nothing goes to GitHub.":
    "Geht über die Verbindung zwischen den Rechnern direkt an {target}, als Branch unter {name}. Nichts geht an GitHub.",
  "The branch it would arrive as is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "Der Branch, als der es ankommen würde, ist auf {target} ausgecheckt, daher ist es daneben als {name} angekommen. Um es dort zu nutzen, checke es aus oder merge es.",
  "No answer came back. It may have arrived on {target}: check {target} before sending again.":
    "Es kam keine Antwort zurück. Es ist vielleicht auf {target} angekommen: Sieh auf {target} nach, bevor du es erneut sendest.",
  "Not sent.": "Nicht gesendet.",
  "{machine} sent extras and no answer came back. They may have arrived: check {target} before sending again.":
    "{machine} hat Extras gesendet, und es kam keine Antwort zurück. Sie sind vielleicht angekommen: Sieh auf {target} nach, bevor du sie erneut sendest.",
  "Sync ended, and not every answer came back. Each line says what to check.":
    "Die Synchronisierung ist beendet, aber nicht jede Antwort kam zurück. Bei jeder Zeile steht, was zu prüfen ist.",
  "A move to another machine is not finished. Finish or cancel it, then add a machine.":
    "Ein Umzug auf einen anderen Rechner ist nicht abgeschlossen. Schließe ihn ab oder brich ihn ab und füge dann einen Rechner hinzu.",
  "The copy on {machine} is already shared with other machines. Unlink it there first.":
    "Die Kopie auf {machine} wird bereits mit anderen Rechnern geteilt. Hebe die Verknüpfung zuerst dort auf.",
  "The copy on {machine} does not hold its coordinator, so it cannot be the one that stays.":
    "Die Kopie auf {machine} hat ihren Koordinator nicht und kann deshalb nicht die sein, die bleibt.",
  "A coordinator handoff is in progress on {machine}. Finish or retry it first.":
    "Auf {machine} läuft eine Übergabe des Koordinators. Schließe sie zuerst ab oder wiederhole sie.",
  "The project on {machine} is paused. Resume it first.":
    "Das Projekt auf {machine} ist pausiert. Setze es zuerst fort.",
  "The project on {machine} is archived. Restore it first.":
    "Das Projekt auf {machine} ist archiviert. Stelle es zuerst wieder her.",
  "Only code projects can be linked across machines.":
    "Nur Code-Projekte lassen sich über Rechner hinweg verknüpfen.",
  "The coordinator on {machine} is working. Let it finish or stop it, then link.":
    "Der Koordinator auf {machine} arbeitet gerade. Lass ihn fertig werden oder halte ihn an und verknüpfe dann.",
  "Project notes differ on {machine}.": "Die Projektnotizen auf {machine} weichen ab.",
  "The copy's repository does not match the source.":
    "Das Repository der Kopie passt nicht zur Quelle.",
  "some files changed on {source} while copying":
    "einige Dateien haben sich auf {source} während des Kopierens geändert",
  "the check of Root failed": "die Prüfung des Haupt-Repositorys ist fehlgeschlagen",
  "the check of {repository} failed": "die Prüfung von {repository} ist fehlgeschlagen",
  "the checks of {n} repositories failed": "die Prüfungen von {n} Repositorys sind fehlgeschlagen",
  "A copy to {machine} is not finished. Finish or cancel it, then add another machine.":
    "Eine Kopie auf {machine} ist nicht abgeschlossen. Schließe sie ab oder brich sie ab und füge dann einen weiteren Rechner hinzu.",
  "A copy is not finished. Finish or cancel it, then add another machine.":
    "Eine Kopie ist nicht abgeschlossen. Schließe sie ab oder brich sie ab und füge dann einen weiteren Rechner hinzu.",
  "Open the unfinished copy": "Die unfertige Kopie öffnen",
  "Finish handoff": "Übergabe abschließen",
};
