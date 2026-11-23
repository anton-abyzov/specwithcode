import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInRu: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}": "Другие входы GitHub на {environmentLabel}",
  "These are not Copilot CLI's own sign-in.": "Это не собственный вход Copilot CLI.",
  "Installed on {environmentLabel}. Not signed in yet.":
    "Установлено на {environmentLabel}. Вход ещё не выполнен.",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "Установлено на {environmentLabel}. Вход ещё не подтверждён.",
  "Not installed on {environmentLabel} yet.": "На {environmentLabel} ещё не установлено.",
  "Could not read the sign-in state on {environmentLabel}.":
    "Не удалось прочитать состояние входа на {environmentLabel}.",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "Ждём, пока {environmentLabel} сообщит об этом провайдере. Состояние входа пока неизвестно.",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "Если пропустить, провайдер останется на {environmentLabel} без входа. Он не сможет запускать треды там, пока вы не войдёте в «Настройки > Провайдеры».",
  "Installed on {environmentLabel}. Google refused this account for Gemini CLI.":
    "Установлено на {environmentLabel}. Google отклонил этот аккаунт для Gemini CLI.",
  "Use an API key": "Использовать API-ключ",
  "About Antigravity": "Об Antigravity",
};
