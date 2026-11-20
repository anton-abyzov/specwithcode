/**
 * What most likely fixes an agent whose check failed, read from the machine's
 * own words. Every failed agent gets all three ways out (sign in again,
 * reinstall or update, pick its command); the likely one leads.
 */
export type ProviderRepairKind = "signIn" | "reinstall" | "pickBinary";

export interface ProviderRepairAdvice {
  /** The way out to show first. */
  readonly likely: ProviderRepairKind | null;
  /** Every way out, likely first. */
  readonly order: ReadonlyArray<ProviderRepairKind>;
}

const SIGN_IN =
  /token[_ ]expired|refresh[_ ]token|invalid[_ ]grant|unauthori[sz]ed|\b401\b|not (?:logged|signed) in|log ?in again|sign ?in again|run `?\S*\s*(?:auth )?login|requires? (?:openai )?auth|session expired|authenticat(?:e|ion) (?:failed|required)/i;
const REINSTALL =
  /missing optional dependency|cannot find module|err_module_not_found|reinstall|npm install -g|corrupt|incompatible|unsupported (?:cpu|platform|architecture)|exec format error|bad cpu type|symbol not found|GLIBC_|is not a function|syntaxerror/i;
const PICK_BINARY =
  /enoent|no such file|not found|command not found|could not start|permission denied|eacces|exit code 127|binary path|is not executable|spawn/i;

const ALL: ReadonlyArray<ProviderRepairKind> = ["signIn", "reinstall", "pickBinary"];

export function providerRepairAdvice(message: string | null | undefined): ProviderRepairAdvice {
  const text = message ?? "";
  const likely: ProviderRepairKind | null = SIGN_IN.test(text)
    ? "signIn"
    : REINSTALL.test(text)
      ? "reinstall"
      : PICK_BINARY.test(text)
        ? "pickBinary"
        : null;
  return {
    likely,
    order: likely === null ? ALL : [likely, ...ALL.filter((kind) => kind !== likely)],
  };
}

/**
 * A command found in a folder that only lives as long as one terminal: fnm's
 * per-shell folders, and the system temp folders. Shown as a warning, since
 * the next restart may lose it.
 */
export function isVolatileCommandPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return /[\\/]fnm_multishells[\\/]|^\/(?:tmp|private\/tmp|var\/folders)\/|[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(
    path,
  );
}
