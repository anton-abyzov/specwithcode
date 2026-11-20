import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsEs: PhraseCatalog = {
  "Window on {machine}":
    "Ventana en {machine}",
  "{machine}'s coordinator":
    "Coordinador de {machine}",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "Se muestra el coordinador de {machine}. Esta ventana se ejecuta en {window}.",
  "this window":
    "esta ventana",
  "Coordinator on {machine} · {model}":
    "Coordinador en {machine} · {model}",
  "To {machine}'s coordinator":
    "Al coordinador de {machine}",
  "Restart {machine} to update":
    "Reiniciar {machine} para actualizar",
  "Update {machine} now":
    "Actualizar {machine} ahora",
  "Retry update on {machine}":
    "Reintentar la actualización en {machine}",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} no está conectada. Podrás hacer cambios cuando se vuelva a conectar.",
  "{machine} · this window":
    "{machine} · esta ventana",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} se une a {project}. Cada máquina conserva su propio coordinador: vincular no mueve nada.",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "Cada máquina conserva su propio coordinador. Para continuar la conversación de {main} en {machine}, usa «Continuar aquí» después de vincular.",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "Vincular {machine} a este proyecto. {machine} renuncia a su propio objetivo e instrucciones: desde ahora sigue los de este proyecto. Cada máquina conserva su propio coordinador, y los trabajadores de {machine} siguen en marcha. No se copian archivos.",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} es un solo proyecto en {main} y {machine}. Cada máquina conserva su propio coordinador.",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "Cada máquina conserva su propio coordinador, y los trabajadores de {machine} siguen en marcha. Para enviar trabajo a {machine} desde {main}, elige Permitir en la tarjeta de {machine} en Ajustes > Máquinas.",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "Convertirlos en un solo proyecto. Cada máquina conserva su propio coordinador, y los trabajadores de ambas siguen en marcha. No se copian archivos.",
};
