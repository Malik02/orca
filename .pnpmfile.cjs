'use strict'

// Why: pnpm keeps an explicitly enabled global virtual store on under CI. CI jobs package from,
// cache, and verify a project-local node_modules, so they get the normal layout.
function isCi(env) {
  return (Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0') || env.GITHUB_ACTIONS === 'true'
}

module.exports = {
  hooks: {
    updateConfig(config) {
      if (isCi(process.env)) {
        config.enableGlobalVirtualStore = false
      }
      return config
    }
  },
  isCi
}
