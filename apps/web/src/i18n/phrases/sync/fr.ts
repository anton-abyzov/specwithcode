import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncFr: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Mettez à jour SpecWithCode sur {machine} pour synchroniser avec Git. « Comparer tous les fichiers… » fonctionne dès maintenant.",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} est hors ligne. La synchronisation a besoin des deux machines connectées.",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "Cette fenêtre ne peut que lire {machine} : elle ne peut donc pas la synchroniser. Ouvrez SpecWithCode sur {machine}, ou connectez-vous-y avec un accès complet.",
  "{machine} does not have this project.": "{machine} n’a pas ce projet.",
  "A personal project is not synced between machines.":
    "Un projet personnel n’est pas synchronisé entre les machines.",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "Le dossier du projet sur {machine} n’est pas un dépôt Git. Utilisez « Comparer tous les fichiers… ».",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine} n’a pas répondu. Vérifiez la connexion, puis vérifiez à nouveau.",
  "1 uncommitted file": "1 fichier non commité",
  "{n} uncommitted files": "{n} fichiers non commités",
  "Changed since the plan": "Modifié depuis le plan",
  "In use by {thread}": "Utilisé par {thread}",
  "Moved forward 1 commit": "Avancé de 1 commit",
  "Moved forward {n} commits": "Avancé de {n} commits",
  "Moves forward 1 commit": "Avance de 1 commit",
  "Moves forward {n} commits": "Avance de {n} commits",
  "Cloned from {remote}": "Cloné depuis {remote}",
  "Clones it from {remote}": "Sera cloné depuis {remote}",
  "1 commit not pushed (listed as an extra)": "1 commit non poussé (listé comme extra)",
  "{n} commits not pushed (listed as an extra)": "{n} commits non poussés (listés comme extra)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "A 1 commit propre et {b} de retard. Non avancé",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "A {a} commits propres et {b} de retard. Non avancé",
  "Not moved forward: 1 uncommitted file": "Non avancé : 1 fichier non commité",
  "Not moved forward: {n} uncommitted files": "Non avancé : {n} fichiers non commités",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "Sur {branch}. La branche de l’autre machine arrive avec le fetch si le dépôt distant l’a ; aucun checkout n’est fait",
  "Not on a branch. Not moved": "Sur aucune branche. Non avancé",
  "No upstream. Its commits are listed as an extra":
    "Pas d’upstream. Ses commits sont listés comme extra",
  "Could not fetch: {reason}. The other repositories continue":
    "Fetch impossible : {reason}. Les autres dépôts continuent",
  "Could not fetch. The other repositories continue":
    "Fetch impossible. Les autres dépôts continuent",
  'Not in Git on a remote. Use "Compare all files…"':
    "Pas dans Git sur un dépôt distant. Utilisez « Comparer tous les fichiers… »",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "Pas de fetch : ce dépôt est un miroir de son dépôt distant, et un fetch déplacerait ses branches",
  "Sync did not change it: {reason}": "La synchronisation ne l’a pas modifié : {reason}",
  "Sync did not change it": "La synchronisation ne l’a pas modifié",
  "Follows {name}, which is not a branch of origin. Not moved":
    "Suit {name}, qui n’est pas une branche d’origin. Non avancé",
  "{upstream} is no longer on origin. Not moved": "{upstream} n’est plus sur origin. Non avancé",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "La synchronisation ne l’a pas modifié : impossible de demander à origin si la branche existe encore",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "Un clonage interrompu a laissé {path}, et le dossier n’a pas pu être supprimé",
  "{path}: {reason}": "{path} : {reason}",
  "{path}: Sync did not change it": "{path} : la synchronisation ne l’a pas modifié",
  "Not moved": "Non avancé",
  "1 commit on {branch} that was never pushed": "1 commit sur {branch} jamais poussé",
  "{n} commits on {branch} that were never pushed": "{n} commits sur {branch} jamais poussés",
  "Sent straight to {target} over the link between the machines, as branch {name}. Nothing goes to GitHub.":
    "Envoyé directement à {target} par le lien entre les machines, comme branche {name}. Rien ne passe par GitHub.",
  "1 branch that exists only on {machine}": "1 branche qui n’existe que sur {machine}",
  "{n} branches that exist only on {machine}": "{n} branches qui n’existent que sur {machine}",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "Envoyé directement à {target} par le lien entre les machines, comme branches sous {name}. Rien ne passe par GitHub.",
  "1 uncommitted file in {repository}": "1 fichier non commité dans {repository}",
  "{n} uncommitted files in {repository}": "{n} fichiers non commités dans {repository}",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "Arrive sur {target} comme branche sous {name}, pas comme fichiers dans son dossier. Rien n’est commité sur {source}.",
  "1 stash in {repository}": "1 stash dans {repository}",
  "{n} stashes in {repository}": "{n} stashs dans {repository}",
  "Stashes stay. Compare all files… can bring them":
    "Les stashs restent. Comparer tous les fichiers… peut les apporter",
  "1 more branch in {repository} is not listed":
    "1 autre branche dans {repository} n’est pas listée",
  "{n} more branches in {repository} are not listed":
    "{n} autres branches dans {repository} ne sont pas listées",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "Un secret d’après son nom. Il reste sur {source} : la synchronisation n’envoie pas les secrets.",
  "Looks like a {kind}": "Ressemble à {kind}",
  "Looks like a secret": "Ressemble à un secret",
  "Includes 1 commit not pushed on {branch}": "Inclut 1 commit non poussé sur {branch}",
  "Includes {n} commits not pushed on {branch}": "Inclut {n} commits non poussés sur {branch}",
  "1 file left out": "1 fichier laissé de côté",
  "{n} files left out": "{n} fichiers laissés de côté",
  "{target} already has it as branch {name}.": "{target} l’a déjà comme branche {name}.",
  "{branch} is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{branch} est extraite sur {target}, donc ceci est arrivé à côté sous le nom {name}. Pour l’utiliser là-bas, faites un checkout ou fusionnez-la.",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target} a un autre travail sous ce nom, donc ceci est arrivé à côté sous le nom {name}. Pour l’utiliser là-bas, faites un checkout ou fusionnez-la.",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "Sur {target} comme branche {name}. Pour l’utiliser là-bas, faites un checkout ou fusionnez-la.",
  "Nothing to send: {target} would get no new work.":
    "Rien à envoyer : {target} ne recevrait aucun nouveau travail.",
  "Stays on {source}: the branch is no longer there.":
    "Reste sur {source} : la branche n’existe plus.",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "Reste sur {source} : {reason}. « Comparer tous les fichiers… » peut l’apporter.",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "Reste sur {source} : il dépasse une limite de taille. « Comparer tous les fichiers… » peut l’apporter.",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "Reste sur {source} : mettez d’abord à jour SpecWithCode sur {target}.",
  "Stays on {source}: {target} could not be reached.":
    "Reste sur {source} : {target} n’a pas pu être joint.",
  "Stays on {source}: {reason}.": "Reste sur {source} : {reason}.",
  "Stays on {source}: it could not be sent.": "Reste sur {source} : l’envoi a échoué.",
  "Needs update · {version}": "Mise à jour requise · {version}",
  "Needs update": "Mise à jour requise",
  "This window can only read {machine}": "Cette fenêtre ne peut que lire {machine}",
  "Not there": "Absent",
  Repository: "Dépôt",
  "Only on {machine} · Git does not carry these":
    "Seulement sur {machine} · Git ne les transporte pas",
  "Work that is only on {machine} could not be listed.":
    "Le travail présent uniquement sur {machine} n’a pas pu être listé.",
  "Secrets and files left out on {machine}": "Secrets et fichiers laissés de côté sur {machine}",
  "Will be sent": "Sera envoyé",
  "Send anyway": "Envoyer quand même",
  "1 more file is left out and not listed.": "1 autre fichier est laissé de côté et non listé.",
  "{n} more files are left out and not listed.":
    "{n} autres fichiers sont laissés de côté et non listés.",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "Vérifié d’après le nom de fichier, et pour les fichiers non suivis d’après leurs premiers 64 KB. Parcourez la liste avant d’envoyer.",
  "Extras from {machine}": "Extras de {machine}",
  "The extras from {machine} were not sent.": "Les extras de {machine} n’ont pas été envoyés.",
  "Uncommitted files in {repository}": "Fichiers non commités dans {repository}",
  "Compare all files…": "Comparer tous les fichiers…",
  "Sync {project}": "Synchroniser {project}",
  "{project} is in sync on {source} and {machine}":
    "{project} est synchronisé sur {source} et {machine}",
  "Sync {project}: {source} and {machine}": "Synchroniser {project} : {source} et {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "D’abord Git. Chaque machine fait un fetch depuis le dépôt distant et avance, en fast-forward uniquement. Rien n’est écrasé et rien n’est poussé. Le coordinateur reste où il est.",
  "Sync {machine} with": "Synchroniser {machine} avec",
  "Fetching on {source} and {machine}…": "Fetch sur {source} et {machine}…",
  "Syncing {source} and {machine}…": "Synchronisation de {source} et {machine}…",
  "Sending the ticked extras…": "Envoi des extras cochés…",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "Seul le dépôt de premier niveau de {machine} est listé : son dossier dépasse les limites d’analyse, donc les dépôts qu’il contient sont ignorés.",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "Rien à avancer ni à cloner. Cochez un extra pour l’envoyer.",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "Des fichiers hors de Git d’un côté ou de l’autre ? Comparer tous les fichiers… est la méthode lente et complète.",
  "Syncing…": "Synchronisation…",
  Sync: "Synchroniser",
  "Same as {shown}": "Identique à {shown}",
  "Same as {shown} · as of {time}": "Identique à {shown} · à {time}",
  "{k} of {n} repositories differ": "{k} dépôts sur {n} diffèrent",
  "{k} of {n} repositories differ · as of {time}": "{k} dépôts sur {n} diffèrent · à {time}",
  "Not checked yet": "Pas encore vérifié",
  "Sync…": "Synchroniser…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "1 fichier non commité reste sur {source} : Git ne transporte que les commits. Commitez-le, ou choisissez « Copier tout le dossier » sous « Détails ».",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "{count} fichiers non commités restent sur {source} : Git ne transporte que les commits. Commitez-les, ou choisissez « Copier tout le dossier » sous « Détails ».",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "Le travail non commité reste sur {source} : Git ne transporte que les commits. Commitez-le, ou choisissez « Copier tout le dossier » sous « Détails ».",
  "Add to another machine": "Ajouter à une autre machine",
  "Add {project} to another machine": "Ajouter {project} à une autre machine",
  "Add {project} to {machine}": "Ajouter {project} à {machine}",
  "Compare again": "Comparer à nouveau",
  "Continue on {target} anyway, on its older commits":
    "Continuer quand même sur {target}, sur ses anciens commits",
  "Continue the coordinator on another machine": "Continuer le coordinateur sur une autre machine",
  "Copy the whole folder from {source}": "Copier tout le dossier depuis {source}",
  "Download from GitHub (recommended)": "Télécharger depuis GitHub (recommandé)",
  "Folder on {machine}": "Dossier sur {machine}",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "Poussez-le d’abord, ou choisissez « Copier tout le dossier » sous « Détails ». Le déplacement a lieu dans tous les cas.",
  "Push these commits and continue the coordinator on {target}.":
    "Pousser ces commits et continuer le coordinateur sur {target}.",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "Pousser ces commits vers leurs dépôts distants et continuer le coordinateur sur {target}.",
  "Sync again": "Synchroniser à nouveau",
  "Sync again…": "Synchroniser à nouveau…",
  "Run the same sync again": "Relancer la même synchronisation",
  "Sync again with secrets": "Synchroniser à nouveau avec les secrets",
  "Sync again before handing off the coordinator.":
    "Synchronisez à nouveau avant de transmettre le coordinateur.",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "« Synchroniser à nouveau » apporte ce qui a changé : il compare d’abord et ne déplace que les fichiers modifiés. « Continuer quand même sur {target} » déplace le coordinateur avec ces différences. « Annuler » remet en place le dossier de {target}.",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "Cette copie n’a pas été capturée, vous ne pouvez donc pas déplacer sans eux. « Synchroniser à nouveau » les apporte. Ou gardez le coordinateur sur {source} ; la copie sur {target} reste.",
  "Add this project to another machine": "Ajouter ce projet à une autre machine",
  "{project} is on {machine}": "{project} est sur {machine}",
  "{project} is on {machine} (added {when})": "{project} est sur {machine} (ajouté {when})",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine} a déjà ce projet dans {folder}. « Comparer tous les fichiers » compare les deux dossiers et ajoute ce qui manque sur {machine}. Le coordinateur reste sur {source}.",
  "The coordinator continues on {target}.": "Le coordinateur continue sur {target}.",
  "The coordinator stays here until you sync again.":
    "Le coordinateur reste ici jusqu’à ce que vous synchronisiez à nouveau.",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "Les fichiers sont sur {target}, mais {problem}. « Synchroniser à nouveau » : il compare d’abord et ne déplace que ce qui a changé.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "Les fichiers sont sur {target}, mais {problem}. Vous avez choisi « Continuer quand même sur {target} », donc le coordinateur s’est déplacé avec ces différences.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "Les fichiers sont sur {target}, mais {problem}. Vous avez choisi « Continuer quand même sur {target} », donc le coordinateur se déplace avec ces différences.",
  "The source changed. Compare again.": "La source a changé. Comparer à nouveau.",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "La source a changé. Vous pouvez quand même copier les fichiers capturés, ou comparer à nouveau pour le travail plus récent.",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "{source} a changé après la copie. Synchronisez à nouveau avant de déplacer le coordinateur.",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "Ce projet n’a pas de dépôt Git distant, donc {machine} n’a rien à cloner. Copiez plutôt son dossier là-bas : menu de la machine > Ajouter à une autre machine… > Copier tout le dossier.",
  "{there} already has the coordinator, at {folder}.":
    "{there} a déjà le coordinateur, dans {folder}.",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there} a déjà ce projet, dans {folder}. La synchronisation le met à jour.",
  "{there} has this project in {n} folders. Pick one.":
    "{there} a ce projet dans {n} dossiers. Choisissez-en un.",
  "Sync finished for {project}: {source} and {machine}":
    "Synchronisation de {project} terminée : {source} et {machine}",
  "Sync ended, and not everything was moved or sent. Each repository says why.":
    "La synchronisation est terminée, mais tout n’a pas été avancé ou envoyé. Chaque dépôt indique pourquoi.",
  'No answer came for this repository, and it may have moved. "Check again" shows where it stands':
    "Aucune réponse n’est arrivée pour ce dépôt, et il a peut-être avancé. « Vérifier à nouveau » montre où il en est",
  "{machine} answered in a way this version does not read. Update SpecWithCode on this machine, then check again.":
    "{machine} a répondu d’une manière que cette version ne sait pas lire. Mettez à jour SpecWithCode sur cette machine, puis vérifiez à nouveau.",
  "Nothing was moved or sent.": "Rien n’a été avancé ni envoyé.",
  "The rest of the extras from {machine} were not sent.":
    "Le reste des extras de {machine} n’a pas été envoyé.",
  "Sent to {target}: {reason}.": "Envoyé à {target} : {reason}.",
  "Sent to {target}.": "Envoyé à {target}.",
  "Tick the uncommitted files of {repository} first.":
    "Cochez d’abord les fichiers non commités de {repository}.",
  "Send anyway only applies once that repository's uncommitted files are ticked.":
    "Envoyer quand même ne s’applique qu’une fois les fichiers non commités de ce dépôt cochés.",
  "{machine}: Needs update · {version}": "{machine} : Mise à jour requise · {version}",
  "{machine}: Needs update": "{machine} : Mise à jour requise",
  "{machine} could not sync: {reason}.": "{machine} n’a pas pu synchroniser : {reason}.",
  "{machine} did not finish its part of the sync.":
    "{machine} n’a pas terminé sa part de la synchronisation.",
  Repositories: "Dépôts",
  "Sync again brings {source}'s version over. Moving without these paths keeps {source}'s changes there and leaves the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "« Synchroniser à nouveau » apporte la version de {source}. Déplacer sans ces chemins laisse les modifications de {source} sur place et la copie sur {target} telle quelle. Gardez le coordinateur sur {source} pour continuer à y travailler ; la copie sur {target} reste.",
  "Keep the coordinator on {source}": "Garder le coordinateur sur {source}",
  "Move without this path": "Déplacer sans ce chemin",
  "Move without these {n} paths": "Déplacer sans ces {n} chemins",
  "The files are on {target}, but {problem}.": "Les fichiers sont sur {target}, mais {problem}.",
  "The coordinator stays on {source}. The copied files stay on {target}.":
    "Le coordinateur reste sur {source}. Les fichiers copiés restent sur {target}.",
  "The coordinator stays here until you choose below.":
    "Le coordinateur reste ici jusqu’à ce que vous choisissiez ci-dessous.",
  "Files are copied. Hand off the coordinator once work here is idle.":
    "Les fichiers sont copiés. Passez le coordinateur une fois le travail terminé ici.",
  "Linking {target}…": "Liaison de {target}…",
  "Linked: {source} can start work on {target}.":
    "Lié : {source} peut lancer du travail sur {target}.",
  "Linked: {source} can start work on {target}, in {folder}.":
    "Lié : {source} peut lancer du travail sur {target}, dans {folder}.",
  "Not linked yet. {reason}": "Pas encore lié. {reason}",
  "No uncommitted changes on {source}.": "Aucune modification non commitée sur {source}.",
  "Repositories new there download from GitHub or their Git host; one with unpushed commits or stashes is copied whole. Uncommitted and ignored files, and secrets unless you leave them out, come from this machine.":
    "Les dépôts nouveaux là-bas sont téléchargés depuis GitHub ou leur hébergeur Git ; un dépôt avec des commits non poussés ou des stashes est copié en entier. Les fichiers non commités et ignorés, ainsi que les secrets sauf si vous les écartez, viennent de cette machine.",
  "Also brings unpushed commits, local branches and stashes. Slower for large repositories.":
    "Apporte aussi les commits non poussés, les branches locales et les stashes. Plus lent pour les gros dépôts.",
  "Continues in a folder already saved there, which updates from origin. Always moves the coordinator there.":
    "Continue dans un dossier déjà enregistré là-bas, qui se met à jour depuis origin. Déplace toujours le coordinateur là-bas.",
  "Compare again before previewing this changed source.":
    "Comparez à nouveau avant de prévisualiser cette source modifiée.",
  "The source changed. Compare again before copying.":
    "La source a changé. Comparez à nouveau avant de copier.",
  "Not moved: its state could not be read": "Non avancé : son état n’a pas pu être lu",
};
