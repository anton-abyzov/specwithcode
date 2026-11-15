/**
 * Strings for the "Install SpecWithCode" step. It runs before any window, so
 * it cannot use the web app's translations; this table covers the same nine
 * languages (apps/web/src/i18n/locale.ts). `{version}`, `{folder}` and
 * `{error}` are filled in by the caller.
 */

export const SELF_INSTALL_LOCALES = [
  "en",
  "ru",
  "es",
  "zh-CN",
  "ja",
  "pt-BR",
  "ko",
  "de",
  "fr",
] as const;
export type SelfInstallLocale = (typeof SELF_INSTALL_LOCALES)[number];

export interface SelfInstallCopy {
  readonly offerTitle: string;
  readonly offerDetail: string;
  readonly replaceDetail: string;
  readonly userFolderDetail: string;
  readonly install: string;
  readonly notNow: string;
  readonly installedTitle: string;
  readonly installedDetail: string;
  readonly openIt: string;
  readonly runningTitle: string;
  readonly runningDetail: string;
  readonly switchToIt: string;
  readonly quitOlderTitle: string;
  readonly quitOlderDetail: string;
  readonly blockedTitle: string;
  readonly blockedDetail: string;
  readonly failedTitle: string;
  readonly failedDetail: string;
  readonly ok: string;
}

