export class ChatAbortedError extends Error {
  constructor(message = 'Chat aborted') {
    super(message);
    this.name = 'ChatAbortedError';
  }
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ChatAbortedError();
  }
}
