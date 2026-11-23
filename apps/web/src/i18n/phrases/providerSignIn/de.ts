import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInDe: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}": "Andere GitHub-Anmeldungen auf {environmentLabel}",
  "These are not Copilot CLI's own sign-in.": "Das ist nicht die eigene Anmeldung der Copilot CLI.",
  "Installed on {environmentLabel}. Not signed in yet.":
    "Auf {environmentLabel} installiert. Noch nicht angemeldet.",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "Auf {environmentLabel} installiert. Anmeldung noch nicht bestätigt.",
  "Not installed on {environmentLabel} yet.": "Auf {environmentLabel} noch nicht installiert.",
  "Could not read the sign-in state on {environmentLabel}.":
    "Der Anmeldestatus auf {environmentLabel} konnte nicht gelesen werden.",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "Warten, bis {environmentLabel} diesen Anbieter meldet. Sein Anmeldestatus ist noch nicht bekannt.",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "Überspringen lässt diesen Anbieter ohne Anmeldung auf {environmentLabel}. Er kann dort keine Threads ausführen, bis du dich unter Einstellungen > Anbieter anmeldest.",
  "Installed on {environmentLabel}. Google refused this account for Gemini CLI.":
    "Auf {environmentLabel} installiert. Google hat dieses Konto für Gemini CLI abgelehnt.",
  "Use an API key": "API-Schlüssel verwenden",
};