const COPY: Readonly<Record<SelfInstallLocale, SelfInstallCopy>> = {
  en: {
    offerTitle: "Install SpecWithCode",
    offerDetail:
      "SpecWithCode is running from the disk image. Install it in the {folder} folder so it stays after you eject the disk image and keeps itself up to date.",
    replaceDetail: "The older version in the {folder} folder is replaced. Your settings stay.",
    userFolderDetail:
      "This Mac only lets administrators add apps to the main Applications folder, so SpecWithCode goes into the Applications folder in your home folder, for you only. If you put the disk image copy in the Dock, replace it with the new one.",
    install: "Install",
    notNow: "Not now",
    installedTitle: "SpecWithCode is already installed",
    installedDetail: "The {folder} folder already has version {version}. Open that copy instead?",
    openIt: "Open it",
    runningTitle: "SpecWithCode is already open",
    runningDetail: "The copy in the {folder} folder is running. Switch to it?",
    switchToIt: "Switch to it",
    quitOlderTitle: "Quit the older SpecWithCode first",
    quitOlderDetail:
      "An older version is open from the {folder} folder. Quit it, then click Install.",
    blockedTitle: "SpecWithCode can't be installed",
    blockedDetail:
      "The {folder} folder already has a different app with the same name. Move that app somewhere else, then open SpecWithCode again.",
    failedTitle: "SpecWithCode couldn't be installed",
    failedDetail: "{error}\n\nYou can drag SpecWithCode into Applications instead.",
    ok: "OK",
  },
  ru: {
    offerTitle: "Установить SpecWithCode",
    offerDetail:
      "SpecWithCode запущен с образа диска. Установите его в папку {folder}: тогда он останется после извлечения образа и будет обновляться сам.",
    replaceDetail: "Старая версия в папке {folder} будет заменена. Настройки сохранятся.",
    userFolderDetail:
      "На этом Mac добавлять приложения в общую папку «Программы» могут только администраторы, поэтому SpecWithCode будет установлен в папку «Программы» в вашей домашней папке, только для вас. Если вы закрепили копию с образа диска в Dock, замените её новой.",
    install: "Установить",
    notNow: "Не сейчас",
    installedTitle: "SpecWithCode уже установлен",
    installedDetail: "В папке {folder} уже есть версия {version}. Открыть её?",
    openIt: "Открыть",
    runningTitle: "SpecWithCode уже открыт",
    runningDetail: "Копия из папки {folder} уже запущена. Перейти к ней?",
    switchToIt: "Перейти",
    quitOlderTitle: "Сначала закройте старый SpecWithCode",
    quitOlderDetail: "Открыта старая версия из папки {folder}. Закройте её и нажмите «Установить».",
    blockedTitle: "Не удаётся установить SpecWithCode",
    blockedDetail:
      "В папке {folder} уже есть другое приложение с таким же именем. Переместите его в другое место и снова откройте SpecWithCode.",
    failedTitle: "Не удалось установить SpecWithCode",
    failedDetail: "{error}\n\nМожно перетащить SpecWithCode в папку «Программы» вручную.",
    ok: "ОК",
  },
  es: {
    offerTitle: "Instalar SpecWithCode",
    offerDetail:
      "SpecWithCode se está ejecutando desde la imagen de disco. Instálalo en la carpeta {folder} para que siga ahí cuando expulses la imagen y se actualice solo.",
    replaceDetail:
      "Se reemplaza la versión anterior de la carpeta {folder}. Tus ajustes se conservan.",
    userFolderDetail:
      "En este Mac solo los administradores pueden añadir apps a la carpeta Aplicaciones principal, así que SpecWithCode se instala en la carpeta Aplicaciones de tu carpeta de inicio, solo para ti. Si pusiste la copia de la imagen de disco en el Dock, cámbiala por la nueva.",
    install: "Instalar",
    notNow: "Ahora no",
    installedTitle: "SpecWithCode ya está instalado",
    installedDetail: "La carpeta {folder} ya tiene la versión {version}. ¿Abrir esa copia?",
    openIt: "Abrir",
    runningTitle: "SpecWithCode ya está abierto",
    runningDetail: "La copia de la carpeta {folder} está en uso. ¿Cambiar a ella?",
    switchToIt: "Cambiar",
    quitOlderTitle: "Cierra primero el SpecWithCode anterior",
    quitOlderDetail:
      "Hay una versión anterior abierta desde la carpeta {folder}. Ciérrala y luego haz clic en Instalar.",
    blockedTitle: "No se puede instalar SpecWithCode",
    blockedDetail:
      "La carpeta {folder} ya tiene otra app con el mismo nombre. Muévela a otro sitio y vuelve a abrir SpecWithCode.",
    failedTitle: "No se pudo instalar SpecWithCode",
    failedDetail: "{error}\n\nTambién puedes arrastrar SpecWithCode a Aplicaciones.",
    ok: "Aceptar",
  },
  "zh-CN": {
    offerTitle: "安装 SpecWithCode",
    offerDetail:
      "SpecWithCode 正在从磁盘映像运行。将它安装到“{folder}”文件夹，推出磁盘映像后它仍然可用，并会自动更新。",
    replaceDetail: "“{folder}”文件夹中的旧版本将被替换，你的设置会保留。",
    userFolderDetail:
      "这台 Mac 只允许管理员向主“应用程序”文件夹添加应用，因此 SpecWithCode 会安装到你个人文件夹中的“应用程序”文件夹，仅供你使用。如果你把磁盘映像中的副本放进了程序坞，请换成新的副本。",
    install: "安装",
    notNow: "以后再说",
    installedTitle: "SpecWithCode 已安装",
    installedDetail: "“{folder}”文件夹中已有版本 {version}。改为打开该副本？",
    openIt: "打开",
    runningTitle: "SpecWithCode 已经打开",
    runningDetail: "“{folder}”文件夹中的副本正在运行。切换到它？",
    switchToIt: "切换",
    quitOlderTitle: "请先退出旧版 SpecWithCode",
    quitOlderDetail: "“{folder}”文件夹中的旧版本正在运行。请退出它，然后点击“安装”。",
    blockedTitle: "无法安装 SpecWithCode",
    blockedDetail:
      "“{folder}”文件夹中已有另一个同名应用。请将其移到别处，然后重新打开 SpecWithCode。",
    failedTitle: "SpecWithCode 安装失败",
    failedDetail: "{error}\n\n你也可以将 SpecWithCode 拖到“应用程序”文件夹。",
    ok: "好",
  },
  ja: {
    offerTitle: "SpecWithCode をインストール",
    offerDetail:
      "SpecWithCode はディスクイメージから実行されています。{folder}フォルダにインストールすると、ディスクイメージを取り出した後も使え、自動でアップデートされます。",
    replaceDetail:
      "{folder}フォルダにある古いバージョンは置き換えられます。設定はそのまま残ります。",
    userFolderDetail:
      "この Mac では、メインの「アプリケーション」フォルダにアプリを追加できるのは管理者だけです。そのため SpecWithCode はホームフォルダ内の「アプリケーション」フォルダに、あなた専用としてインストールされます。ディスクイメージのコピーを Dock に置いている場合は、新しいものに置き換えてください。",
    install: "インストール",
    notNow: "今はしない",
    installedTitle: "SpecWithCode はインストール済みです",
    installedDetail:
      "{folder}フォルダにはすでにバージョン {version} があります。そちらを開きますか？",
    openIt: "開く",
    runningTitle: "SpecWithCode はすでに開いています",
    runningDetail: "{folder}フォルダのコピーが実行中です。そちらに切り替えますか？",
    switchToIt: "切り替える",
    quitOlderTitle: "先に古い SpecWithCode を終了してください",
    quitOlderDetail:
      "{folder}フォルダの古いバージョンが開いています。終了してから「インストール」をクリックしてください。",
    blockedTitle: "SpecWithCode をインストールできません",
    blockedDetail:
      "{folder}フォルダに同じ名前の別のアプリがあります。そのアプリを別の場所に移動してから、もう一度 SpecWithCode を開いてください。",
    failedTitle: "SpecWithCode をインストールできませんでした",
    failedDetail:
      "{error}\n\nSpecWithCode を「アプリケーション」フォルダにドラッグしてもインストールできます。",
    ok: "OK",
  },
  "pt-BR": {
    offerTitle: "Instalar o SpecWithCode",
    offerDetail:
      "O SpecWithCode está rodando a partir da imagem de disco. Instale-o na pasta {folder} para que ele continue disponível depois de ejetar a imagem e se atualize sozinho.",
    replaceDetail: "A versão antiga na pasta {folder} será substituída. Suas configurações ficam.",
    userFolderDetail:
      "Neste Mac, só administradores podem adicionar apps à pasta Aplicativos principal. Por isso o SpecWithCode será instalado na pasta Aplicativos da sua pasta pessoal, só para você. Se você colocou a cópia da imagem de disco no Dock, troque pela nova.",
    install: "Instalar",
    notNow: "Agora não",
    installedTitle: "O SpecWithCode já está instalado",
    installedDetail: "A pasta {folder} já tem a versão {version}. Abrir essa cópia?",
    openIt: "Abrir",
    runningTitle: "O SpecWithCode já está aberto",
    runningDetail: "A cópia na pasta {folder} está em execução. Mudar para ela?",
    switchToIt: "Mudar",
    quitOlderTitle: "Feche o SpecWithCode antigo primeiro",
    quitOlderDetail:
      "Uma versão antiga está aberta a partir da pasta {folder}. Feche-a e clique em Instalar.",
    blockedTitle: "Não é possível instalar o SpecWithCode",
    blockedDetail:
      "A pasta {folder} já tem outro app com o mesmo nome. Mova esse app para outro lugar e abra o SpecWithCode de novo.",
    failedTitle: "Não foi possível instalar o SpecWithCode",
    failedDetail: "{error}\n\nVocê também pode arrastar o SpecWithCode para Aplicativos.",
    ok: "OK",
  },
  ko: {
    offerTitle: "SpecWithCode 설치",
    offerDetail:
      "SpecWithCode가 디스크 이미지에서 실행 중입니다. {folder} 폴더에 설치하면 디스크 이미지를 추출한 뒤에도 남아 있고 스스로 업데이트됩니다.",
    replaceDetail: "{folder} 폴더에 있는 이전 버전이 교체됩니다. 설정은 그대로 유지됩니다.",
    userFolderDetail:
      "이 Mac에서는 관리자만 기본 응용 프로그램 폴더에 앱을 추가할 수 있어서, SpecWithCode는 홈 폴더의 응용 프로그램 폴더에 나만 쓰도록 설치됩니다. 디스크 이미지의 사본을 Dock에 넣었다면 새 사본으로 바꾸세요.",
    install: "설치",
    notNow: "나중에",
    installedTitle: "SpecWithCode가 이미 설치되어 있습니다",
    installedDetail: "{folder} 폴더에 이미 버전 {version}이(가) 있습니다. 그 사본을 열까요?",
    openIt: "열기",
    runningTitle: "SpecWithCode가 이미 열려 있습니다",
    runningDetail: "{folder} 폴더에 있는 사본이 실행 중입니다. 그쪽으로 전환할까요?",
    switchToIt: "전환",
    quitOlderTitle: "먼저 이전 SpecWithCode를 종료하세요",
    quitOlderDetail: "{folder} 폴더에서 이전 버전이 열려 있습니다. 종료한 다음 설치를 클릭하세요.",
    blockedTitle: "SpecWithCode를 설치할 수 없습니다",
    blockedDetail:
      "{folder} 폴더에 이름이 같은 다른 앱이 있습니다. 그 앱을 다른 곳으로 옮긴 다음 SpecWithCode를 다시 여세요.",
    failedTitle: "SpecWithCode를 설치하지 못했습니다",
    failedDetail: "{error}\n\nSpecWithCode를 응용 프로그램 폴더로 드래그해도 됩니다.",
    ok: "확인",
  },
  de: {
    offerTitle: "SpecWithCode installieren",
    offerDetail:
      "SpecWithCode läuft vom Disk-Image. Installiere es in den Ordner {folder}, damit es nach dem Auswerfen des Images bleibt und sich selbst aktualisiert.",
    replaceDetail:
      "Die ältere Version im Ordner {folder} wird ersetzt. Deine Einstellungen bleiben.",
    userFolderDetail:
      "Auf diesem Mac dürfen nur Administratoren Apps zum Hauptordner „Programme“ hinzufügen. SpecWithCode wird deshalb in den Ordner „Programme“ in deinem Benutzerordner installiert, nur für dich. Wenn du die Kopie vom Disk-Image ins Dock gelegt hast, ersetze sie durch die neue.",
    install: "Installieren",
    notNow: "Nicht jetzt",
    installedTitle: "SpecWithCode ist schon installiert",
    installedDetail:
      "Im Ordner {folder} ist schon Version {version}. Stattdessen diese Kopie öffnen?",
    openIt: "Öffnen",
    runningTitle: "SpecWithCode ist schon geöffnet",
    runningDetail: "Die Kopie im Ordner {folder} läuft. Zu ihr wechseln?",
    switchToIt: "Wechseln",
    quitOlderTitle: "Beende zuerst das ältere SpecWithCode",
    quitOlderDetail:
      "Eine ältere Version aus dem Ordner {folder} ist geöffnet. Beende sie und klicke dann auf „Installieren“.",
    blockedTitle: "SpecWithCode kann nicht installiert werden",
    blockedDetail:
      "Im Ordner {folder} gibt es schon eine andere App mit demselben Namen. Verschiebe sie an einen anderen Ort und öffne SpecWithCode dann erneut.",
    failedTitle: "SpecWithCode konnte nicht installiert werden",
    failedDetail: "{error}\n\nDu kannst SpecWithCode auch in den Ordner „Programme“ ziehen.",
    ok: "OK",
  },
  fr: {
    offerTitle: "Installer SpecWithCode",
    offerDetail:
      "SpecWithCode s’exécute depuis l’image disque. Installez-le dans le dossier {folder} pour qu’il reste disponible après l’éjection de l’image et se mette à jour tout seul.",
    replaceDetail:
      "L’ancienne version du dossier {folder} est remplacée. Vos réglages sont conservés.",
    userFolderDetail:
      "Sur ce Mac, seuls les administrateurs peuvent ajouter des apps au dossier Applications principal. SpecWithCode est donc installé dans le dossier Applications de votre dossier personnel, pour vous seul. Si vous avez placé la copie de l’image disque dans le Dock, remplacez-la par la nouvelle.",
    install: "Installer",
    notNow: "Plus tard",
    installedTitle: "SpecWithCode est déjà installé",
    installedDetail: "Le dossier {folder} contient déjà la version {version}. Ouvrir cette copie ?",
    openIt: "Ouvrir",
    runningTitle: "SpecWithCode est déjà ouvert",
    runningDetail: "La copie du dossier {folder} est en cours d’exécution. Y passer ?",
    switchToIt: "Y passer",
    quitOlderTitle: "Quittez d’abord l’ancien SpecWithCode",
    quitOlderDetail:
      "Une ancienne version est ouverte depuis le dossier {folder}. Quittez-la, puis cliquez sur Installer.",
    blockedTitle: "Impossible d’installer SpecWithCode",
    blockedDetail:
      "Le dossier {folder} contient déjà une autre app portant le même nom. Déplacez-la ailleurs, puis rouvrez SpecWithCode.",
    failedTitle: "SpecWithCode n’a pas pu être installé",
    failedDetail: "{error}\n\nVous pouvez aussi faire glisser SpecWithCode dans Applications.",
    ok: "OK",
  },
};

