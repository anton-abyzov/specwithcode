import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInFr: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}": "Autres connexions GitHub sur {environmentLabel}",
  "These are not Copilot CLI's own sign-in.": "Ce ne sont pas la connexion propre à Copilot CLI.",
  "Installed on {environmentLabel}. Not signed in yet.":
    "Installé sur {environmentLabel}. Pas encore connecté.",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "Installé sur {environmentLabel}. Connexion pas encore vérifiée.",
  "Not installed on {environmentLabel} yet.": "Pas encore installé sur {environmentLabel}.",
  "Could not read the sign-in state on {environmentLabel}.":
    "Impossible de lire l'état de connexion sur {environmentLabel}.",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "En attente que {environmentLabel} signale ce fournisseur. Son état de connexion n'est pas encore connu.",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "Ignorer laisse ce fournisseur sur {environmentLabel} sans connexion. Il ne pourra pas y exécuter de fils tant que vous ne vous connectez pas dans Réglages > Fournisseurs.",
  "Installed on {environmentLabel}. Google refused this account for Gemini CLI.":
    "Installé sur {environmentLabel}. Google a refusé ce compte pour Gemini CLI.",
  "Use an API key": "Utiliser une clé API",
};
