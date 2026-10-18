import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { isStructuredTab } from '../../../../../../shared/structured-agent-session-tab'
import {
  sleptChatWorkspaceKey,
  withoutSleptChatsForWorkspaces,
  type SleptChatIdentity
} from '../../../../../../shared/workspace-chat-sleep'

export function createWorkspaceChatSleepActions(
  set: WorktreeSliceSet
): Pick<WorktreeSlice, 'markWorkspaceChatsSlept' | 'clearWorkspaceChatsSlept'> {
  return {
    markWorkspaceChatsSlept: (worktreeId, hostId, chats) =>
      set((state) => {
        const key = sleptChatWorkspaceKey(worktreeId, hostId)
        const current = state.explicitlySleptChatsByWorkspace[key] ?? []
        const accepted: SleptChatIdentity[] = []
        for (const chat of chats) {
          const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
            (candidate) => candidate.id === chat.tabId
          )
          if (
            !tab ||
            !isStructuredTab(tab) ||
            tab.entityId !== chat.sessionId ||
            tab.executionHostId !== hostId
          ) {
            continue
          }
          if (
            !current.some(
              (entry) => entry.tabId === chat.tabId && entry.sessionId === chat.sessionId
            )
          ) {
            accepted.push({ tabId: chat.tabId, sessionId: chat.sessionId })
          }
        }
        if (accepted.length === 0) {
          return state
        }
        return {
          explicitlySleptChatsByWorkspace: {
            ...state.explicitlySleptChatsByWorkspace,
            [key]: [...current, ...accepted]
          }
        }
      }),
    clearWorkspaceChatsSlept: (worktreeId, scope) =>
      set((state) => {
        if (!scope) {
          const next = withoutSleptChatsForWorkspaces(state.explicitlySleptChatsByWorkspace, [
            { id: worktreeId }
          ])
          return next === state.explicitlySleptChatsByWorkspace
            ? state
            : { explicitlySleptChatsByWorkspace: next }
        }
        const { hostId, chats } = scope
        const key = sleptChatWorkspaceKey(worktreeId, hostId)
        const current = state.explicitlySleptChatsByWorkspace[key]
        if (!current) {
          return state
        }
        const retained = current.filter(
          (entry) =>
            !chats.some((chat) => chat.tabId === entry.tabId && chat.sessionId === entry.sessionId)
        )
        if (retained.length === current.length) {
          return state
        }
        const next = { ...state.explicitlySleptChatsByWorkspace }
        if (retained.length > 0) {
          next[key] = retained
        } else {
          delete next[key]
        }
        return { explicitlySleptChatsByWorkspace: next }
      })
  }
}
