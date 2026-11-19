import type { PhraseCatalog } from "../../phrases";

/** Sync between machines: the Sync dialog, its results and the sync fact on machine rows. */
export const syncPt: PhraseCatalog = {
  'Update SpecWithCode on {machine} to sync with Git. "Compare all files…" works now.':
    "Atualize o SpecWithCode em {machine} para sincronizar com o Git. “Comparar todos os arquivos…” já funciona.",
  "{machine} is offline. Sync needs both machines connected.":
    "{machine} está offline. A sincronização precisa das duas máquinas conectadas.",
  "This window can only read {machine}, so it cannot sync it. Open SpecWithCode on {machine}, or connect to it with full access.":
    "Esta janela só pode ler {machine}, então não consegue sincronizá-la. Abra o SpecWithCode em {machine}, ou conecte-se com acesso total.",
  "{machine} does not have this project.": "{machine} não tem este projeto.",
  "A personal project is not synced between machines.":
    "Um projeto pessoal não é sincronizado entre máquinas.",
  'The project folder on {machine} is not a Git repository. Use "Compare all files…".':
    "A pasta do projeto em {machine} não é um repositório Git. Use “Comparar todos os arquivos…”.",
  "{machine} could not do it: {reason}.": "{machine} não conseguiu fazer isso: {reason}.",
  "{machine} did not answer. Check the connection, then check again.":
    "{machine} não respondeu. Verifique a conexão e depois verifique de novo.",
  "1 uncommitted file": "1 arquivo não commitado",
  "{n} uncommitted files": "{n} arquivos não commitados",
  "Changed since the plan": "Mudou desde o plano",
  "In use by {thread}": "Em uso por {thread}",
  "Moved forward 1 commit": "Avançou 1 commit",
  "Moved forward {n} commits": "Avançou {n} commits",
  "Moves forward 1 commit": "Avança 1 commit",
  "Moves forward {n} commits": "Avança {n} commits",
  "Cloned from {remote}": "Clonado de {remote}",
  "Clones it from {remote}": "Será clonado de {remote}",
  "1 commit not pushed (listed as an extra)": "1 commit sem push (listado como extra)",
  "{n} commits not pushed (listed as an extra)": "{n} commits sem push (listados como extra)",
  "Has 1 commit of its own and is {b} behind. Not moved":
    "Tem 1 commit próprio e está {b} atrás. Não avançou",
  "Has {a} commits of its own and is {b} behind. Not moved":
    "Tem {a} commits próprios e está {b} atrás. Não avançou",
  "Not moved forward: 1 uncommitted file": "Não avançou: 1 arquivo não commitado",
  "Not moved forward: {n} uncommitted files": "Não avançou: {n} arquivos não commitados",
  "On {branch}. The other machine's branch comes with the fetch when the remote has it; nothing is checked out":
    "Em {branch}. A branch da outra máquina vem com o fetch quando o remoto a tem; nenhum checkout é feito",
  "Not on a branch. Not moved": "Fora de uma branch. Não avançou",
  "No upstream. Its commits are listed as an extra": "Sem upstream. Os commits aparecem como extra",
  "Could not fetch: {reason}. The other repositories continue":
    "Não foi possível fazer fetch: {reason}. Os outros repositórios continuam",
  "Could not fetch. The other repositories continue":
    "Não foi possível fazer fetch. Os outros repositórios continuam",
  'Not in Git on a remote. Use "Compare all files…"':
    "Não está no Git em um remoto. Use “Comparar todos os arquivos…”",
  "Not fetched: this repository mirrors its remote, and a fetch would move its branches":
    "Sem fetch: este repositório espelha o remoto, e um fetch moveria as branches dele",
  "Sync did not change it: {reason}": "A sincronização não o alterou: {reason}",
  "Sync did not change it": "A sincronização não o alterou",
  "Follows {name}, which is not a branch of origin. Not moved":
    "Segue {name}, que não é um branch de origin. Não avançou",
  "{upstream} is no longer on origin. Not moved": "{upstream} não está mais em origin. Não avançou",
  "Sync did not change it: origin could not be asked whether the branch is still there":
    "A sincronização não o alterou: não foi possível perguntar a origin se o branch ainda existe",
  "A clone that was stopped left {path} behind, and it could not be removed":
    "Um clone interrompido deixou {path}, e não foi possível removê-lo",
  "{path}: {reason}": "{path}: {reason}",
  "{path}: Sync did not change it": "{path}: a sincronização não o alterou",
  "Not moved": "Não avançou",
  "1 commit on {branch} that was never pushed": "1 commit em {branch} que nunca foi enviado",
  "{n} commits on {branch} that were never pushed":
    "{n} commits em {branch} que nunca foram enviados",
  "Sent straight to {target} over the link between the machines, as branch {name}. Nothing goes to GitHub.":
    "Enviado direto para {target} pela conexão entre as máquinas, como a branch {name}. Nada vai para o GitHub.",
  "1 branch that exists only on {machine}": "1 branch que só existe em {machine}",
  "{n} branches that exist only on {machine}": "{n} branches que só existem em {machine}",
  "Sent straight to {target} over the link between the machines, as branches under {name}. Nothing goes to GitHub.":
    "Enviado direto para {target} pela conexão entre as máquinas, como branches em {name}. Nada vai para o GitHub.",
  "1 uncommitted file in {repository}": "1 arquivo não commitado em {repository}",
  "{n} uncommitted files in {repository}": "{n} arquivos não commitados em {repository}",
  "Arrives on {target} as a branch under {name}, not as files in its folder. Nothing is committed on {source}.":
    "Chega em {target} como uma branch em {name}, não como arquivos na pasta. Nada é commitado em {source}.",
  "1 stash in {repository}": "1 stash em {repository}",
  "{n} stashes in {repository}": "{n} stashes em {repository}",
  "Stashes stay. Compare all files… can bring them":
    "Os stashes ficam. Comparar todos os arquivos… pode trazê-los",
  "1 more branch in {repository} is not listed":
    "Mais 1 branch em {repository} não aparece na lista",
  "{n} more branches in {repository} are not listed":
    "Mais {n} branches em {repository} não aparecem na lista",
  "A secret by its name. It stays on {source}: Sync does not send secrets.":
    "Um segredo, pelo nome. Ele fica em {source}: a sincronização não envia segredos.",
  "Looks like a {kind}": "Parece {kind}",
  "Looks like a secret": "Parece um segredo",
  "Not done: the machine gave no answer for this repository":
    "Não feito: a máquina não respondeu sobre este repositório",
  "Includes 1 commit not pushed on {branch}": "Inclui 1 commit sem push em {branch}",
  "Includes {n} commits not pushed on {branch}": "Inclui {n} commits sem push em {branch}",
  "1 file left out": "1 arquivo deixado de fora",
  "{n} files left out": "{n} arquivos deixados de fora",
  "{target} already has it as branch {name}.": "{target} já tem isso como a branch {name}.",
  "{branch} is checked out on {target}, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{branch} está em checkout em {target}, então isto chegou ao lado como {name}. Para usar lá, faça checkout ou merge.",
  "{target} has other work under that name, so this arrived beside it as {name}. To use it there, check it out or merge it.":
    "{target} tem outro trabalho com esse nome, então isto chegou ao lado como {name}. Para usar lá, faça checkout ou merge.",
  "On {target} as branch {name}. To use it there, check it out or merge it.":
    "Em {target} como a branch {name}. Para usar lá, faça checkout ou merge.",
  "Nothing to send: {target} would get no new work.":
    "Nada a enviar: {target} não receberia trabalho novo.",
  "Stays on {source}: the branch is no longer there.":
    "Fica em {source}: a branch não existe mais.",
  'Stays on {source}: {reason}. "Compare all files…" can bring it.':
    "Fica em {source}: {reason}. “Comparar todos os arquivos…” pode trazer isso.",
  'Stays on {source}: it is over a size limit. "Compare all files…" can bring it.':
    "Fica em {source}: passa de um limite de tamanho. “Comparar todos os arquivos…” pode trazer isso.",
  "Stays on {source}: update SpecWithCode on {target} first.":
    "Fica em {source}: atualize primeiro o SpecWithCode em {target}.",
  "Stays on {source}: {target} could not be reached.":
    "Fica em {source}: não foi possível acessar {target}.",
  "Stays on {source}: {reason}.": "Fica em {source}: {reason}.",
  "Stays on {source}: it could not be sent.": "Fica em {source}: não foi possível enviar.",
  "Needs update · {version}": "Precisa atualizar · {version}",
  "Needs update": "Precisa atualizar",
  "This window can only read {machine}": "Esta janela só pode ler {machine}",
  "Not there": "Ausente",
  Repository: "Repositório",
  "Only on {machine} · Git does not carry these": "Só em {machine} · o Git não leva estes",
  "Work that is only on {machine} could not be listed.":
    "Não foi possível listar o trabalho que só está em {machine}.",
  "Secrets and files left out on {machine}": "Segredos e arquivos deixados de fora em {machine}",
  "Will be sent": "Será enviado",
  "Send anyway": "Enviar mesmo assim",
  "1 more file is left out and not listed.":
    "Mais 1 arquivo foi deixado de fora e não aparece na lista.",
  "{n} more files are left out and not listed.":
    "Mais {n} arquivos foram deixados de fora e não aparecem na lista.",
  "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.":
    "Verificado pelo nome do arquivo e, nos arquivos não rastreados, pelos primeiros 64 KB. Confira a lista antes de enviar.",
  "Send anyway counts once the uncommitted files of that repository are ticked.":
    "Enviar mesmo assim só vale quando os arquivos não commitados desse repositório estão marcados.",
  "Extras from {machine}": "Extras de {machine}",
  "The extras from {machine} were not sent.": "Os extras de {machine} não foram enviados.",
  "Uncommitted files in {repository}": "Arquivos não commitados em {repository}",
  "Compare all files…": "Comparar todos os arquivos…",
  "Sync {project}": "Sincronizar {project}",
  "{project} is in sync on {source} and {machine}":
    "{project} está sincronizado em {source} e {machine}",
  "Sync {project}: {source} and {machine}": "Sincronizar {project}: {source} e {machine}",
  "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.":
    "Git primeiro. Cada máquina faz fetch do remoto e avança, só com fast-forward. Nada é sobrescrito e nada é enviado. O coordenador fica onde está.",
  "Sync {machine} with": "Sincronizar {machine} com",
  "Fetching on {source} and {machine}…": "Fazendo fetch em {source} e {machine}…",
  "Nothing was changed on either machine.": "Nada foi alterado em nenhuma das máquinas.",
  "Syncing {source} and {machine}…": "Sincronizando {source} e {machine}…",
  "Sending the ticked extras…": "Enviando os extras marcados…",
  "{machine} did not run its part.": "{machine} não executou a parte dela.",
  "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.":
    "Só o repositório principal de {machine} aparece: a pasta dele passa dos limites de varredura, então os repositórios dentro dela são ignorados.",
  "Nothing to move forward or clone. Tick an extra to send it.":
    "Nada para avançar ou clonar. Marque um extra para enviá-lo.",
  "Files outside Git on either side? Compare all files… is the slow, complete way.":
    "Arquivos fora do Git em algum dos lados? Comparar todos os arquivos… é o jeito lento e completo.",
  "Syncing…": "Sincronizando…",
  Sync: "Sincronizar",
  "Same as {shown}": "Igual a {shown}",
  "Same as {shown} · as of {time}": "Igual a {shown} · dados de {time}",
  "{k} of {n} repositories differ": "{k} de {n} repositórios diferem",
  "{k} of {n} repositories differ · as of {time}":
    "{k} de {n} repositórios diferem · dados de {time}",
  "Not checked yet": "Ainda não verificado",
  "Sync…": "Sincronizar…",
  "1 uncommitted file stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "1 arquivo não commitado fica em {source}: o Git só leva commits. Faça commit dele, ou escolha “Copiar a pasta inteira” em “Detalhes”.",
  "{count} uncommitted files stay on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "{count} arquivos não commitados ficam em {source}: o Git só leva commits. Faça commit deles, ou escolha “Copiar a pasta inteira” em “Detalhes”.",
  "Uncommitted work stays on {source}: Git carries commits only. Commit them, or choose Copy the whole folder under Details.":
    "O trabalho não commitado fica em {source}: o Git só leva commits. Faça commit dele, ou escolha “Copiar a pasta inteira” em “Detalhes”.",
  "Add to another machine": "Adicionar a outra máquina",
  "Add {project} to another machine": "Adicionar {project} a outra máquina",
  "Add {project} to {machine}": "Adicionar {project} a {machine}",
  "Compare again": "Comparar de novo",
  "Continue on {target} anyway, on its older commits":
    "Continuar em {target} mesmo assim, com os commits mais antigos",
  "Continue the coordinator on another machine": "Continuar o coordenador em outra máquina",
  "Copy the whole folder from {source}": "Copiar a pasta inteira de {source}",
  "Download from GitHub (recommended)": "Baixar do GitHub (recomendado)",
  "Folder on {machine}": "Pasta em {machine}",
  "Push it first, or choose Copy the whole folder under Details. The move goes ahead either way.":
    "Faça push primeiro, ou escolha “Copiar a pasta inteira” em “Detalhes”. A mudança acontece de qualquer forma.",
  "Push these commits and continue the coordinator on {target}.":
    "Fazer push destes commits e continuar o coordenador em {target}.",
  "Push these commits to their remotes and continue the coordinator on {target}.":
    "Fazer push destes commits para os remotos e continuar o coordenador em {target}.",
  "Sync again": "Sincronizar de novo",
  "Sync again…": "Sincronizar de novo…",
  "Run the same sync again": "Repetir a mesma sincronização",
  "Sync again with secrets": "Sincronizar de novo com segredos",
  "Sync again before handing off the coordinator.":
    "Sincronize de novo antes de passar o coordenador.",
  "Sync again brings over what changed; it compares first and moves only changed files. Continue on {target} anyway moves the coordinator with these differences. Undo puts {target}'s folder back.":
    "“Sincronizar de novo” traz o que mudou; compara primeiro e move só os arquivos alterados. “Continuar em {target} mesmo assim” move o coordenador com essas diferenças. “Desfazer” restaura a pasta de {target}.",
  "Sync again brings {source}'s version over. Move without them keeps {source}'s changes there and the copy on {target} as it is. Keep the coordinator on {source} to go on working there; the copy on {target} stays.":
    "“Sincronizar de novo” traz a versão de {source}. “Mover sem eles” mantém as alterações de {source} lá e a cópia em {target} como está. Mantenha o coordenador em {source} para continuar trabalhando lá; a cópia em {target} fica.",
  "This copy was not captured, so you can't move without them. Sync again brings them over. Or keep the coordinator on {source}; the copy on {target} stays.":
    "Esta cópia não foi capturada, então você não pode mover sem eles. “Sincronizar de novo” os traz. Ou mantenha o coordenador em {source}; a cópia em {target} fica.",
  "Add this project to another machine": "Adicionar este projeto a outra máquina",
  "{project} is on {machine}": "{project} está em {machine}",
  "{project} is on {machine} (added {when})": "{project} está em {machine} (adicionado {when})",
  "{machine} already has this project at {folder}. Compare all files compares the two folders and adds what {machine} is missing. The coordinator stays on {source}.":
    "{machine} já tem este projeto em {folder}. “Comparar todos os arquivos” compara as duas pastas e adiciona o que falta em {machine}. O coordenador fica em {source}.",
  "The coordinator continues on {target}.": "O coordenador continua em {target}.",
  "The coordinator stays here until you sync again.":
    "O coordenador fica aqui até você sincronizar de novo.",
  "The files are on {target}, but {problem}. Sync again: it compares first and moves only what changed.":
    "Os arquivos estão em {target}, mas {problem}. “Sincronizar de novo”: compara primeiro e move só o que mudou.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moved with these differences.":
    "Os arquivos estão em {target}, mas {problem}. Você escolheu “Continuar em {target} mesmo assim”, então o coordenador foi movido com essas diferenças.",
  "The files are on {target}, but {problem}. You chose Continue on {target} anyway, so the coordinator moves with these differences.":
    "Os arquivos estão em {target}, mas {problem}. Você escolheu “Continuar em {target} mesmo assim”, então o coordenador vai ser movido com essas diferenças.",
  "The source changed. Compare again.": "A origem mudou. Comparar de novo.",
  "The source changed. You can still copy the captured files, or compare again for newer work.":
    "A origem mudou. Você ainda pode copiar os arquivos capturados, ou comparar de novo para pegar trabalho mais recente.",
  "{source} changed after copying. Sync again before moving the coordinator.":
    "{source} mudou depois da cópia. Sincronize de novo antes de mover o coordenador.",
  "This project has no Git remote, so {machine} has nothing to clone from. Copy its folder there instead: the machine menu > Add to another machine… > Copy the whole folder.":
    "Este projeto não tem remoto Git, então {machine} não tem de onde clonar. Copie a pasta para lá: menu da máquina > Adicionar a outra máquina… > Copiar a pasta inteira.",
  "{there} already has the coordinator, at {folder}.": "{there} já tem o coordenador, em {folder}.",
  "{there} already has this project, at {folder}. Sync brings it up to date.":
    "{there} já tem este projeto, em {folder}. A sincronização o atualiza.",
  "{there} has this project in {n} folders. Pick one.":
    "{there} tem este projeto em {n} pastas. Escolha uma.",
};
