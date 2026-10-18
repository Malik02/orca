import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  GLOBAL_VIRTUAL_STORE_OPT_IN_ENV: OPT_IN_ENV,
  allowsGlobalVirtualStore,
  hooks
} = require('../../.pnpmfile.cjs')

describe('allowsGlobalVirtualStore', () => {
  const cases = [
    // [env, platform, expected]
    [{}, 'darwin', true],
    [{}, 'linux', true],
    [{}, 'win32', false],
    [{ [OPT_IN_ENV]: '1' }, 'win32', true],
    [{ [OPT_IN_ENV]: '0' }, 'win32', false],
    [{ CI: 'true' }, 'darwin', false],
    [{ CI: '1' }, 'linux', false],
    [{ GITHUB_ACTIONS: 'true' }, 'linux', false],
    [{ CI: 'true', [OPT_IN_ENV]: '1' }, 'win32', false],
    [{ CI: 'false' }, 'darwin', true],
    [{ CI: '0' }, 'linux', true]
  ]
  it.each(cases)('env %j on %s -> %s', (env, platform, expected) => {
    expect(allowsGlobalVirtualStore({ env, platform })).toBe(expected)
  })
})

describe('.pnpmfile.cjs updateConfig', () => {
  it('only ever turns the store off, never on', () => {
    const config = hooks.updateConfig({ enableGlobalVirtualStore: false })
    expect(config.enableGlobalVirtualStore).toBe(false)
  })
})
