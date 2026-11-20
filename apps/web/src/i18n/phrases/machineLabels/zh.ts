import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsZh: PhraseCatalog = {
  "Window on {machine}": "窗口在 {machine}",
  "{machine}'s coordinator": "{machine} 的协调器",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "正在显示 {machine} 的协调器。此窗口运行在 {window}。",
  "this window": "此窗口",
  "Coordinator on {machine} · {model}": "{machine} 上的协调器 · {model}",
  "To {machine}'s coordinator": "发给 {machine} 的协调器",
  "Restart {machine} to update": "重启 {machine} 以更新",
  "Update {machine} now": "立即更新 {machine}",
  "Retry update on {machine}": "在 {machine} 上重试更新",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} 未连接。重新连接后即可更改。",
  "{machine} · this window": "{machine} · 此窗口",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} 加入 {project}。每台机器保留自己的协调器：关联不会移动任何内容。",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "每台机器保留自己的协调器。若要在 {machine} 上继续 {main} 的对话，请在关联后使用“在这里继续”。",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "将 {machine} 关联到此项目。{machine} 放弃自己的目标和说明：从现在起遵循此项目的。每台机器保留自己的协调器，{machine} 上的工作线程继续运行。不会复制文件。",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} 现在是 {main} 和 {machine} 上的同一个项目。每台机器保留自己的协调器。",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "每台机器保留自己的协调器，{machine} 上的工作线程继续运行。若要从 {main} 向 {machine} 发送工作，请在“设置 > 机器”中 {machine} 的卡片上选择“允许”。",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "将它们合为一个项目。每台机器保留自己的协调器，两台机器上的工作线程都继续运行。不会复制文件。",
};
