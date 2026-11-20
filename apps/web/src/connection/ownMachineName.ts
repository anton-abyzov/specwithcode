/**
 * This computer's machine name, as its own server reports it (1327). A
 * connection reads it to tell another machine which device is asking for
 * approval. Kept here, not read from the server state, because the
 * connection layer loads before that state and must not import it.
 */
let ownMachineName: string | undefined;

export const rememberOwnMachineName = (label: string | null | undefined): void => {
  ownMachineName = label?.trim() || undefined;
};

export const currentOwnMachineName = (): string | undefined => ownMachineName;