/** Best supported match for a BCP 47 tag, the same rules as the web app's `matchLocale`. */
export function matchSelfInstallLocale(tag: string): SelfInstallLocale | null {
  const [language] = tag.trim().toLowerCase().split(/[-_]/);
  switch (language) {
    case "en":
    case "ru":
    case "es":
    case "ja":
    case "ko":
    case "de":
    case "fr":
      return language;
    case "zh":
      return "zh-CN";
    case "pt":
      return "pt-BR";
    default:
      return null;
  }
}

export function resolveSelfInstallLocale(languages: ReadonlyArray<string>): SelfInstallLocale {
  for (const tag of languages) {
    const match = matchSelfInstallLocale(tag);
    if (match !== null) return match;
  }
  return "en";
}

export function selfInstallCopy(locale: SelfInstallLocale): SelfInstallCopy {
  return COPY[locale];
}

/** Replaces `{name}` placeholders; unknown names stay as written. */
export function fillCopy(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * The folder's name as it goes into the strings above: Finder's name for the
 * main Applications folder, or `~/Applications` for the one in the home folder.
 */
export function folderLabel(locale: SelfInstallLocale, userFolder: boolean): string {
  if (userFolder) return "~/Applications";
  const labels: Readonly<Record<SelfInstallLocale, string>> = {
    en: "Applications",
    ru: "«Программы»",
    es: "Aplicaciones",
    "zh-CN": "应用程序",
    ja: "「アプリケーション」",
    "pt-BR": "Aplicativos",
    ko: "응용 프로그램",
    de: "„Programme“",
    fr: "Applications",
  };
  return labels[locale];
}
