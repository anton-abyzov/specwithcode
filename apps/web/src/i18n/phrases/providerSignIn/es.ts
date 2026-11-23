import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInEs: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}":
    "Otros inicios de sesión de GitHub en {environmentLabel}",
  "These are not Copilot CLI's own sign-in.": "No son el inicio de sesión propio de Copilot CLI.",
  "Installed on {environmentLabel}. Not signed in yet.":
    "Instalado en {environmentLabel}. Aún sin iniciar sesión.",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "Instalado en {environmentLabel}. Inicio de sesión aún sin verificar.",
  "Not installed on {environmentLabel} yet.": "Aún no está instalado en {environmentLabel}.",
  "Could not read the sign-in state on {environmentLabel}.":
    "No se pudo leer el estado de inicio de sesión en {environmentLabel}.",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "Esperando a que {environmentLabel} informe de este proveedor. Aún no se conoce su estado de inicio de sesión.",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "Omitir deja este proveedor en {environmentLabel} sin iniciar sesión. No podrá ejecutar hilos allí hasta que inicies sesión en Ajustes > Proveedores.",
  "Installed on {environmentLabel}. Google refused this account for Gemini CLI.":
    "Instalado en {environmentLabel}. Google rechazó esta cuenta para Gemini CLI.",
  "Use an API key": "Usar una clave de API",
  "About Antigravity": "Acerca de Antigravity",
};
