import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  isExternalReloadableEditorTab,
  notifyEditorExternalFileChange,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import { probeEditorTabFileMissing } from '@/components/editor/editor-restored-tab-conflict-scan'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

function isTargetTab(file: OpenFile, target: EditorExternalWatchTarget): boolean {
  return (
    file.worktreeId === target.worktreeId &&
    getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId
  )
}

function isCombinedWorkingTreeDiffTab(file: OpenFile): boolean {
  return (
    file.mode === 'diff' &&
    (file.diffSource === 'combined-all' || file.diffSource === 'combined-uncommitted')
  )
}

function toNotification(
  target: EditorExternalWatchTarget,
  relativePath: string
): EditorPathMutationTarget {
  return {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    relativePath,
    runtimeEnvironmentId: target.runtimeEnvironmentId,
    ...getLocalWindowsWslAliasOption(target)
  }
}

// Why: this is a catch-up, not change evidence; a dirty or tombstoned match would be wrongly marked changed or force-reloaded into a load error.
function notifyIfAllMatchesClean(notification: EditorPathMutationTarget): void {
  const matches = getOpenFilesForExternalFileChange(useAppStore.getState().openFiles, notification)
  if (matches.every((file) => !file.isDirty && !file.externalMutation)) {
    notifyEditorExternalFileChange(notification)
  }
}

// Why: writes made while unwatched were never seen. Clean tabs are armed too: the conflict scan ignores them until an edit makes them dirty, so typing before the reload lands holds autosave for a disk check; a clean reload clears the flag.
export function armEditorTabDiskVerification(target: EditorExternalWatchTarget): void {
  const state = useAppStore.getState()
  for (const file of state.openFiles) {
    // Why: mirror the scan's eligibility, or a tab it skips would keep autosave suspended forever.
    if (
      isTargetTab(file, target) &&
      file.lastKnownDiskSignature &&
      file.externalMutation !== 'changed' &&
      canAutoSaveOpenFile(file)
    ) {
      state.setPendingDiskBaselineVerification(file.id, true)
    }
  }
}

export async function reloadCleanEditorTabs(target: EditorExternalWatchTarget): Promise<void> {
  const files = useAppStore
    .getState()
    .openFiles.filter(
      (file) =>
        isTargetTab(file, target) &&
        !file.isDirty &&
        !file.externalMutation &&
        isExternalReloadableEditorTab(file)
    )
  await Promise.all(
    files.map(async (file) => {
      if (file.mode === 'edit' && (await probeEditorTabFileMissing(useAppStore.getState(), file))) {
        const live = useAppStore.getState()
        const liveFile = live.openFiles.find((f) => f.id === file.id)
        // Why: deleted/renamed while unwatched; mark it like a live delete event would.
        if (liveFile && !liveFile.isDirty && !liveFile.externalMutation) {
          live.setExternalMutation(file.id, 'deleted')
          live.clearPendingDiskBaselineVerification(file.id)
        }
        return
      }
      notifyIfAllMatchesClean(toNotification(target, file.relativePath))
    })
  )
  const state = useAppStore.getState()
  // Why: combined diffs revalidate per changed path, so replay every path git status lists for the workspace.
  if (
    state.openFiles.some((file) => isTargetTab(file, target) && isCombinedWorkingTreeDiffTab(file))
  ) {
    for (const entry of state.gitStatusByWorktree[target.worktreeId] ?? []) {
      notifyIfAllMatchesClean(toNotification(target, entry.path))
    }
  }
}
