'use strict'

// Self-contained on purpose: scratch installs copy this file alone, beside the lockfile that pins its checksum.
const GLOBAL_VIRTUAL_STORE_OPT_IN_ENV = 'ORCA_PNPM_GLOBAL_VIRTUAL_STORE'

function isCi(env) {
  return (Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0') || env.GITHUB_ACTIONS === 'true'
}

/**
 * Whether pnpm may use the global virtual store pnpm-workspace.yaml enables.
 *
 * CI always gets the normal layout: pnpm keeps an explicit setting on there, and CI packages
 * from, caches, and verifies a project-local node_modules. Windows needs an opt-in because its
 * store links are true symlinks, unverified for users without admin or Developer Mode.
 */
function allowsGlobalVirtualStore({ env = process.env, platform = process.platform } = {}) {
  if (isCi(env)) {
    return false
  }
  return platform !== 'win32' || env[GLOBAL_VIRTUAL_STORE_OPT_IN_ENV] === '1'
}

module.exports = {
  hooks: {
    updateConfig(config) {
      if (!allowsGlobalVirtualStore()) {
        config.enableGlobalVirtualStore = false
      }
      return config
    }
  },
  GLOBAL_VIRTUAL_STORE_OPT_IN_ENV,
  allowsGlobalVirtualStore
}
