import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncEs: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Actualiza SpecWithCode en {machine} para sincronizar con Git. «Comparar todos los archivos…» ya funciona.",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} está sin conexión. La sincronización necesita los dos equipos conectados.",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "Esta ventana solo puede leer {machine}, así que no puede sincronizarlo. Abre SpecWithCode en {machine}, o conéctate con acceso completo.",
  "{machine} does not have this project.": "{machine} no tiene este proyecto.",
  "A personal project is not synced between machines.":
    "Un proyecto personal no se sincroniza entre equipos.",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "La carpeta del proyecto en {machine} no es un repositorio Git. Usa «Comparar todos los archivos…».",
  "{machine} could not do it: {reason}.": "{machine} no pudo hacerlo: {reason}.",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine} no respondió. Revisa la conexión y vuelve a comprobar.",
  "1 uncommitted file": "1 archivo sin confirmar",
  "{n} uncommitted files": "{n} archivos sin confirmar",
  "Changed since the plan": "Cambió desde el plan",
  "In use by {thread}": "En uso por {thread}",
  "Moved forward 1 commit": "Avanzó 1 commit",
  "Moved forward {n} commits": "Avanzó {n} commits",
  "Moves forward 1 commit": "Avanza 1 commit",
  "Moves forward {n} commits": "Avanza {n} commits",
  "Cloned from {remote}": "Clonado desde {remote}",
  "Clones it from {remote}": "Lo clona desde {remote}",
  "1 commit not pushed (listed as an extra)": "1 commit sin enviar (aparece como extra)",
  "{n} commits not pushed (listed as an extra)": "{n} commits sin enviar (aparecen como extra)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "Tiene 1 commit propio y va {b} por detrás. No se movió",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "Tiene {a} commits propios y va {b} por detrás. No se movió",
  "Not moved forward: 1 uncommitted file": "No avanzó: 1 archivo sin confirmar",
  "Not moved forward: {n} uncommitted files": "No avanzó: {n} archivos sin confirmar",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "En {branch}. La rama del otro equipo llega con el fetch si el remoto la tiene; no se cambia de rama",
  "Not on a branch. Not moved": "No está en una rama. No se movió",
  "No upstream. Its commits are listed as an extra":
    "Sin upstream. Sus commits aparecen como extra",
  "Could not fetch: {reason}. The other repositories continue":
    "No se pudo hacer fetch: {reason}. Los demás repositorios continúan",
  "Could not fetch. The other repositories continue":
    "No se pudo hacer fetch. Los demás repositorios continúan",
  'Not in Git on a remote. Use "Compare all files…"':
    "No está en Git en un remoto. Usa «Comparar todos los archivos…»",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "Sin fetch: este repositorio es un espejo de su remoto, y un fetch movería sus ramas",
  "Sync did not change it: {reason}": "La sincronización no lo cambió: {reason}",
  "Sync did not change it": "La sincronización no lo cambió",
  "Follows {name}, which is not a branch of origin. Not moved":
    "Sigue a {name}, que no es una rama de origin. No se movió",
  "{upstream} is no longer on origin. Not moved": "{upstream} ya no está en origin. No se movió",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "La sincronización no lo cambió: no se pudo preguntar a origin si la rama sigue ahí",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "Una clonación interrumpida dejó {path}, y no se pudo eliminar",
  "{path}: {reason}": "{path}: {reason}",
  "{path}: Sync did not change it": "{path}: la sincronización no lo cambió",
  "Not moved": "No se movió",
  "1 commit on {branch} that was never pushed": "1 commit en {branch} que nunca se envió",
  "{n} commits on {branch} that were never pushed": "{n} commits en {branch} que nunca se enviaron",
  "Sent straight to {target} over the link between the machines, as branch {name}. Nothing goes to GitHub.":
    "Se envía directamente a {target} por el enlace entre los equipos, como la rama {name}. Nada va a GitHub.",
  "1 branch that exists only on {machine}": "1 rama que solo existe en {machine}",
  "{n} branches that exist only on {machine}": "{n} ramas que solo existen en {machine}",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "Se envían directamente a {target} por el enlace entre los equipos, como ramas bajo {name}. Nada va a GitHub.",
  "1 uncommitted file in {repository}": "1 archivo sin confirmar en {repository}",
  "{n} uncommitted files in {repository}": "{n} archivos sin confirmar en {repository}",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "Llega a {target} como una rama bajo {name}, no como archivos en su carpeta. No se confirma nada en {source}.",
  "1 stash in {repository}": "1 stash en {repository}",
  "{n} stashes in {repository}": "{n} stashes en {repository}",
  "Stashes stay. Compare all files… can bring them":
    "Los stashes se quedan. «Comparar todos los archivos…» puede traerlos",
  "1 more branch in {repository} is not listed":
    "1 rama más en {repository} no aparece en la lista",
  "{n} more branches in {repository} are not listed":
    "{n} ramas más en {repository} no aparecen en la lista",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "Un secreto por su nombre. Se queda en {source}: la sincronización no envía secretos.",
  "Looks like a {kind}": "Parece {kind}",
  "Looks like a secret": "Parece un secreto",
  "Not done: the machine gave no answer for this repository":
    "No se hizo: el equipo no respondió para este repositorio",
  "Includes 1 commit not pushed on {branch}": "Incluye 1 commit sin enviar en {branch}",
  "Includes {n} commits not pushed on {branch}": "Incluye {n} commits sin enviar en {branch}",
  "1 file left out": "1 archivo excluido",
  "{n} files left out": "{n} archivos excluidos",
  "{target} already has it as branch {name}.": "{target} ya lo tiene como la rama {name}.",
  "{branch} is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{branch} está activa en {target}, así que esto llegó al lado como {name}. Para usarlo allí, cámbiate a esa rama o fusiónala.",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target} tiene otro trabajo con ese nombre, así que esto llegó al lado como {name}. Para usarlo allí, cámbiate a esa rama o fusiónala.",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "En {target} como la rama {name}. Para usarla allí, cámbiate a ella o fusiónala.",
  "Nothing to send: {target} would get no new work.":
    "Nada que enviar: {target} no recibiría trabajo nuevo.",
  "Stays on {source}: the branch is no longer there.":
    "Se queda en {source}: la rama ya no existe.",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "Se queda en {source}: {reason}. «Comparar todos los archivos…» puede traerlo.",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "Se queda en {source}: supera un límite de tamaño. «Comparar todos los archivos…» puede traerlo.",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "Se queda en {source}: primero actualiza SpecWithCode en {target}.",
  "Stays on {source}: {target} could not be reached.":
    "Se queda en {source}: no se pudo contactar con {target}.",
  "Stays on {source}: {reason}.": "Se queda en {source}: {reason}.",
  "Stays on {source}: it could not be sent.": "Se queda en {source}: no se pudo enviar.",
  "Needs update · {version}": "Necesita actualizar · {version}",
  "Needs update": "Necesita actualizar",
  "This window can only read {machine}": "Esta ventana solo puede leer {machine}",
  "Not there": "No está",
  Repository: "Repositorio",
  "Only on {machine} · Git does not carry these": "Solo en {machine} · Git no lleva esto",
  "Work that is only on {machine} could not be listed.":
    "No se pudo listar el trabajo que solo está en {machine}.",
  "Secrets and files left out on {machine}": "Secretos y archivos excluidos en {machine}",
  "Will be sent": "Se enviará",
  "Send anyway": "Enviar de todos modos",
  "1 more file is left out and not listed.":
    "1 archivo más queda excluido y no aparece en la lista.",
  "{n} more files are left out and not listed.":
    "{n} archivos más quedan excluidos y no aparecen en la lista.",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "Revisado por nombre de archivo, y los archivos sin seguimiento también por sus primeros 64 KB. Repasa la lista antes de enviar.",
  "Send anyway counts once the uncommitted files of that repository are ticked.":
    "«Enviar de todos modos» cuenta cuando los archivos sin confirmar de ese repositorio están marcados.",
  "Extras from {machine}": "Extras de {machine}",
  "The extras from {machine} were not sent.": "Los extras de {machine} no se enviaron.",
  "Uncommitted files in {repository}": "Archivos sin confirmar en {repository}",
  "Compare all files…": "Comparar todos los archivos…",
  "Sync {project}": "Sincronizar {project}",
  "{project} is in sync on {source} and {machine}":
    "{project} está sincronizado en {source} y {machine}",
  "Sync {project}: {source} and {machine}": "Sincronizar {project}: {source} y {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "Primero Git. Cada equipo hace fetch desde el remoto y avanza, solo con fast-forward. No se sobrescribe nada y no se envía nada. El coordinador se queda donde está.",
  "Sync {machine} with": "Sincronizar {machine} con",
  "Fetching on {source} and {machine}…": "Haciendo fetch en {source} y {machine}…",
  "Nothing was changed on either machine.": "No se cambió nada en ninguno de los equipos.",
  "Syncing {source} and {machine}…": "Sincronizando {source} y {machine}…",
  "Sending the ticked extras…": "Enviando los extras marcados…",
  "{machine} did not run its part.": "{machine} no hizo su parte.",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "Solo aparece el repositorio superior de {machine}: su carpeta supera los límites de análisis, así que se omiten los repositorios que contiene.",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "Nada que avanzar ni clonar. Marca un extra para enviarlo.",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "¿Archivos fuera de Git en algún lado? «Comparar todos los archivos…» es la forma lenta y completa.",
  "Syncing…": "Sincronizando…",
  Sync: "Sincronizar",
  "Same as {shown}": "Igual que {shown}",
  "Same as {shown} · as of {time}": "Igual que {shown} · a las {time}",
  "{k} of {n} repositories differ": "{k} de {n} repositorios difieren",
  "{k} of {n} repositories differ · as of {time}":
    "{k} de {n} repositorios difieren · a las {time}",
  "Not checked yet": "Sin comprobar",
  "Sync…": "Sincronizar…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "1 archivo sin confirmar se queda en {source}: Git solo lleva commits. Confírmalo, o elige «Copiar toda la carpeta» en «Detalles».",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "{count} archivos sin confirmar se quedan en {source}: Git solo lleva commits. Confírmalos, o elige «Copiar toda la carpeta» en «Detalles».",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "El trabajo sin confirmar se queda en {source}: Git solo lleva commits. Confírmalo, o elige «Copiar toda la carpeta» en «Detalles».",
  "Add to another machine": "Añadir a otro equipo",
  "Add {project} to another machine": "Añadir {project} a otro equipo",
  "Add {project} to {machine}": "Añadir {project} a {machine}",
  "Compare again": "Volver a comparar",
  "Continue on {target} anyway, on its older commits":
    "Continuar en {target} de todos modos, con sus commits anteriores",
  "Continue the coordinator on another machine": "Continuar el coordinador en otro equipo",
  "Copy the whole folder from {source}": "Copiar toda la carpeta desde {source}",
  "Download from GitHub (recommended)": "Descargar desde GitHub (recomendado)",
  "Folder on {machine}": "Carpeta en {machine}",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "Envíalo primero, o elige «Copiar toda la carpeta» en «Detalles». El traslado sigue adelante en cualquier caso.",
  "Push these commits and continue the coordinator on {target}.":
    "Enviar estos commits y continuar el coordinador en {target}.",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "Enviar estos commits a sus remotos y continuar el coordinador en {target}.",
  "Sync again": "Volver a sincronizar",
  "Sync again…": "Volver a sincronizar…",
  "Run the same sync again": "Repetir la misma sincronización",
  "Sync again with secrets": "Volver a sincronizar con secretos",
  "Sync again before handing off the coordinator.":
    "Vuelve a sincronizar antes de traspasar el coordinador.",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "«Volver a sincronizar» trae lo que cambió; compara primero y mueve solo los archivos cambiados. «Continuar en {target} de todos modos» mueve el coordinador con estas diferencias. «Deshacer» deja la carpeta de {target} como estaba.",
  "Sync again brings {source}'s version over. Move without them keeps {source}'s changes there and the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "«Volver a sincronizar» trae la versión de {source}. «Mover sin ellos» deja los cambios de {source} allí y la copia de {target} como está. «Mantener el coordinador en {source}» para seguir trabajando allí; la copia de {target} se queda.",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "Esta copia no se capturó, así que no puedes mover sin ellos. «Volver a sincronizar» los trae. O mantén el coordinador en {source}; la copia de {target} se queda.",
  "Add this project to another machine": "Añadir este proyecto a otro equipo",
  "{project} is on {machine}": "{project} está en {machine}",
  "{project} is on {machine} (added {when})": "{project} está en {machine} (añadido {when})",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine} ya tiene este proyecto en {folder}. «Comparar todos los archivos» compara las dos carpetas y añade lo que le falta a {machine}. El coordinador se queda en {source}.",
  "The coordinator continues on {target}.": "El coordinador continúa en {target}.",
  "The coordinator stays here until you sync again.":
    "El coordinador se queda aquí hasta que vuelvas a sincronizar.",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "Los archivos están en {target}, pero {problem}. Vuelve a sincronizar: compara primero y mueve solo lo que cambió.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "Los archivos están en {target}, pero {problem}. Elegiste «Continuar en {target} de todos modos», así que el coordinador se movió con estas diferencias.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "Los archivos están en {target}, pero {problem}. Elegiste «Continuar en {target} de todos modos», así que el coordinador se mueve con estas diferencias.",
  "The source changed. Compare again.": "El origen cambió. Vuelve a comparar.",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "El origen cambió. Aún puedes copiar los archivos capturados, o volver a comparar para traer trabajo más reciente.",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "{source} cambió después de copiar. Vuelve a sincronizar antes de mover el coordinador.",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "Este proyecto no tiene un remoto de Git, así que {machine} no tiene de dónde clonarlo. Copia su carpeta allí: el menú del equipo > Añadir a otro equipo… > Copiar toda la carpeta.",
  "{there} already has the coordinator, at {folder}.":
    "{there} ya tiene el coordinador, en {folder}.",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there} ya tiene este proyecto, en {folder}. La sincronización lo pone al día.",
  "{there} has this project in {n} folders. Pick one.":
    "{there} tiene este proyecto en {n} carpetas. Elige una.",
};
