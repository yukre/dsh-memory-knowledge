/**
 * Resolved plugin configuration.
 *
 * The row's `config` arrives as a plain object (the patch inserts `{}`). This
 * module fills every default and validates the few values whose bad shape would
 * be harmful later (a tag name that could break the injected wrapper, a budget
 * of zero). It deliberately does NOT export a schemastery `Config`: the loader
 * would validate the row with it, and a schema mismatch after an upgrade would
 * stop the plugin from loading at all, which costs the user every memory for a
 * cosmetic config problem. Bad values fall back to defaults with a warning.
 *
 * @module dsh-memory-knowledge/config
 */

import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'

/** Default values, mirrored in cordis.patch.yml comments and the settings page. */
export const DEFAULTS = Object.freeze({
  memoryRoot: '',
  injectTag: 'dmk',
  curator: Object.freeze({
    enabled: true,
    time: '00:30',
    timeZone: '',
    agentPreset: '',
    maxSessionsPerRun: 30,
    maxCharsPerSession: 12000,
    maxCharsPerRun: 120000,
    extraInstructions: '',
    keepRunDays: 7,
  }),
  capture: Object.freeze({
    includeCwd: Object.freeze([]),
    excludeCwd: Object.freeze([]),
    humanSourceKinds: Object.freeze(['user']),
  }),
  inject: Object.freeze({
    directoryMaxChars: 400,
    profileMaxChars: 600,
  }),
  recall: Object.freeze({
    limit: 5,
    snippetChars: 400,
  }),
  pools: Object.freeze({
    promoteVotes: 2,
    stagingExpireDays: 60,
  }),
  history: Object.freeze({
    keepVersions: 10,
    keepDays: 90,
  }),
  skills: Object.freeze({
    maxSkills: 20,
    linkTargets: Object.freeze([]),
    dormantDays: 60,
  }),
})

/** A tag name that cannot break out of `<tag>…</tag>`. */
const TAG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/

/**
 * The DSH home directory, honouring `DSH_HOME` the way DSH itself does.
 * @returns absolute path.
 */
export function dshHome() {
  const value = process.env.DSH_HOME
  return value !== undefined && value.length > 0 ? resolve(value) : join(homedir(), '.dsh')
}

/**
 * Merge one nested section with its defaults, keeping only known keys whose
 * type matches the default's type.
 * @param defaults - frozen default section.
 * @param input - user-provided section, possibly malformed.
 * @param warn - receives a message for each rejected value.
 * @param path - dotted path for messages.
 * @returns a fresh, plain object.
 */
function mergeSection(defaults, input, warn, path) {
  const out = {}
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = source[key]
    if (value === undefined) {
      out[key] = Array.isArray(fallback) ? [...fallback] : fallback
      continue
    }
    if (Array.isArray(fallback)) {
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        out[key] = [...value]
      } else {
        warn(`${path}.${key} must be an array of strings; using the default`)
        out[key] = [...fallback]
      }
      continue
    }
    if (typeof value !== typeof fallback) {
      warn(`${path}.${key} must be a ${typeof fallback}; using the default`)
      out[key] = fallback
      continue
    }
    if (typeof value === 'number' && !(Number.isFinite(value) && value >= 0)) {
      warn(`${path}.${key} must be a non-negative number; using the default`)
      out[key] = fallback
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Resolve the row config into a complete, validated object.
 * @param raw - the row's `config`, any shape.
 * @param warn - logger for rejected values; defaults to a no-op.
 * @returns resolved config plus derived absolute paths.
 */
export function resolveConfig(raw, warn = () => {}) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let memoryRoot = typeof input.memoryRoot === 'string' ? input.memoryRoot.trim() : ''
  if (memoryRoot.startsWith('~/')) memoryRoot = join(homedir(), memoryRoot.slice(2))
  if (memoryRoot.length > 0 && !isAbsolute(memoryRoot)) {
    warn('memoryRoot must be an absolute path; using the default')
    memoryRoot = ''
  }
  const root = memoryRoot.length > 0 ? resolve(memoryRoot) : join(dshHome(), 'memory-knowledge')

  let injectTag = typeof input.injectTag === 'string' ? input.injectTag.trim() : DEFAULTS.injectTag
  if (!TAG_PATTERN.test(injectTag)) {
    warn(`injectTag "${injectTag}" is not a plain tag name; using "${DEFAULTS.injectTag}"`)
    injectTag = DEFAULTS.injectTag
  }

  const curator = mergeSection(DEFAULTS.curator, input.curator, warn, 'curator')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(curator.time)) {
    warn(`curator.time "${curator.time}" is not HH:mm; using ${DEFAULTS.curator.time}`)
    curator.time = DEFAULTS.curator.time
  }
  for (const key of ['maxSessionsPerRun', 'maxCharsPerSession', 'maxCharsPerRun']) {
    if (curator[key] < 1) curator[key] = DEFAULTS.curator[key]
  }

  const config = {
    root,
    injectTag,
    curator,
    capture: mergeSection(DEFAULTS.capture, input.capture, warn, 'capture'),
    inject: mergeSection(DEFAULTS.inject, input.inject, warn, 'inject'),
    recall: mergeSection(DEFAULTS.recall, input.recall, warn, 'recall'),
    pools: mergeSection(DEFAULTS.pools, input.pools, warn, 'pools'),
    history: mergeSection(DEFAULTS.history, input.history, warn, 'history'),
    skills: mergeSection(DEFAULTS.skills, input.skills, warn, 'skills'),
  }
  config.capture.includeCwd = expandPaths(config.capture.includeCwd)
  config.capture.excludeCwd = expandPaths(config.capture.excludeCwd)
  if (config.recall.limit < 1) config.recall.limit = DEFAULTS.recall.limit
  if (config.pools.promoteVotes < 1) config.pools.promoteVotes = DEFAULTS.pools.promoteVotes
  return Object.assign(config, layout(root))
}

/**
 * Expand configured directories: `~/` prefix, absolute form, and the real path
 * (session cwds are recorded resolved, e.g. /tmp → /private/tmp on macOS).
 * @param list - configured paths.
 * @returns deduplicated absolute paths without trailing slashes.
 */
export function expandPaths(list) {
  const out = new Set()
  for (const entry of list ?? []) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue
    let path = entry.trim()
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
    if (!isAbsolute(path)) continue
    path = resolve(path)
    out.add(path)
    out.add(realPath(path))
  }
  return [...out]
}

/**
 * Real path of a possibly missing path: resolve the nearest existing ancestor
 * and append the rest (e.g. /tmp/new → /private/tmp/new on macOS).
 * @param path - absolute path.
 * @returns real path.
 */
export function realPath(path) {
  let head = path
  const tail = []
  for (;;) {
    try { return [realpathSync(head), ...tail].join('/').replace(/\/+/g, '/') } catch { /* keep walking up */ }
    const parent = resolve(head, '..')
    if (parent === head) return path
    tail.unshift(head.slice(parent.length).replace(/^\/+/, ''))
    head = parent
  }
}

/**
 * Every directory and file the plugin owns, derived from the root.
 * @param root - plugin data root.
 * @returns absolute paths.
 */
export function layout(root) {
  const library = join(root, 'library')
  const meta = join(root, 'meta')
  return {
    library,
    staging: join(library, '_staging'),
    archive: join(library, '_archive'),
    skillsDir: join(library, 'skills'),
    workspace: join(root, 'workspace'),
    meta,
    changelogFile: join(meta, 'changelog.jsonl'),
    historyDir: join(meta, 'history'),
    graphFile: join(meta, 'graph.sqlite'),
  }
}
