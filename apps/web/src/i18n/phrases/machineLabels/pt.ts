import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsPt: PhraseCatalog = {
  "Window on {machine}": "Janela em {machine}",
  "{machine}'s coordinator": "Coordenador de {machine}",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "Mostrando o coordenador de {machine}. Esta janela roda em {window}.",
  "this window": "esta janela",
  "Coordinator on {machine} · {model}": "Coordenador em {machine} · {model}",
  "To {machine}'s coordinator": "Para o coordenador de {machine}",
  "Restart {machine} to update": "Reiniciar {machine} para atualizar",
  "Update {machine} now": "Atualizar {machine} agora",
  "Retry update on {machine}": "Tentar atualizar {machine} de novo",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} não está conectada. As alterações podem ser feitas quando ela se reconectar.",
  "{machine} · this window": "{machine} · esta janela",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} entra em {project}. Cada máquina mantém seu próprio coordenador: vincular não move nada.",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "Cada máquina mantém seu próprio coordenador. Para continuar a conversa de {main} em {machine}, use Continuar aqui depois de vincular.",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "Vincular {machine} a este projeto. {machine} abre mão do próprio objetivo e das próprias instruções: passa a seguir os deste projeto. Cada máquina mantém seu próprio coordenador, e os workers de {machine} continuam rodando. Os arquivos não são copiados.",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} é um só projeto em {main} e {machine}. Cada máquina mantém seu próprio coordenador.",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "Cada máquina mantém seu próprio coordenador, e os workers de {machine} continuam rodando. Para enviar trabalho para {machine} a partir de {main}, escolha Permitir no cartão de {machine} em Configurações > Máquinas.",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "Transformar em um só projeto. Cada máquina mantém seu próprio coordenador, e os workers das duas continuam rodando. Os arquivos não são copiados.",
};
