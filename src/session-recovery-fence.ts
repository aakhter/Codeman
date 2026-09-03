/** Process-local dismissal fences. A fresh boot snapshot explicitly clears its own fence. */
const dismissedRecoveryIds = new Set<string>();
export const dismissRecovery = (id: string) => dismissedRecoveryIds.add(id);
export const isRecoveryDismissed = (id: string) => dismissedRecoveryIds.has(id);
export const clearRecoveryDismissal = (id: string) => dismissedRecoveryIds.delete(id);
