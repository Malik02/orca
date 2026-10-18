import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientProfileMetadata } from '../../shared/browser-client-profile-switch-protocol'
import { sameBrowserClientPageAuthority } from './browser-client-host-command-authority'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer
} from './browser-client-page-command-admission'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import type { BrowserClientPageCommandExecutorDependencies } from './browser-client-page-command-executor-dependencies'
import { createReservedBrowserClientPage } from './browser-client-page-creation'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'
import { updateBrowserClientPageInventoryCurrentUrl } from './browser-client-page-inventory'

export async function switchBrowserClientPageProfile(input: {
  event: BrowserClientHostCommandEvent
  signal: AbortSignal
  retainedCleanups: Map<Promise<void>, BrowserClientRetainedPage>
  pages: Map<string, BrowserClientRetainedPage>
  dependencies: BrowserClientPageCommandExecutorDependencies
  assertAvailable(): void
  commit(page: BrowserClientRetainedPage): void
  cleanup(page: BrowserClientRetainedPage): Promise<void>
  retirePrevious(page: BrowserClientRetainedPage): Promise<void>
}): Promise<void> {
  const { event, signal, dependencies } = input
  if (event.command.type !== 'switchProfile') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const old = input.pages.get(event.browserPageId)
  if (
    !old ||
    old.retiring ||
    old.reconciling ||
    !sameBrowserClientPageAuthority(old.inventory, event) ||
    event.command.nextPageHostGeneration <= old.generation
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
  }
  const profile = BrowserClientProfileMetadata.parse(event.command.profile)
  const bindReplacement = dependencies.guestBinding.bindReplacement
  if (!bindReplacement) {
    throw new BrowserClientPageCommandError('browser_client_page_profile_switch_unsupported')
  }
  if (profile.id === old.inventory.browserProfileId) {
    throw new BrowserClientPageCommandError('browser_client_page_profile_switch_redundant')
  }
  const create: BrowserClientHostCommandEvent = {
    ...event,
    pageHostGeneration: event.command.nextPageHostGeneration,
    command: {
      type: 'createPage',
      browserProfileId: profile.id,
      executionHostKey: old.inventory.executionHostKey,
      ...(old.inventory.workspaceId ? { workspaceId: old.inventory.workspaceId } : {})
    }
  }
  let staged: BrowserClientRetainedPage | undefined
  let bindingAttempted = false
  old.reconciling = true
  try {
    await createReservedBrowserClientPage(
      {
        ...dependencies,
        // A profile switch cannot change the execution route or supersede the old guest.
        retireSupersededExecutionHostPages: async () => {},
        guestBinding: { bind: () => {}, release: () => {} }
      },
      create,
      signal,
      input.assertAvailable,
      (page) => {
        staged = page
      },
      profile
    )
    if (!staged || staged.registration.partition === old.registration.partition) {
      throw new BrowserClientPageCommandError('browser_client_page_profile_partition_conflict')
    }
    assertBrowserClientPageCommandNotAborted(signal)
    input.assertAvailable()
    assertCurrentBrowserClientPageRenderer(old.renderer)
    await dependencies.retireAutomation({
      keepGuestBinding: true,
      browserPageId: event.browserPageId,
      pageHostGeneration: old.generation,
      registration: old.registration
    })
    bindingAttempted = true
    bindReplacement({ registration: staged.registration, browserProfileId: profile.id })
    const url = old.inventory.currentUrl
    if (url && url !== 'about:blank') {
      if (!(await dependencies.routeWebContents.navigateGuest(staged.lifecycleClaim, url))) {
        throw new BrowserClientPageCommandError('browser_client_page_navigation_failed')
      }
      staged.inventory = updateBrowserClientPageInventoryCurrentUrl(staged.inventory, url)
    }
    assertBrowserClientPageCommandNotAborted(signal)
    input.assertAvailable()
    assertCurrentBrowserClientPageRenderer(staged.renderer)
    if (input.pages.get(event.browserPageId) !== old || !old.lifecycleClaim.isCurrent()) {
      throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
    }
    input.commit(staged)
  } catch (error) {
    try {
      if (staged) {
        const cleanup = input.cleanup(staged)
        input.retainedCleanups.set(cleanup, staged)
        await cleanup
        input.retainedCleanups.delete(cleanup)
      }
    } finally {
      old.reconciling = false
      if (bindingAttempted && old.lifecycleClaim.isCurrent()) {
        dependencies.guestBinding.bind({
          registration: old.registration,
          browserProfileId: old.inventory.browserProfileId
        })
      }
    }
    throw error
  }
  old.reconciling = false
  await input.retirePrevious(old)
}

export async function retireSwitchedBrowserClientPage(
  page: BrowserClientRetainedPage,
  cleanupPage: (page: BrowserClientRetainedPage) => Promise<void>,
  retained: Map<Promise<void>, BrowserClientRetainedPage>
): Promise<void> {
  const cleanup = cleanupPage(page)
  retained.set(cleanup, page)
  try {
    await cleanup
    retained.delete(cleanup)
  } catch (error) {
    console.warn('[browser-client-page] Replaced guest cleanup remains unresolved', error)
  }
}
