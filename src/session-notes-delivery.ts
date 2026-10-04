/** Notes delivery rejects overlapping confirmations before their first transport write. */
export class SessionNotesInputBusyError extends Error {
  override readonly name = 'SessionNotesInputBusyError';
  constructor() {
    super('Destination is already receiving a notes send. Nothing was sent for this confirmation.');
  }
}
