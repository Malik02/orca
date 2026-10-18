// OSC 7501 says a program's done/error outlives its exit until the user has seen it, so the
// command-finished drop that clears a real agent's frozen Done keeps these rows instead. Shared by
// the mounted pane and the parked SSH watcher so a row parked on exit is still dismissed on return.
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isRetainedProgramResult } from '@/lib/program-status/row'

// paneKey → the retained row's stateStartedAt, so a dismissal never drops a later report; 'late'
// means the command finished first, so whichever program result lands after it is the one to clear.
// Entries end on the next keypress or command start (dismiss) or when the pane closes (forget).
const retainedStartedAtByPaneKey = new Map<string, number | 'late'>()

/** Arm dismissal for a program result that reports after the command-finished mark. */
export function armLateProgramResult(paneKey: string): void {
  retainedStartedAtByPaneKey.set(paneKey, 'late')
}

/** Keep a finished program's result instead of the command-finished drop; true when kept. */
export function retainIfProgramResult(paneKey: string, entry: AgentStatusEntry): boolean {
  if (!isRetainedProgramResult(entry)) {
    return false
  }
  retainedStartedAtByPaneKey.set(paneKey, entry.stateStartedAt)
  return true
}

// Why the state parameter: the store's tab sweep imports this module, so it must not import the store.
export function dismissRetainedProgramResult(
  paneKey: string,
  state: {
    agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry | undefined>>
    dropAgentStatus: (paneKey: string) => void
  }
): void {
  const startedAt = retainedStartedAtByPaneKey.get(paneKey)
  if (startedAt === undefined) {
    return
  }
  retainedStartedAtByPaneKey.delete(paneKey)
  const current = state.agentStatusByPaneKey[paneKey]
  if (
    current &&
    (startedAt === 'late' || current.stateStartedAt === startedAt) &&
    isRetainedProgramResult(current)
  ) {
    state.dropAgentStatus(paneKey)
  }
}

export function forgetProgramResult(paneKey: string): void {
  retainedStartedAtByPaneKey.delete(paneKey)
}

/** A retired tab's pane keys never recur, so its entries would otherwise stay forever. */
export function forgetProgramResultsForTab(tabId: string): void {
  const prefix = `${tabId}:`
  for (const paneKey of retainedStartedAtByPaneKey.keys()) {
    if (paneKey.startsWith(prefix)) {
      retainedStartedAtByPaneKey.delete(paneKey)
    }
  }
}
