import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsRu: PhraseCatalog = {
  "Window on {machine}": "Окно на {machine}",
  "{machine}'s coordinator": "Координатор {machine}",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "Показан координатор {machine}. Это окно работает на {window}.",
  "this window": "это окно",
  "Coordinator on {machine} · {model}": "Координатор на {machine} · {model}",
  "To {machine}'s coordinator": "Координатору {machine}",
  "Restart {machine} to update": "Перезапустить {machine} для обновления",
  "Update {machine} now": "Обновить {machine} сейчас",
  "Retry update on {machine}": "Повторить обновление на {machine}",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} не подключена. Изменения можно будет внести после переподключения.",
  "{machine} · this window": "{machine} · это окно",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} присоединяется к {project}. Каждая машина сохраняет свой координатор: связывание ничего не переносит.",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "Каждая машина сохраняет свой координатор. Чтобы продолжить разговор {main} на {machine}, после связывания нажмите «Продолжить здесь».",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "Связать {machine} с этим проектом. {machine} отказывается от своей цели и инструкций: с этого момента она следует инструкциям этого проекта. Каждая машина сохраняет свой координатор, и исполнители на {machine} продолжают работу. Файлы не копируются.",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} теперь один проект на {main} и {machine}. Каждая машина сохраняет свой координатор.",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "Каждая машина сохраняет свой координатор, и исполнители на {machine} продолжают работу. Чтобы отправлять работу на {machine} с {main}, нажмите «Разрешить» на карточке {machine} в «Настройки > Машины».",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "Сделать их одним проектом. Каждая машина сохраняет свой координатор, и исполнители на обеих продолжают работу. Файлы не копируются.",
};
