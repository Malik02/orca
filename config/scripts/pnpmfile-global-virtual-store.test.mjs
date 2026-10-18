import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  GLOBAL_VIRTUAL_STORE_ENV: STORE_ENV,
  usesGlobalVirtualStore,
  hooks
} = require('../pnpmfile.cjs')

describe('usesGlobalVirtualStore', () => {
  const cases = [
    // [env, platform, expected]
    [{}, 'darwin', true],
    [{}, 'linux', true],
    [{}, 'win32', false],
    [{ [STORE_ENV]: '1' }, 'win32', true],
    [{ [STORE_ENV]: '0' }, 'win32', false],
    [{ [STORE_ENV]: '0' }, 'darwin', false],
    [{ [STORE_ENV]: 'yes' }, 'linux', true],
    [{ CI: 'true' }, 'darwin', false],
    [{ CI: '1' }, 'linux', false],
    [{ GITHUB_ACTIONS: 'true' }, 'linux', false],
    [{ CI: 'true', [STORE_ENV]: '1' }, 'win32', false],
    [{ CI: 'false' }, 'darwin', true],
    [{ CI: '0' }, 'linux', true]
  ]
  it.each(cases)('env %j on %s -> %s', (env, platform, expected) => {
    expect(usesGlobalVirtualStore({ env, platform })).toBe(expected)
  })
})

describe('config/pnpmfile.cjs updateConfig', () => {
  it('sets the store from the policy, so pnpm-workspace.yaml never has to', () => {
    const config = hooks.updateConfig({})
    expect(config.enableGlobalVirtualStore).toBe(usesGlobalVirtualStore())
  })
})
