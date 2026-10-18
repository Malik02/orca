import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getDiskBaselineSignature } from './diff-content-signature'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import {
  probeEditorTabFileMissing,
  readEditorTabDiskContent
} from './editor-restored-tab-conflict-scan'

export const CHANGED_ON_DISK_SAVE_REFUSAL =
  'This file changed on disk. Review the change, then save again to overwrite it.'

/**
 * An explicit save of a tab whose disk baseline is still unverified checks disk first.
 * Returns false (and shows the changed-on-disk banner) when disk moved past the baseline;
 * a second save then overwrites on purpose because the banner is showing.
 */
export async function verifyDiskBaselineBeforeUserSave(
  store: Pick<StoreApi<AppState>, 'getState'>,
  file: OpenFile
): Promise<boolean> {
  if (
    file.pendingDiskBaselineVerification !== true ||
    !file.lastKnownDiskSignature ||
    file.externalMutation === 'changed'
  ) {
    return true
  }
  let diskSignature: string | null
  try {
    const result = await readEditorTabDiskContent(store.getState(), file)
    diskSignature = result.isBinary ? null : getDiskBaselineSignature(result.content)
  } catch (error) {
    if (!(await probeEditorTabFileMissing(store.getState(), file))) {
      throw error
    }
    // Why: a gone file has no newer content to clobber; the save recreates it.
    diskSignature = null
  }
  const state = store.getState()
  const liveFile = state.openFiles.find((f) => f.id === file.id)
  state.clearPendingDiskBaselineVerification(file.id)
  if (!liveFile || diskSignature === null || diskSignature === file.lastKnownDiskSignature) {
    return true
  }
  markFileChangedOnDisk(state, liveFile, {
    connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
    origin: 'live'
  })
  return false
}
