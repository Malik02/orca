import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  clearWorktreeSleepIntent,
  hasWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'
import { stopWorkspaceChats, type WorkspaceChatStopReceipt } from './sleep-workspace-chat-stop'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'

/** One per host asked to stop the workspace's chats. */
export type WorkspaceSleepResult = {
  workspaceId: string
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
  /** The whole workspace slept and is still asleep. */
  completed: boolean
}

/**
 * Shared "sleep worktree" flow (close all panels to free memory / CPU)
 * used by WorktreeContextMenu and MemoryStatusSegment's per-row hover action.
 *
 * Why this is a module helper rather than inlined at each call site: the guard
 * that clears `activeWorktreeId` before tearing down terminals isn't optional
 * polish — shutting down the active worktree while its TerminalPane is still
 * visible causes a visible "reboot" flicker and can crash the pane (PTY exit
 * callbacks race against the live xterm instance). See the original comment
 * in WorktreeContextMenu's handleCloseTerminals for the full reasoning.
 * Centralizing the sequence here keeps that safety invariant in one place so
 * a new caller can't accidentally skip it.
 */
export async function runSleepWorktree(worktreeId: string): Promise<WorkspaceSleepResult[]> {
  return runSleepWorktrees([worktreeId])
}

function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  // Why first: the twin refusal names no connection problem, though it contains "terminal_".
  if (detail.includes('ambiguous_terminal_owner')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.twin.unattributed',
      "Orca couldn't tell which host runs this workspace's terminals, so the workspace was kept open. Reconnect its hosts and try again."
    )
  }
  if (detail.includes('legacy')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.legacy.unverified',
      'The older host runtime could not confirm terminal shutdown. The workspace was kept open; update the host and try again.'
    )
  }
  if (
    detail.includes('terminal_') ||
    detail.includes('runtime') ||
    detail.includes('connection') ||
    detail.includes('Daemon')
  ) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.host.unverified',
      'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
    )
  }
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.retry',
    'The workspace was kept open. Try again; if the problem continues, check the host connection.'
  )
}

function describeChatStopFailure(): string {
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.chat.partial',
    'The host could not confirm the chat stopped. Other panels may have closed; check the connection and try again.'
  )
}

export async function runSleepWorktrees(
  worktreeIds: readonly string[]
): Promise<WorkspaceSleepResult[]> {
  const { errors, results } = await sleepWorktreesReportingFailures(worktreeIds, {
    recordExplicitChatSleep: true
  })
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface actionable teardown failures after restoring retryable UI state.
    toast.error(
      new Set(worktreeIds).size === 1
        ? translate(
            'auto.components.sidebar.sleep.worktree.flow.8bc3fc0671',
            'Failed to sleep workspace'
          )
        : translate(
            'auto.components.sidebar.sleep.worktree.flow.c460fecc4a',
            'Failed to sleep some workspaces'
          ),
      {
        description: errors.join('\n')
      }
    )
  }
  return results
}

/** Records the chats each host confirmed stopped; a failed chat stop leaves the workspace awake. */
function recordExplicitChatSleep(
  worktreeId: string,
  receipts: readonly WorkspaceChatStopReceipt[] | null,
  capturedChats: readonly Tab[]
): void {
  const store = useAppStore.getState()
  if (!receipts) {
    store.clearWorkspaceChatsSlept(worktreeId)
    return
  }
  // Why by session id: a copy reached through a paired runtime stamps its tabs with its own host.
  const stopped = new Set(receipts.flatMap((receipt) => receipt.stoppedSessionIds))
  const chatsByHost = new Map<ExecutionHostId, { tabId: string; sessionId: string }[]>()
  for (const tab of capturedChats) {
    if (tab.executionHostId && stopped.has(tab.entityId)) {
      const chats = chatsByHost.get(tab.executionHostId) ?? []
      chatsByHost.set(tab.executionHostId, [...chats, { tabId: tab.id, sessionId: tab.entityId }])
    }
  }
  for (const [hostId, chats] of chatsByHost) {
    store.markWorkspaceChatsSlept(worktreeId, hostId, chats)
  }
}

export type WorktreeSleepOutcome = {
  /** Every workspace not verifiably slept, including one whose chat stop went unconfirmed. */
  failedWorktreeIds: string[]
  errors: string[]
  results: WorkspaceSleepResult[]
}

