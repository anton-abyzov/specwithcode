import type { PhraseCatalog } from "../../phrases";

/** Which machine the window, the coordinator and its messages are on (1427). */
export const machineLabelsJa: PhraseCatalog = {
  "Window on {machine}": "ウィンドウ: {machine}",
  "{machine}'s coordinator": "{machine} のコーディネーター",
  "Showing {machine}'s coordinator. This window runs on {window}.":
    "{machine} のコーディネーターを表示中です。このウィンドウは {window} で動いています。",
  "this window": "このウィンドウ",
  "Coordinator on {machine} · {model}": "{machine} のコーディネーター · {model}",
  "To {machine}'s coordinator": "{machine} のコーディネーター宛て",
  "Restart {machine} to update": "{machine} を再起動して更新",
  "Update {machine} now": "{machine} を今すぐ更新",
  "Retry update on {machine}": "{machine} で更新を再試行",
  "{machine} is not connected. Changes can be made once it reconnects.":
    "{machine} は接続されていません。再接続すると変更できます。",
  "{machine} · this window": "{machine} · このウィンドウ",
  "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.":
    "{machine} が {project} に加わります。各マシンは自分のコーディネーターを持ち続けます。リンクで移動するものはありません。",
  "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.":
    "各マシンは自分のコーディネーターを持ち続けます。{main} の会話を {machine} で続けるには、リンク後に「ここで続行」を使ってください。",
  "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.":
    "{machine} をこのプロジェクトにリンクします。{machine} は自分の目標と指示を手放し、今後はこのプロジェクトのものに従います。各マシンは自分のコーディネーターを持ち続け、{machine} のワーカーは動き続けます。ファイルはコピーされません。",
  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.":
    "{project} は {main} と {machine} で 1 つのプロジェクトです。各マシンは自分のコーディネーターを持ち続けます。",
  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.":
    "各マシンは自分のコーディネーターを持ち続け、{machine} のワーカーは動き続けます。{main} から {machine} に作業を送るには、設定 > マシン で {machine} のカードの「許可」を選んでください。",
  "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.":
    "1 つのプロジェクトにします。各マシンは自分のコーディネーターを持ち続け、両方のワーカーは動き続けます。ファイルはコピーされません。",
};
