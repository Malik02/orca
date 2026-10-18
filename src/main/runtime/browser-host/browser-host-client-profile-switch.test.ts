import { DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS } from '../../../shared/browser-client-page-creation-timeouts'
import type { BrowserClientHostCommandEvent } from '../../../shared/browser-client-host-protocol'
import { describe, expect, it, vi } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import { BrowserClientHostCommandDispatcher } from '../../browser/browser-client-host-command-dispatcher'
import { createHarness } from '../../browser/browser-client-page-command-executor-test-harness'
import {
  BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY,
  BrowserClientProfileMetadata
} from '../../../shared/browser-client-profile-switch-protocol'
import { deriveBrowserRoutePartition } from '../../browser/browser-route-identity'

async function fixture(supported = true) {
  const leases = new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a'
  })
  const lease = leases.attach({
    browserHostClientId: 'client-a',
    pairedDeviceId: 'device-a',
    connectionId: 'connection-a',
    hostCapabilities: ['webview', ...(supported ? [BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY] : [])],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageReconciliationProtocolVersion: 1,
    pageInventory: []
  }).lease
  const h = createHarness()
  const bindReplacement = vi.fn()
  Object.assign(h.dependencies.guestBinding, { bindReplacement })
  h.dependencies.routeSessions.preparePage.mockImplementation(async (input) => ({
    partition: deriveBrowserRoutePartition(input.identity).partition,
    release: vi.fn()
  }))
  let guestId = 40
  h.renderer.mountPage.mockImplementation(async () => ({ webContentsId: ++guestId }))
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority: { ...lease, pageCommandProtocolVersion: 1 },
    handler: (event, signal) => h.executor.handle(event, signal)
  })
  const afterSettlement = vi.fn<(event: BrowserClientHostCommandEvent) => void>()
  const delivered = vi.fn((event) => {
    void dispatcher.dispatch(event).then((result) => {
      leases.settleClientPageCommand(
        { ...lease, connectionId: lease.connectionId },
        { ...event, result }
      )
      afterSettlement(event)
    })
  })
  leases.attachCommandDelivery(lease, delivered)
  const placement = await leases.createClientPage({
    browserPageId: 'page-a',
    browserHostClientId: lease.browserHostClientId,
    pairedDeviceId: lease.pairedDeviceId,
    browserProfileId: 'default',
    executionHostKey: 'execution-host-a',
    workspaceId: 'workspace-a'
  })
  const authority = {
    ...lease,
    browserPageId: 'page-a',
    pageHostGeneration: placement.pageHostGeneration
  }
  return {
    leases,
    h,
    dispatcher,
    delivered,
    placement,
    authority,
    bindReplacement,
    afterSettlement
  }
}

const isolated = { id: 'remote-profile', label: 'Remote-only profile', scope: 'isolated' as const }