/** The sleep without the toast, for callers that report failures themselves. */
export async function sleepWorktreesReportingFailures(
  requestedWorktreeIds: readonly string[],
  // Why: only the user's Sleep hides its chats; a project move pauses through this core too.
  options: { recordExplicitChatSleep?: boolean } = {}
): Promise<WorktreeSleepOutcome> {
  // Why unique: both copies of a twin share one id, and sleeping it sleeps the whole workspace.
  const worktreeIds = [...new Set(requestedWorktreeIds)]
  if (worktreeIds.length === 0) {
    return { failedWorktreeIds: [], errors: [], results: [] }
  }
  const {
    activeWorktreeId,
    setActiveWorktree,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals
  } = useAppStore.getState()
  const sleptActiveWorktreeId =
    activeWorktreeId && worktreeIds.includes(activeWorktreeId) ? activeWorktreeId : null
  if (sleptActiveWorktreeId) {
    const restoreSidebarPosition = preserveSidebarWorktreePosition(sleptActiveWorktreeId)
    // Why: clearing the active workspace can unmount TerminalPanes before
    // shutdownWorktreeTerminals writes PTY suppressions; mark first so those
    // exits do not stamp activity. Kept off the store so it cannot disturb the
    // sidebar's scroll restoration.
    markWorktreeSleepIntent(sleptActiveWorktreeId)
    setActiveWorktree(null)
    restoreSidebarPosition()
  }
  const errors: string[] = []
  const failedWorktreeIds = new Set<string>()
  // Why apart from failedWorktreeIds: stopped terminals stay stopped when only a chat stop fails.
  const chatFailedIds = new Set<string>()
  const results: WorkspaceSleepResult[] = []
  try {
    for (const worktreeId of worktreeIds) {
      // Why: the marker outlives teardown so the panes left mounted stay cold
      // until an explicit wake (#10205); mark per workspace so an earlier
      // slow teardown never leaves a later, still-awake one marked.
      markWorktreeSleepIntent(worktreeId)
      const capturedChats = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).filter(
        isStructuredTab
      )
      try {
        // Why: sleep mirrors removeWorktree's shutdown sequence — browsers first
        // so destroyPersistentWebview unregisters the Chromium guests before any
        // other teardown runs, terminals second so the PTY kill uses the same
        // ordering on both paths. Without the browser thunk here, sleep leaks
        // browserPagesByWorkspace entries and live webviews for the slept worktree.
        await withWorktreeSleepTeardown(worktreeId, () => shutdownWorktreeBrowsers(worktreeId))
      } catch (err) {
        console.error('[sleep-worktree] browser shutdown failed', { worktreeId, error: err })
        failedWorktreeIds.add(worktreeId)
        errors.push(describeSleepFailure(err))
        continue
      }
      try {
        // Why: sleep is reversible — the tab record stays in tabsByWorktree, the
        // layout stays in terminalLayoutsByTabId, only the live PTY processes are
        // released. keepIdentifiers preserves tab.ptyId / ptyIdsByLeafId /
        // lastKnownRelayPtyIdByTabId so wake re-spawns against the same on-disk
        // history dir (local) or relay session id (SSH); it also captures
        // serializer buffers into buffersByLeafId for SSH wake to reseed
        // scrollback. See DESIGN_DOC_TERMINAL_HISTORY_FIX_V2.md §3.3.c.
        await withWorktreeSleepTeardown(worktreeId, async () => {
          await shutdownWorktreeTerminals(worktreeId, { keepIdentifiers: true })
          if (typeof window !== 'undefined' && window.api?.ephemeralVm?.suspendWorkspace) {
            await window.api.ephemeralVm.suspendWorkspace({ workspaceId: worktreeId })
          }
        })
        // Why: a workspace the user activated during the batch is awake by their choice.
        if (useAppStore.getState().activeWorktreeId === worktreeId) {
          clearWorktreeSleepIntent(worktreeId)
        }
      } catch (err) {
        console.error('[sleep-worktree] terminal or host suspension failed', {
          worktreeId,
          error: err
        })
        failedWorktreeIds.add(worktreeId)
        errors.push(describeSleepFailure(err))
        continue
      }
      // Why after terminals: a teardown refused for an unattributable twin then stops no chat.
      const { receipts, failed } = await stopWorkspaceChats(useAppStore.getState(), worktreeId)
      if (failed) {
        chatFailedIds.add(worktreeId)
        errors.push(describeChatStopFailure())
      }
      // Why re-read the marker: a wake during the chat wait keeps the workspace awake.
      const completed =
        !failed && !failedWorktreeIds.has(worktreeId) && hasWorktreeSleepIntent(worktreeId)
      results.push(
        ...receipts.map((receipt) => ({ workspaceId: worktreeId, ...receipt, completed }))
      )
      if (options.recordExplicitChatSleep && (completed || failed)) {
        recordExplicitChatSleep(worktreeId, completed ? receipts : null, capturedChats)
      }
    }
  } finally {
    // Why: a failed sleep leaves the workspace awake and retryable.
    for (const worktreeId of failedWorktreeIds) {
      clearWorktreeSleepIntent(worktreeId)
    }
    if (sleptActiveWorktreeId && failedWorktreeIds.has(sleptActiveWorktreeId)) {
      setActiveWorktree(sleptActiveWorktreeId)
    }
  }
  return {
    failedWorktreeIds: [...new Set([...failedWorktreeIds, ...chatFailedIds])],
    errors: [...new Set(errors)],
    results
  }
}
