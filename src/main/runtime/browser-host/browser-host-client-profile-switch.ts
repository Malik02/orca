import {
  BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY,
  BrowserClientProfileMetadata
} from '../../../shared/browser-client-profile-switch-protocol'
import type { BrowserClientHostCommandResult } from '../../../shared/browser-client-host-protocol'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { RuntimeBrowserClientPlacement } from '../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type {
  BrowserClientPageAuthority,
  BrowserHostPagePlacementRegistry
} from './browser-host-page-placement'
import {
  clientPageCreationTimeout,
  waitForClientPageCreationResult,
  closeUncommittedClientPage,
  type BrowserClientPageExecutionHostGrant
} from './browser-host-client-page-creation'

const pendingByPlacements = new WeakMap<
  BrowserHostPagePlacementRegistry,
  Map<string, RuntimeBrowserClientPlacement>
>()

/** Replacement placements of switches still waiting on the client, by page. */
export function pendingBrowserHostProfileSwitches(
  placements: BrowserHostPagePlacementRegistry
): Map<string, RuntimeBrowserClientPlacement> {
  let pending = pendingByPlacements.get(placements)
  if (!pending) {
    pending = new Map()
    pendingByPlacements.set(placements, pending)
  }
  return pending
}

export async function switchBrowserHostClientProfile(
  authority: BrowserClientPageAuthority,
  metadata: BrowserClientProfileMetadata,
  input: {
    timeoutMs?: number
    registry: Pick<BrowserHostLeaseRegistry, 'requireClientPage' | 'select'>
    state: (clientId: string) => BrowserHostLeaseState
    placements: BrowserHostPagePlacementRegistry
    grants: Map<string, BrowserClientPageExecutionHostGrant>
    /** The client retired the old guest, so its transfers can never finish under the new generation. */
    onCommitted?: (browserPageId: string) => void
  }
) {
  const timeoutMs = clientPageCreationTimeout(input.timeoutMs)
  const profile = BrowserClientProfileMetadata.parse(metadata)
  const expected = input.registry.requireClientPage(authority)
  const lease = input.registry.select(expected.browserHostClientId, [])
  if (
    !lease.hostCapabilities.includes(BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY) ||
    lease.browserHostGeneration !== expected.browserHostGeneration ||
    lease.pageReconciliationProtocolVersion !== 1
  ) {
    throw new Error('browser_host_profile_switch_unsupported')
  }
  const state = input.state(expected.browserHostClientId)
  const ledger = state.commandLedger
  const grant = input.grants.get(authority.browserPageId)
  if (!ledger || !grant || grant.placement !== expected) {
    throw new Error('browser_page_placement_stale')
  }
  const reservation = input.placements.reserveNewClientPage(authority.browserPageId, expected)
  let completed = false
  let resultPending: Promise<BrowserClientHostCommandResult> | undefined
  const retirePlacement = () => {
    if (input.placements.getPlacement(authority.browserPageId) === expected) {
      input.placements.completePageRetirement(
        input.placements.beginPageRetirement(authority.browserPageId, expected)
      )
    }
  }
  // Why: a held grant blocks recreating the page once its placement is retired.
  const releaseGrant = () => {
    if (input.grants.get(authority.browserPageId) === grant) {
      input.grants.delete(authority.browserPageId)
      grant.release()
    }
  }
  const closeSettledReplacement = () => {
    try {
      ledger.advancePageGeneration(
        authority.browserPageId,
        expected.pageHostGeneration,
        reservation.placement.pageHostGeneration
      )
      closeUncommittedClientPage(state, authority.browserPageId, reservation.placement)
    } catch {
      // A fenced lease or a newer reconciliation owns cleanup now.
    }
  }
  const pending = pendingBrowserHostProfileSwitches(input.placements)
  pending.set(authority.browserPageId, reservation.placement)
  try {
    const issued = ledger.issue({
      browserPageId: authority.browserPageId,
      pageHostGeneration: expected.pageHostGeneration,
      resultAdmission: 'reserved-page',
      command: {
        type: 'switchProfile',
        profile,
        nextPageHostGeneration: reservation.placement.pageHostGeneration
      }
    })
    resultPending = issued.result
    const result = await waitForClientPageCreationResult(issued.result, timeoutMs)
    resultPending = undefined
    completed = result.status === 'completed'
    if (result.status === 'failed') {
      throw new Error(result.errorCode)
    }
    input.registry.requireClientPage(authority)
    const placement = input.placements.commitClientPageReplacement(reservation, expected)
    ledger.advancePageGeneration(
      authority.browserPageId,
      expected.pageHostGeneration,
      placement.pageHostGeneration
    )
    input.grants.set(authority.browserPageId, { ...grant, placement })
    input.onCommitted?.(authority.browserPageId)
    return placement
  } catch (error) {
    input.placements.cancelClientPageReservation(reservation)
    // The client retired the old guest once its switch completed, so that placement is gone.
    const retireSwitchedPage = () => {
      retirePlacement()
      closeSettledReplacement()
      releaseGrant()
    }
    if (completed) {
      retireSwitchedPage()
    } else if (resultPending) {
      // Why: until the client settles, the old guest may still be live; a late failure keeps it.
      void resultPending.then(
        (result) => {
          if (result.status === 'completed') {
            retireSwitchedPage()
          }
        },
        () => {
          retirePlacement()
          releaseGrant()
        }
      )
    }
    throw error
  } finally {
    if (pending.get(authority.browserPageId) === reservation.placement) {
      pending.delete(authority.browserPageId)
    }
  }
}