describe('negotiated profile switch over the command transport', () => {
  it('closes a late replacement in sequence through the real ledger and dispatcher', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    try {
      let finishMount!: (value: { webContentsId: number }) => void
      f.h.renderer.mountPage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMount = resolve
          })
      )
      const rejected = expect(
        f.leases.switchClientPageProfile(f.authority, isolated)
      ).rejects.toThrow('browser_host_page_creation_timeout')
      await vi.advanceTimersByTimeAsync(DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS + 1)
      await rejected
      expect(
        f.delivered.mock.calls.filter(([event]) => event.command.type === 'closePage')
      ).toHaveLength(0)
      finishMount({ webContentsId: 99 })
      await vi.advanceTimersByTimeAsync(0)
      const events = f.delivered.mock.calls.map(([event]) => event)
      const switchEvent = events.find((event) => event.command.type === 'switchProfile')!
      const closeEvent = events.find((event) => event.command.type === 'closePage')!
      expect(closeEvent).toBeDefined()
      expect(closeEvent.commandSequence).toBe(switchEvent.commandSequence + 1)
      expect(f.h.executor.snapshotPageInventory()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('switches both directions, preserves partition identity, and routes later commands to the new generation', async () => {
    const f = await fixture()
    f.afterSettlement.mockImplementation((event) => {
      if (event.command.type === 'switchProfile') {
        expect(() =>
          f.leases.issueClientPageCommand(
            { ...f.authority, pageHostGeneration: event.pageHostGeneration },
            { type: 'navigate', url: 'https://example.com/' }
          )
        ).toThrow('profile_switch_pending')
      }
    })
    const beforePartition = f.h.executor.snapshotPageInventory()[0]!
    const next = await f.leases.switchClientPageProfile(f.authority, isolated)
    expect(next.pageHostGeneration).toBeGreaterThan(f.placement.pageHostGeneration)
    expect(f.h.executor.hasPage('page-a', next.pageHostGeneration)).toBe(true)
    const switched = f.delivered.mock.calls.at(-1)![0]
    const boundCount = f.bindReplacement.mock.calls.length
    await expect(f.dispatcher.dispatch(switched)).resolves.toEqual({ status: 'completed' })
    expect(f.bindReplacement).toHaveBeenCalledTimes(boundCount)
    expect(
      f.leases.settleClientPageCommand(
        { ...f.authority, connectionId: 'connection-a' },
        { ...switched, result: { status: 'completed' } }
      )
    ).toBe(false)
    expect(() =>
      f.leases.issueClientPageCommand(f.authority, {
        type: 'navigate',
        url: 'https://example.com/'
      })
    ).toThrow('placement_stale')

    const navigate = f.leases.issueClientPageCommand(
      { ...f.authority, pageHostGeneration: next.pageHostGeneration },
      { type: 'navigate', url: 'https://example.com/' }
    )
    await expect(navigate.result).resolves.toEqual({ status: 'completed' })
    const back = await f.leases.switchClientPageProfile(
      { ...f.authority, pageHostGeneration: next.pageHostGeneration },
      { id: 'default', label: 'Default', scope: 'default' }
    )
    expect(f.h.executor.hasPage('page-a', back.pageHostGeneration)).toBe(true)
    expect(f.h.dependencies.routeSessions.preparePage.mock.calls[0]![0].identity).toEqual(
      f.h.dependencies.routeSessions.preparePage.mock.calls[2]![0].identity
    )
    expect(beforePartition.browserProfileId).toBe('default')
    expect(f.leases.getClientPageExecutionHostKey('page-a')).toBe('execution-host-a')
    await f.dispatcher.close()
    await f.h.executor.close()
  })

  it('rejects an old desktop before issuing a command or changing placement', async () => {
    const f = await fixture(false)
    const calls = f.delivered.mock.calls.length
    await expect(f.leases.switchClientPageProfile(f.authority, isolated)).rejects.toThrow(
      'profile_switch_unsupported'
    )
    expect(f.delivered).toHaveBeenCalledTimes(calls)
    expect(f.leases.getPlacement('page-a')).toBe(f.placement)
    expect(f.h.executor.hasPage('page-a', f.placement.pageHostGeneration)).toBe(true)
    await f.dispatcher.close()
    await f.h.executor.close()
  })

  it('rolls back failure and permits a later retry on the original generation', async () => {
    const f = await fixture()
    f.bindReplacement.mockImplementationOnce(() => {
      throw new Error('binding refused')
    })
    await expect(f.leases.switchClientPageProfile(f.authority, isolated)).rejects.toThrow()
    expect(f.leases.getPlacement('page-a')).toBe(f.placement)
    expect(f.h.executor.hasPage('page-a', f.placement.pageHostGeneration)).toBe(true)
    const next = await f.leases.switchClientPageProfile(f.authority, isolated)
    expect(f.h.executor.hasPage('page-a', next.pageHostGeneration)).toBe(true)
    await f.dispatcher.close()
    await f.h.executor.close()
  })

  it('serializes a staged replacement and rejects commands addressed to the old generation while it is pending', async () => {
    const f = await fixture()
    let release = () => {}
    let started = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const prepare = f.h.dependencies.routeSessions.preparePage.getMockImplementation()!
    f.h.dependencies.routeSessions.preparePage.mockImplementationOnce(async (input) => {
      started()
      await gate
      return prepare(input)
    })
    const switching = f.leases.switchClientPageProfile(f.authority, isolated)
    await entered
    expect(f.leases.getPlacement('page-a')).toBe(f.placement)
    expect(f.h.executor.hasPage('page-a', f.placement.pageHostGeneration)).toBe(true)
    expect(f.bindReplacement).not.toHaveBeenCalled()
    expect(() =>
      f.leases.issueClientPageCommand(f.authority, {
        type: 'navigate',
        url: 'https://example.com/'
      })
    ).toThrow('profile_switch_pending')
    await expect(f.leases.switchClientPageProfile(f.authority, isolated)).rejects.toThrow(
      'reservation_pending'
    )
    release()
    const next = await switching
    expect(f.h.executor.hasPage('page-a', next.pageHostGeneration)).toBe(true)
    await f.dispatcher.close()
    await f.h.executor.close()
  })

  it('rejects arbitrary partition metadata instead of admitting a local cookie jar', () => {
    expect(() =>
      BrowserClientProfileMetadata.parse({ ...isolated, partition: 'persist:local-default' })
    ).toThrow()
    expect(() => BrowserClientProfileMetadata.parse({ ...isolated, scope: 'unknown' })).toThrow()
    expect(() => BrowserClientProfileMetadata.parse({ ...isolated, id: '' })).toThrow()
  })
})
