/**
 * dsh-memory-knowledge — Host entry.
 *
 * Wires the store and engine into DSH:
 *
 *   - a per-agent system-prompt section (the snapshot), computed once when the
 *     agent is created so the prompt prefix never changes inside a session;
 *   - the agent tools (three for everyone, the curation set for curators);
 *   - curator agents (cwd = the memory workspace) get the curation protocol and
 *     a tool restriction to memory + read-only file tools;
 *   - the nightly schedule, created and repaired automatically;
 *   - a file watcher that turns hand edits into curation work;
 *   - skill links so library skills reach the session skill catalog;
 *   - same-origin HTTP routes for the settings page.
 *
 * Optional services are read with `ctx.get()` and checked; nothing here may
 * stop DSH from starting.
 *
 * @module dsh-memory-knowledge
 */

import { watch, existsSync, mkdirSync, readdirSync, lstatSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { resolveConfig, DEFAULTS } from './config.js'
import { Store } from './store.js'
import { Engine } from './engine.js'
import { installImporter } from './importer.js'
import { snapshotText, curatorProtocol, SCHEDULE_PROMPT, SCHEDULE_TITLE } from './prompt.js'
import { registerTools } from './tools.js'
import { GateError } from './gate.js'
import { cwdInScope } from './digest.js'

/** Prompt section placements: after MCP servers (3100), before tool SDK (5000). */
const SNAPSHOT_ORDER = 3200
const CURATOR_ORDER = 3210
/** Read-only file tools the curator may use beside memory tools. */
const CURATOR_FILE_TOOLS = ['read', 'glob', 'grep']
/** Route prefix of the settings page API. */
export const ROUTE = '/memory-knowledge'

/** Services the plugin needs before it activates; everything else is optional. */
export const inject = ['tools', 'agents']

/**
 * @param ctx - Host context.
 * @param raw - row config.
 */
export function apply(ctx, raw) {
  const warn = message => ctx.logger?.warn?.(`dsh-memory-knowledge: ${message}`)
  const info = message => ctx.logger?.info?.(`dsh-memory-knowledge: ${message}`)
  const config = resolveConfig(raw, warn)
  const state = { store: undefined, engine: undefined, ready: undefined, budgets: new WeakMap() }

  /** Lazily opened store; every caller awaits the same promise. */
  const ready = () => {
    state.ready ??= (async () => {
      const store = new Store(config, { logger: { info, warn } })
      await store.open()
      const engine = new Engine(store, {
        sessionQuery: () => ctx.get('sessionQuery'),
        sessionTitle: async (id) => {
          const query = ctx.get('sessionQuery')
          const title = await query?.readTitle?.(id)
          return title?.title ?? ''
        },
      })
      installImporter(engine)
      state.store = store
      state.engine = engine
      return engine
    })()
    return state.ready
  }

  ctx.effect(() => () => {
    state.store?.close()
    state.store = undefined
  }, 'dsh-memory-knowledge: store')

  const isCuratorCwd = cwd => typeof cwd === 'string' && (cwd === config.workspace || cwd.startsWith(config.workspace + sep))
  const isCurator = agent => isCuratorCwd(agent?.session?.header?.cwd)
  const inScope = agent => isCurator(agent) || cwdInScope(agent?.session?.header?.cwd, config.capture)
  const isSubagent = agent => {
    const header = agent?.session?.header
    return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
  }
  const budgetOf = agent => {
    let budget = state.budgets.get(agent)
    if (budget === undefined) {
      budget = { charsLeft: config.curator.maxCharsPerRun, sessionsLeft: config.curator.maxSessionsPerRun }
      state.budgets.set(agent, budget)
      state.engine?.beginRun()
    }
    return budget
  }

  /* ---------------- tools ---------------- */

  ctx.effect(() => {
    let disposers = []
    let cancelled = false
    import('@deepseek-ai/dsh-tools').then(({ defineTool }) => {
      if (cancelled) return
      disposers = registerTools(ctx, defineTool, {
        engine: () => {
          if (state.engine === undefined) throw new Error('记忆库还在加载，请稍后再试')
          return state.engine
        },
        isCurator,
        isSubagent,
        inScope,
        budget: budgetOf,
      })
    }).catch(error => warn(`tool registration failed: ${error?.message ?? error}`))
    return () => {
      cancelled = true
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-memory-knowledge: tools')

  /* ---------------- per-agent snapshot and curator setup ---------------- */

  /** Snapshot text frozen per agent. */
  const snapshots = new WeakMap()
  const snapshotFor = (agent) => {
    let text = snapshots.get(agent)
    if (text !== undefined) return text
    const engine = state.engine
    if (engine === undefined) return ''
    const preferences = engine.graph.items({ pool: 'memory', status: 'active' })
      .filter(row => row.kind === 'preference' || row.area === '偏好')
      .sort((a, b) => a.created_at - b.created_at)
      .map(row => {
        const found = engine.store.read(row.id)
        const claim = /\*\*结论\*\*[:：]\s*(.+)/.exec(found?.parsed.body ?? '')?.[1] ?? row.whenuse
        return { title: row.title, claim }
      })
    text = snapshotText({
      tag: config.injectTag,
      root: config.root,
      areas: engine.store.areas(),
      preferences,
      directoryMaxChars: config.inject.directoryMaxChars,
      profileMaxChars: config.inject.profileMaxChars,
      subagent: isSubagent(agent),
    })
    snapshots.set(agent, text)
    return text
  }

  const fibers = new Map()
  const installAgent = async (agent) => {
    if (fibers.has(agent)) return
    // Out of scope: no section, no cost.
    if (!inScope(agent)) return
    await ready().catch(error => warn(`store open failed: ${error?.message ?? error}`))
    const curator = isCurator(agent)
    // Freeze the snapshot now, before the first request is assembled.
    if (!curator) snapshotFor(agent)
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
      if (curator) {
        scope.systemPrompt.section({
          name: 'dsh-memory-knowledge:curator',
          order: CURATOR_ORDER,
          interpolate: false,
          text: () => curatorProtocol({ extra: config.curator.extraInstructions }),
        })
        try {
          scope.tools.restrict({ allow: CURATOR_FILE_TOOLS.filter(name => scope.tools.get(name, agent) !== undefined) })
        } catch (error) {
          warn(`curator tool restriction failed: ${error?.message ?? error}`)
        }
        if (state.store !== undefined) {
          const sandbox = ctx.get('sandboxPolicy')
          try { sandbox?.registerWritableRoot?.(agent.session, config.workspace) } catch { /* optional */ }
        }
      } else {
        scope.systemPrompt.section({
          name: 'dsh-memory-knowledge:snapshot',
          order: SNAPSHOT_ORDER,
          interpolate: false,
          text: () => snapshotFor(agent),
        })
      }
    })
    fibers.set(agent, fiber)
  }
  const disposeAgent = (agent) => {
    const fiber = fibers.get(agent)
    if (fiber === undefined) return
    fibers.delete(agent)
    fiber.dispose().catch(() => {})
  }
  ctx.on('agent/created', async ({ agent }) => { await installAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => disposeAgent(agent))
  ctx.effect(() => {
    for (const agent of ctx.agents.list()) void installAgent(agent)
    return () => { for (const agent of [...fibers.keys()]) disposeAgent(agent) }
  }, 'dsh-memory-knowledge: existing agents')

  /* ---------------- file watching ---------------- */

  ctx.effect(() => {
    let watcher
    let timer
    let interval
    let stopped = false
    const rescan = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (stopped || state.store === undefined) return
        state.store.scan().catch(error => warn(`scan failed: ${error?.message ?? error}`))
      }, 1500)
    }
    ready().then(() => {
      if (stopped) return
      try {
        watcher = watch(config.library, { recursive: true }, (_event, name) => {
          if (typeof name === 'string' && name.split(sep).some(part => part.startsWith('.'))) return
          rescan()
        })
        watcher.on('error', error => warn(`watcher error: ${error?.message ?? error}`))
      } catch (error) {
        warn(`file watching unavailable, falling back to periodic scans: ${error?.message ?? error}`)
      }
      // A slow periodic scan also restores id lines that waited for a quiet period.
      interval = setInterval(rescan, 120_000)
      interval.unref?.()
    }).catch(() => {})
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(interval)
      try { watcher?.close() } catch { /* already closed */ }
    }
  }, 'dsh-memory-knowledge: watcher')

  /* ---------------- skill links ---------------- */

  const linkTargets = () => {
    const targets = config.skills.linkTargets.length > 0 ? config.skills.linkTargets : [join(homedir(), '.agents', 'skills')]
    return targets.map(target => (target.startsWith('~/') ? join(homedir(), target.slice(2)) : resolve(target)))
  }
  const syncSkillLinks = () => {
    const engine = state.engine
    if (engine === undefined) return
    const live = new Map()
    for (const row of engine.graph.items({ pool: 'memory' })) {
      if (row.area !== 'skills' || row.status !== 'active') continue
      live.set(row.title, resolve(row.path, '..'))
    }
    for (const target of linkTargets()) {
      try {
        mkdirSync(target, { recursive: true })
        // Remove links this plugin made whose skill is gone.
        for (const name of readdirSync(target)) {
          const full = join(target, name)
          let info
          try { info = lstatSync(full) } catch { continue }
          if (!info.isSymbolicLink()) continue
          let pointsTo
          try { pointsTo = resolve(target, readlinkSync(full)) } catch { continue }
          if (!pointsTo.startsWith(config.skillsDir + sep)) continue
          if (live.get(name) !== pointsTo) unlinkSync(full)
        }
        for (const [name, dir] of live) {
          const full = join(target, name)
          if (existsSync(full)) {
            // A real folder of the same name belongs to someone else: never replace it.
            continue
          }
          symlinkSync(dir, full, 'dir')
        }
      } catch (error) {
        warn(`skill links for ${target} failed: ${error?.message ?? error}`)
      }
    }
  }
  ctx.effect(() => {
    let off
    ready().then(engine => {
      syncSkillLinks()
      off = engine.store.onChange(() => syncSkillLinks())
    }).catch(() => {})
    return () => off?.()
  }, 'dsh-memory-knowledge: skill links')

  /* ---------------- nightly schedule ---------------- */

  const timeZone = () => config.curator.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const desiredTarget = () => ({ kind: 'new', create: { cwd: config.workspace, ...(config.curator.agentPreset ? { agentPreset: config.curator.agentPreset } : {}) } })

  /**
   * Make the nightly task exist and carry our prompt and target, keeping the
   * user's own time and pause choices. Deletes it when curation is disabled.
   * @returns a short status string.
   */
  const reconcileSchedule = async () => {
    const schedule = ctx.get('schedule')
    const engine = await ready()
    if (schedule === undefined) return 'schedule-service-missing'
    const graph = engine.graph
    const known = graph.get('task')
    let entry
    if (known?.id) {
      try {
        const viewed = await schedule.view({ id: known.id })
        entry = viewed && !('code' in viewed) ? viewed : undefined
      } catch {
        entry = undefined
      }
    }
    if (!config.curator.enabled) {
      if (entry !== undefined) {
        await schedule.edit({ id: entry.id, action: 'delete' }).catch(() => {})
        graph.set('task', undefined)
      }
      return 'disabled'
    }
    // Ensure the workspace exists so the curator sessions appear under it.
    mkdirSync(config.workspace, { recursive: true })
    const registry = ctx.get('workspaceRegistry')
    try {
      if (registry !== undefined && (await registry.resolveByPath(config.workspace)) === undefined) {
        await registry.create(config.workspace, '记忆整理')
      }
    } catch (error) {
      warn(`workspace registration failed: ${error?.message ?? error}`)
    }
    if (entry === undefined || entry.status === 'ended') {
      const created = await schedule.create({
        title: SCHEDULE_TITLE,
        prompt: SCHEDULE_PROMPT,
        timing: { kind: 'daily', daily: { time: `${config.curator.time}:00`, time_zone: timeZone() } },
        target: desiredTarget(),
      })
      graph.set('task', { id: created.id, createdAt: Date.now() })
      engine.store.changelog.append({ op: 'task', actor: 'plugin', action: entry === undefined ? 'create' : 'recreate', task: created.id })
      return entry === undefined ? 'created' : 'recreated'
    }
    const target = entry.target ?? {}
    const wrongTarget = target.kind !== 'new' || target.create?.cwd !== config.workspace
      || (config.curator.agentPreset && target.create?.agentPreset !== config.curator.agentPreset)
    if (entry.prompt !== SCHEDULE_PROMPT || entry.title !== SCHEDULE_TITLE || wrongTarget) {
      await schedule.edit({ id: entry.id, action: 'update', patch: { title: SCHEDULE_TITLE, prompt: SCHEDULE_PROMPT, target: desiredTarget() } })
      engine.store.changelog.append({ op: 'task', actor: 'plugin', action: 'repair', task: entry.id })
      return 'repaired'
    }
    return 'ok'
  }

  ctx.effect(() => {
    let stopped = false
    let running = false
    const run = () => {
      if (stopped || running) return
      running = true
      reconcileSchedule()
        .then(status => { if (status !== 'ok') info(`nightly task: ${status}`) })
        .catch(error => warn(`nightly task reconcile failed: ${error?.message ?? error}`))
        .finally(() => { running = false })
    }
    const timer = setTimeout(run, 3000)
    const off = ctx.on('schedule/changed', () => setTimeout(run, 500))
    return () => {
      stopped = true
      clearTimeout(timer)
      off?.()
    }
  }, 'dsh-memory-knowledge: schedule')

  /* ---------------- settings-page routes ---------------- */

  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      // The page is the only caller, so the route takes DSH's own browser gate:
      // loopback Host (no DNS rebinding), same origin, and an authenticated
      // page connection. Our fence still applies on top of it.
      const connection = webCtx.get('connection') ?? Reflect.get(webCtx, 'connection')
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined
      if (rejection !== undefined) return sendJson(res, rejection, { ok: false, code: 'UNTRUSTED', message: '请求未通过 DSH 页面认证' })
      const violation = sameOriginViolation(req)
      if (violation !== null) return sendJson(res, 403, { ok: false, code: 'BAD_ORIGIN', message: violation })
      const url = new URL(req.url ?? '/', 'http://local')
      const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')
      try {
        const engine = await ready()
        if (req.method === 'GET' && action === 'status') {
          const status = engine.status()
          return sendJson(res, 200, { ok: true, ...status, config: publicConfig(config), raw: raw ?? {}, defaults: DEFAULTS })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请使用 POST' })
        const body = await readJsonBody(req)
        switch (action) {
          case 'diff': return sendJson(res, 200, { ok: true, ...engine.diffOf(body) })
          case 'undo': return sendJson(res, 200, await engine.undo(body, { actor: 'human' }))
          case 'scan': return sendJson(res, 200, { ok: true, summary: await engine.store.scan() })
          case 'import': return sendJson(res, 200, await engine.queueImport(body))
          case 'run-now': {
            const schedule = webCtx.get('schedule')
            const task = engine.graph.get('task')
            if (schedule === undefined || !task?.id) return sendJson(res, 409, { ok: false, code: 'NO_TASK', message: '整理任务还没建好' })
            const result = await schedule.run({ id: task.id })
            return sendJson(res, 200, { ok: !('code' in result), result })
          }
          case 'repair-task': return sendJson(res, 200, { ok: true, status: await reconcileSchedule() })
          case 'config': {
            const entry = ctx.fiber?.entry ?? ctx.scope?.entry
            const editor = webCtx.get('configEditor')
            if (entry === undefined || editor === undefined) return sendJson(res, 409, { ok: false, code: 'NO_EDITOR', message: '当前配置不支持在页面里保存' })
            const patch = body?.patch
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return sendJson(res, 400, { ok: false, code: 'BAD_BODY', message: 'patch 必须是对象' })
            await editor.edit(entry, current => mergeConfig(current, patch))
            return sendJson(res, 200, { ok: true })
          }
          default: return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `未知操作 ${action}` })
        }
      } catch (error) {
        if (error instanceof GateError) return sendJson(res, 409, { ok: false, code: error.code, message: error.detail })
        warn(`route ${action} failed: ${error?.message ?? error}`)
        return sendJson(res, 500, { ok: false, code: 'FAILED', message: String(error?.message ?? error) })
      }
    }
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-memory-knowledge: routes')
  })
}

