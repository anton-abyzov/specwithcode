import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInPt: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}": "Outros logins do GitHub em {environmentLabel}",
  "These are not Copilot CLI's own sign-in.": "Eles não são o login próprio do Copilot CLI.",
  "Installed on {environmentLabel}. Not signed in yet.":
    "Instalado em {environmentLabel}. Ainda sem login.",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "Instalado em {environmentLabel}. Login ainda não verificado.",
  "Not installed on {environmentLabel} yet.": "Ainda não instalado em {environmentLabel}.",
  "Could not read the sign-in state on {environmentLabel}.":
    "Não foi possível ler o estado de login em {environmentLabel}.",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "Aguardando {environmentLabel} informar este provedor. O estado de login dele ainda não é conhecido.",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "Pular mantém este provedor em {environmentLabel} sem login. Ele não poderá executar threads lá até você fazer login em Configurações > Provedores.",
  "Installed on {environmentLabel}. Google refused this account for Gemini CLI.":
    "Instalado em {environmentLabel}. O Google recusou esta conta para o Gemini CLI.",
  "Use an API key": "Usar uma chave de API",
};
