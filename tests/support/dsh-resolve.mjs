/**
 * Test-only resolve hook: inside the DSH host, `@deepseek-ai/*` packages come
 * from the DSH installation. Outside it, retry such a specifier as if it were
 * imported from that installation's node_modules, so tests exercise the real
 * packages instead of stand-ins.
 *
 * Usage: ELECTRON_RUN_AS_NODE=1 <DSH executable> --import ./tests/support/dsh-resolve.mjs --test tests/*.test.mjs
 */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const base = process.env.DSH_NODE_MODULES
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules'
const parentURL = pathToFileURL(`${base}/../index.js`).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('@deepseek-ai/')) throw error
      return nextResolve(specifier, { ...context, parentURL })
    }
  },
})