/**
 * Settings that the page may display (no secrets exist in this config).
 * @param config - resolved config.
 * @returns plain object.
 */
function publicConfig(config) {
  const { root, injectTag, curator, capture, inject: injectCfg, recall, pools, history, skills, library, workspace } = config
  return { root, library, workspace, injectTag, curator, capture, inject: injectCfg, recall, pools, history, skills }
}

/**
 * Deep-merge a settings patch into the row config: objects merge one level,
 * everything else replaces.
 * @param current - current row config.
 * @param patch - partial config.
 * @returns new config.
 */
export function mergeConfig(current, patch) {
  const out = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])) {
      out[key] = { ...out[key], ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Fallback fence under DSH's own gate: loopback Host only (DNS rebinding), an
 * `Origin` naming another host is refused, mutations must be JSON (a cross-site
 * form cannot send that content type).
 * @param req - Node request.
 * @returns refusal message or null.
 */
export function sameOriginViolation(req) {
  const hostHeader = String(req.headers?.host ?? '')
  if (hostHeader.length > 0) {
    let hostname = ''
    try { hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase() } catch { return 'Host 头无法解析' }
    const loopback = hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    if (!loopback) return 'Host 头不是本机地址'
  }
  const origin = String(req.headers?.origin ?? '')
  if (origin !== '') {
    const host = String(req.headers?.host ?? '')
    let originHost
    try { originHost = new URL(origin).host } catch { return 'Origin 请求头格式不正确' }
    if (host !== '' && originHost !== host) return '已拒绝跨站请求'
  }
  if (req.method === 'POST') {
    const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return '请求必须是 application/json 类型'
  }
  const site = String(req.headers?.['sec-fetch-site'] ?? '')
  if (site !== '' && site !== 'same-origin' && site !== 'none') return '已拒绝跨站请求'
  return null
}

/**
 * @param req - Node request.
 * @returns parsed JSON body (empty object for an empty body).
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim().length === 0 ? {} : JSON.parse(text)
}

/**
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON body.
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export { DAY_TOOLS, CURATOR_TOOLS } from './tools.js'
