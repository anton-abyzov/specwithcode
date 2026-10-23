export const messages: unknown[] = [];
export const toastManager = { add: (message: unknown) => messages.push(message) };
Object.assign(window, { liveErrors: messages });
