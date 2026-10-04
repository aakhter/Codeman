/** Owner-private explicit notes delivery through the ordinary session input primitives. */
import type { Session } from '../session.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import type { RemoteWakeRegistry } from '../remote-wake.js';
export type NotesDelivery = { delivery: 'submitted' | 'failed' | 'unknown'; message?: string };
export function notesDestination(session: Session, owner?: string): boolean {
  return (
    (owner === undefined || session.owner === owner) && session.pid != null && ['idle', 'busy'].includes(session.status)
  );
}
export async function deliverNotesInput(
  sessions: ReadonlyMap<string, Session>,
  mux: Pick<TerminalMultiplexer, 'isPaneDead'>,
  wake: Pick<RemoteWakeRegistry, 'checkReachable'> | null,
  id: string,
  owner: string | undefined,
  text: string
): Promise<NotesDelivery> {
  const session = sessions.get(id);
  const eligible = () => !!session && sessions.get(id) === session && notesDestination(session, owner);
  if (!eligible()) return { delivery: 'failed', message: 'Destination is no longer active or owned by you.' };
  try {
    if (session!.remote && wake && (await wake.checkReachable(session!)) === false)
      return { delivery: 'failed', message: 'Destination host is unavailable. Nothing was sent.' };
    if (session!.usesMux !== false && session!.muxName && (await mux.isPaneDead(session!.muxName)))
      return { delivery: 'failed', message: 'Destination worker has exited. Nothing was sent.' };
  } catch {
    return { delivery: 'failed', message: 'Could not verify destination. Nothing was sent.' };
  }
  // Probes yield: ownership and the exact live object must still agree at the write boundary.
  if (!eligible()) return { delivery: 'failed', message: 'Destination changed. Nothing was sent.' };
  session!.cancelCheckpoint('manual-takeover');
  try {
    const submitted = await session!.writeNotesInput(text, eligible);
    return submitted
      ? { delivery: 'submitted' }
      : {
          delivery: 'unknown',
          message: 'Delivery was not acknowledged. Inspect the destination before sending again.',
        };
  } catch {
    return {
      delivery: 'unknown',
      message: 'Delivery was not acknowledged. Inspect the destination before sending again.',
    };
  }
}
