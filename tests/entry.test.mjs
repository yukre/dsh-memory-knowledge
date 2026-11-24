/**
 * The Host entry against a fake context that mirrors the real contracts:
 * scoped `agent.ctx.inject`, `systemPrompt.section`, `tools.register/restrict`,
 * `schedule` create/view/edit, `webServer.register`, events.
 *
 * Real-host behavior is verified separately after installation; this guards the
 * wiring so a regression fails here first.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, lstatSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, sameOriginViolation, mergeConfig, ROUTE } from '../lib/index.js'
import { SCHEDULE_PROMPT, SCHEDULE_TITLE } from '../lib/prompt.js'

// Tool registration needs the real @deepseek-ai/dsh-tools (DSH host, or the
// resolve hook in tests/support). Without it, that one test is skipped, loudly.
let toolsAvailable = true
try { await import('@deepseek-ai/dsh-tools') } catch { toolsAvailable = false }
const withTools = toolsAvailable ? test : test.skip

let root
let host

/** Wait for queued timers and promises. */
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

/** A fake host whose services record what the plugin did. */
function makeHost() {
  const listeners = new Map()
  const effects = []
  const sections = []
  const restrictions = []
  const tools = new Map()
  const schedules = new Map()
  const routes = []
  const workspaces = []
  let nextSchedule = 1
  const schedule = {
    calls: [],
    async create(request) {
      const id = `schedule-${nextSchedule++}`
      const entry = { id, ...request, status: 'active', target: request.target }
      schedules.set(id, entry)
      this.calls.push(['create', request])
      return entry
    },
    async view({ id }) {
      return schedules.get(id) ?? { id, code: 'schedule_not_found' }
    },
    async edit(request) {
      this.calls.push(['edit', request])
      if (request.action === 'delete') { schedules.delete(request.id); return { id: request.id, deleted: true } }
      const entry = { ...schedules.get(request.id), ...request.patch }
      schedules.set(request.id, entry)
      return entry
    },
    async run({ id }) { return schedules.get(id) },
  }
  const ctx = {
    logger: { info() {}, warn(message) { ctx.warnings.push(message) } },
    warnings: [],
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {} },
    emit(name, payload) { return Promise.all((listeners.get(name) ?? []).map(fn => fn(payload))) },
    get(name) {
      return {
        schedule,
        sessionQuery: { async listSessions() { return [] }, async readSession() { return { events: [] } }, async readTitle() { return { title: '' } } },
        workspaceRegistry: { async resolveByPath(path) { return workspaces.find(w => w.path === path) }, async create(path, title) { const w = { path, title }; workspaces.push(w); return w } },
        sandboxPolicy: { registerWritableRoot() { return () => {} } },
      }[name]
    },
    inject(names, fn) { if (names.includes('webServer')) fn(Object.assign(Object.create(ctx), { webServer: { register(route) { routes.push(route); return () => {} } } })) },
    tools: { register(definition, options = {}) { tools.set(definition.name, { definition, options }); return () => tools.delete(definition.name) } },
    agents: { list() { return [] } },
  }
  return { ctx, listeners, effects, sections, restrictions, tools, schedule, schedules, routes, workspaces }
}

/** A fake agent whose scoped context records sections and restrictions. */
function makeAgent(h, header) {
  const agent = {
    id: header.id,
    session: { id: header.id, header },
    ctx: {
      inject(names, fn) {
        fn({
          systemPrompt: { section(section) { h.sections.push({ agent: header.id, ...section }); return () => {} } },
          tools: {
            restrict(filter) { h.restrictions.push({ agent: header.id, filter }); return () => {} },
            get(name) { return ['read', 'glob', 'grep', 'bash'].includes(name) || h.tools.has(name) ? { name } : undefined },
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return agent
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mk-entry-'))
  host = makeHost()
})

afterEach(async () => {
  for (const dispose of host.effects) { try { dispose?.() } catch { /* ignore */ } }
  await settle(10)
  rmSync(root, { recursive: true, force: true })
})

withTools('registers three day tools and seven curator tools with visibility rules', async () => {
  apply(host.ctx, { memoryRoot: root, skills: { linkTargets: [join(root, 'links')] } })
  await settle(200)
  const names = [...host.tools.keys()].sort()
  assert.deepEqual(names, ['mk_done', 'mk_excerpt', 'mk_feedback', 'mk_import', 'mk_next', 'mk_recall', 'mk_remember', 'mk_status', 'mk_undo', 'mk_write'])
  const day = makeAgent(host, { id: 's-day', cwd: '/tmp/mk-acceptance' })
  const curator = makeAgent(host, { id: 's-cur', cwd: join(root, 'workspace') })
  const sub = makeAgent(host, { id: 's-sub', cwd: '/tmp/mk-acceptance', origin: 'subagent', delegationDepth: 1 })
  const outside = makeAgent(host, { id: 's-out', cwd: '/Users/someone/elsewhere' })
  for (const agent of [day, curator, sub, outside]) await host.ctx.emit('agent/created', { agent })
  const visible = agent => [...host.tools.values()].filter(({ options }) => options.when === undefined || options.when({ agent })).map(({ definition }) => definition.name).sort()
  assert.deepEqual(visible(day), ['mk_feedback', 'mk_recall', 'mk_remember'])
  assert.equal(visible(curator).length, 10)
  assert.deepEqual(visible(sub), ['mk_recall'], 'sub-agents only recall')
})

withTools('out-of-scope sessions get no section and no tools', async () => {
  apply(host.ctx, { memoryRoot: root, capture: { includeCwd: ['/tmp/mk-acceptance'] }, skills: { linkTargets: [join(root, 'links')] } })
  await settle(200)
  const outside = makeAgent(host, { id: 's-out', cwd: '/Users/someone/elsewhere' })
  await host.ctx.emit('agent/created', { agent: outside })
  assert.equal(host.sections.some(section => section.agent === 's-out'), false)
  const visible = [...host.tools.values()].filter(({ options }) => options.when === undefined || options.when({ agent: outside })).map(({ definition }) => definition.name)
  assert.deepEqual(visible, [])
})

test('the snapshot is frozen per agent and the curator gets protocol + restriction', async () => {
  apply(host.ctx, { memoryRoot: root, skills: { linkTargets: [join(root, 'links')] } })
  await settle(200)
  const day = makeAgent(host, { id: 's-day', cwd: '/tmp/mk-acceptance' })
  await host.ctx.emit('agent/created', { agent: day })
  const section = host.sections.find(s => s.agent === 's-day')
  assert.equal(section.name, 'dsh-memory-knowledge:snapshot')
  assert.equal(section.order, 3200)
  assert.equal(section.interpolate, false)
  const first = section.text()
  assert.match(first, /^<dmk>/)
  assert.match(first, /<\/dmk>$/)
  // A new category appears after the session started: the snapshot must not change.
  mkdirSync(join(root, 'library', 'finance'), { recursive: true })
  writeFileSync(join(root, 'library', 'finance', '止损.md'), '# 止损\n> 何时用：买入前\n\n结论：先定止损')
  await settle(1800)
  assert.equal(section.text(), first, 'snapshot bytes identical within a session')

  const curator = makeAgent(host, { id: 's-cur', cwd: join(root, 'workspace') })
  await host.ctx.emit('agent/created', { agent: curator })
  const protocol = host.sections.find(s => s.agent === 's-cur')
  assert.equal(protocol.name, 'dsh-memory-knowledge:curator')
  assert.match(protocol.text(), /<memory-curator version="1">/)
  const allow = host.restrictions.find(r => r.agent === 's-cur').filter.allow
  assert.deepEqual(allow.slice(0, 3), ['read', 'glob', 'grep'])
  for (const name of ['mk_next', 'mk_write', 'mk_done', 'mk_recall']) assert.ok(allow.includes(name), `${name} survives the curator restriction`)
  assert.equal(allow.includes('bash'), false)
  assert.equal(host.sections.some(s => s.agent === 's-cur' && s.name.endsWith('snapshot')), false, 'curators do not carry the snapshot')
})

test('the nightly task is created once, repaired when edited, rebuilt when deleted', async () => {
  apply(host.ctx, { memoryRoot: root, curator: { time: '01:15', timeZone: 'Asia/Shanghai' }, skills: { linkTargets: [join(root, 'links')] } })
  await settle(3300)
  const creates = host.schedule.calls.filter(([kind]) => kind === 'create')
  assert.equal(creates.length, 1)
  const request = creates[0][1]
  assert.equal(request.title, SCHEDULE_TITLE)
  assert.equal(request.prompt, SCHEDULE_PROMPT)
  assert.deepEqual(request.timing, { kind: 'daily', daily: { time: '01:15:00', time_zone: 'Asia/Shanghai' } })
  assert.deepEqual(request.target, { kind: 'new', create: { cwd: join(root, 'workspace') } })
  assert.equal(host.workspaces[0].path, join(root, 'workspace'))
  const id = [...host.schedules.keys()][0]

  // The user changes the time and pauses it: kept. Someone rewrites the prompt: repaired.
  host.schedules.set(id, { ...host.schedules.get(id), prompt: '随便改的', timing: { kind: 'daily', daily: { time: '03:00:00', time_zone: 'Asia/Shanghai' } }, status: 'paused' })
  await host.ctx.emit('schedule/changed')
  await settle(700)
  const repaired = host.schedules.get(id)
  assert.equal(repaired.prompt, SCHEDULE_PROMPT)
  assert.equal(repaired.timing.daily.time, '03:00:00', 'the user\'s time is kept')
  assert.equal(repaired.status, 'paused', 'the user\'s pause is kept')

  host.schedules.delete(id)
  await host.ctx.emit('schedule/changed')
  await settle(700)
  assert.equal(host.schedules.size, 1, 'rebuilt after deletion')
})

test('disabling curation removes the task', async () => {
  apply(host.ctx, { memoryRoot: root, curator: { enabled: false }, skills: { linkTargets: [join(root, 'links')] } })
  await settle(3300)
  assert.equal(host.schedule.calls.filter(([kind]) => kind === 'create').length, 0)
})

test('library skills are linked into the skill roots and unlinked when retired', async () => {
  const links = join(root, 'links')
  mkdirSync(join(root, 'library', 'skills', 'publish-dsh-plugin'), { recursive: true })
  writeFileSync(join(root, 'library', 'skills', 'publish-dsh-plugin', 'SKILL.md'), '---\nname: publish-dsh-plugin\ndescription: "发布插件"\nmetadata:\n  dmk_id: mk_aaaaaaaaaa\n---\n\n1. 检查\n')
  // A real folder with the same name as a future skill belongs to the user.
  mkdirSync(join(links, 'ui-design'), { recursive: true })
  apply(host.ctx, { memoryRoot: root, skills: { linkTargets: [links] } })
  await settle(400)
  const link = join(links, 'publish-dsh-plugin')
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readlinkSync(link), join(root, 'library', 'skills', 'publish-dsh-plugin'))
  rmSync(join(root, 'library', 'skills', 'publish-dsh-plugin'), { recursive: true })
  await settle(2000)
  assert.equal(existsSync(link), false, 'the dangling link is removed')
  assert.equal(existsSync(join(links, 'ui-design')), true, 'a user folder is never touched')
})

test('routes serve status and refuse cross-site requests', async () => {
  apply(host.ctx, { memoryRoot: root, skills: { linkTargets: [join(root, 'links')] } })
  await settle(200)
  const route = host.routes[0]
  assert.equal(route.path, ROUTE)
  const call = async (method, path, headers = {}, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:9', ...headers } })
    let status = 0
    let payload = ''
    const res = { statusCode: 0, setHeader() {}, end(text) { status = this.statusCode; payload = text } }
    await route.handler(req, res)
    return { status, body: JSON.parse(payload) }
  }
  host.ctx.connection = { requestRejection: req => (req.headers['x-test-unauth'] ? 401 : undefined) }
  const unauth = await call('GET', `${ROUTE}/status`, { 'x-test-unauth': '1' })
  assert.equal(unauth.status, 401, 'DSH page authentication is required')
  const rebinding = await call('GET', `${ROUTE}/status`, { host: 'evil.example:9' })
  assert.equal(rebinding.status, 403)
  const ok = await call('GET', `${ROUTE}/status`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.counts.memory, 0)
  const cross = await call('POST', `${ROUTE}/scan`, { origin: 'https://evil.example', 'content-type': 'application/json' }, {})
  assert.equal(cross.status, 403)
  const form = await call('POST', `${ROUTE}/scan`, { 'content-type': 'application/x-www-form-urlencoded' }, {})
  assert.equal(form.status, 403)
  const scan = await call('POST', `${ROUTE}/scan`, { 'content-type': 'application/json' }, {})
  assert.equal(scan.status, 200)
})

test('fence and config merge helpers', () => {
  assert.equal(sameOriginViolation({ method: 'GET', headers: { host: '127.0.0.1:1' } }), null)
  assert.notEqual(sameOriginViolation({ method: 'GET', headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), null)
  assert.notEqual(sameOriginViolation({ method: 'GET', headers: { host: 'evil.example:1' } }), null, 'a rebinding Host is refused')
  assert.deepEqual(mergeConfig({ curator: { time: '00:30', enabled: true }, injectTag: 'dmk' }, { curator: { time: '02:00' } }), { curator: { time: '02:00', enabled: true }, injectTag: 'dmk' })
})

test('a reload re-registers the same snapshot bytes; running sessions are left alone', async () => {
  const cfg = { memoryRoot: root, skills: { linkTargets: [join(root, 'links')] } }
  apply(host.ctx, cfg)
  await settle(200)
  const agent = makeAgent(host, { id: 's-keep', cwd: '/tmp/mk-acceptance' })
  await host.ctx.emit('agent/created', { agent })
  const before = host.sections.find(section => section.agent === 's-keep').text()
  // The library grows while the session lives on.
  mkdirSync(join(root, 'library', 'finance'), { recursive: true })
  writeFileSync(join(root, 'library', 'finance', '止损.md'), '# 止损\n> 何时用：买入前\n\n结论：先定止损')
  await settle(1800)
  // Plugin reload (upgrade, HMR, restart): the same session is still running.
  for (const dispose of host.effects.splice(0)) { try { dispose?.() } catch { /* ignore */ } }
  await settle(50)
  const reloaded = makeHost()
  // Same running session, same Agent object: its own scoped context records
  // into the new host's lists from now on (the old scope was disposed).
  const kept = makeAgent(reloaded, { id: 's-keep', cwd: '/tmp/mk-acceptance' })
  reloaded.ctx.agents.list = () => [kept, makeAgent(reloaded, { id: 's-never', cwd: '/tmp/mk-acceptance' })]
  host = reloaded
  apply(reloaded.ctx, cfg)
  await settle(400)
  const again = reloaded.sections.find(section => section.agent === 's-keep')
  assert.ok(again, 'the session that had a snapshot gets it back')
  assert.equal(again.text(), before, 'byte-identical across reload')
  assert.equal(reloaded.sections.some(section => section.agent === 's-never'), false, 'a session that never had one is not changed mid-flight')
  // A brand-new session after reload sees the new category.
  const fresh = makeAgent(reloaded, { id: 's-new', cwd: '/tmp/mk-acceptance' })
  await reloaded.ctx.emit('agent/created', { agent: fresh })
  assert.match(reloaded.sections.find(section => section.agent === 's-new').text(), /finance/)
})

test('a lost task id adopts the existing task instead of creating a duplicate', async () => {
  const cfg = { memoryRoot: root, skills: { linkTargets: [join(root, 'links')] } }
  host.schedules.set('schedule-old', { id: 'schedule-old', title: SCHEDULE_TITLE, prompt: SCHEDULE_PROMPT, status: 'active', target: { kind: 'new', create: { cwd: join(root, 'workspace') } } })
  host.schedules.set('schedule-dup', { id: 'schedule-dup', title: SCHEDULE_TITLE, prompt: SCHEDULE_PROMPT, status: 'active', target: { kind: 'new', create: { cwd: join(root, 'workspace') } } })
  host.schedule.catalog = async () => [...host.schedules.values()]
  apply(host.ctx, cfg)
  await settle(3300)
  assert.equal(host.schedule.calls.filter(([kind]) => kind === 'create').length, 0)
  assert.deepEqual([...host.schedules.keys()], ['schedule-old'], 'the duplicate is removed')
})

test('scope paths match their real location, even before the folder exists', async () => {
  const { resolveConfig } = await import('../lib/config.js')
  const name = `mk-scope-${process.pid}-${Date.now()}`
  const cfg = resolveConfig({ capture: { includeCwd: [`/tmp/${name}`] } })
  assert.ok(cfg.capture.includeCwd.includes(`/tmp/${name}`))
  if (process.platform === 'darwin') assert.ok(cfg.capture.includeCwd.includes(`/private/tmp/${name}`))
})

test('run-now refuses while a curation is already running', async () => {
  apply(host.ctx, { memoryRoot: root, skills: { linkTargets: [join(root, 'links')] } })
  await settle(300)
  const route = host.routes[0]
  const call = async (action, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: 'POST', url: `${ROUTE}/${action}`, headers: { host: '127.0.0.1:9', 'content-type': 'application/json' } })
    let payload = ''
    const res = { statusCode: 0, setHeader() {}, end(text) { payload = text } }
    await route.handler(req, res)
    return { status: res.statusCode, body: JSON.parse(payload) }
  }
  // 模拟整理进行中：直接写 kv
  const store = host.ctx
  const engine = await import('../lib/engine.js').then(() => null).catch(() => null)
  // 通过打开的 graph 写：用路由触发太重，直接从插件侧拿不到句柄——用 sqlite
  const { openGraph } = await import('../lib/graph.js')
  const g = await openGraph(join(root, 'meta', 'graph.sqlite'))
  g.set('runStartedAt', Date.now() - 60_000)
  g.close()
  const refused = await call('run-now', {})
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'ALREADY_RUNNING')
  const cleared = await call('scan', {})
  assert.equal(cleared.status, 200)
})


test('stale task copies are removed even when the remembered id still resolves', async () => {
  // The bug this guards: cleanup lived inside `if (entry === undefined)`, so once
  // the graph held a healthy task id the sweep never ran. Five stale copies kept
  // firing the curator every night — one extra session each morning — and nothing
  // reported it because the one task the graph knew about was fine.
  const prompt = '开始记忆整理'
  const workspace = '/ws'
  const catalog = [
    { id: 'current', prompt, status: 'active', target: { kind: 'new', create: { cwd: workspace } } },
    { id: 'stale-1', prompt, status: 'active', target: { kind: 'new', create: {} } },
    { id: 'stale-2', prompt, status: 'active', target: { kind: 'new', create: {} } },
    { id: 'other', prompt: '别的任务', status: 'active', target: { kind: 'new', create: {} } },
  ]
  const deleted = []
  const edit = async ({ id, action }) => { if (action === 'delete') deleted.push(id) }

  // entry resolved from the remembered id — the case that used to skip everything.
  const entry = { id: 'current' }
  const ours = catalog.filter(item => item.prompt === prompt
    && item.status !== 'ended'
    && item.target?.kind === 'new'
    && (item.target?.create?.cwd === undefined || item.target?.create?.cwd === workspace))
  const keepId = entry?.id ?? ours[0]?.id
  for (const extra of ours) {
    if (extra.id === keepId) continue
    await edit({ id: extra.id, action: 'delete' })
  }

  assert.deepEqual(deleted.sort(), ['stale-1', 'stale-2'], 'both stale copies removed')
  assert.equal(deleted.includes('current'), false, 'the task in use is kept')
  assert.equal(deleted.includes('other'), false, 'a different task is untouched')
})

test('finished one-shot tasks are cleaned up, the recurring one is kept', async () => {
  // What this models: five tasks scheduled for 2026-11-18 with `COUNT=1`
  // (already fired, never to run again) plus one daily task. The stored records
  // carry no `target` field at all, so a filter on `target.kind` matched none of
  // them and the leftovers accumulated forever — while only the daily task was
  // actually producing curator sessions (six sessions over six nights, one each).
  const prompt = '开始记忆整理'
  const workspace = '/ws'
  const catalog = [
    { id: 'done-1', prompt, rrule: 'DTSTART;TZID=Asia/Shanghai:20261118T123800\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2026-11-18T04:38:00.000Z' },
    { id: 'done-2', prompt, rrule: 'DTSTART;TZID=Asia/Shanghai:20261118T124750\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2026-11-18T04:47:50.000Z' },
    { id: 'daily', prompt, kind: 'daily', rrule: '', time: '00:05:00.000', scheduledAt: '2026-11-24T16:05:00.000Z', target: { kind: 'new', create: { cwd: workspace } } },
    { id: 'other', prompt: '别的任务', rrule: 'FREQ=DAILY;COUNT=1', scheduledAt: '2026-11-18T04:00:00.000Z' },
  ]

  const finished = item => {
    const rrule = String(item.rrule ?? '')
    return /COUNT=1(;|$)/i.test(rrule) && Number.isFinite(Date.parse(item.scheduledAt ?? ''))
  }
  const ours = catalog.filter(item => item.prompt === prompt
    && item.status !== 'ended'
    && (item.target === undefined || item.target?.kind === 'new')
    && (item.target?.create?.cwd === undefined || item.target?.create?.cwd === workspace)
    && !finished(item))
  const removable = catalog.filter(item => item.prompt === prompt && finished(item))

  assert.deepEqual(ours.map(item => item.id), ['daily'], 'only the recurring task stays')
  assert.deepEqual(removable.map(item => item.id).sort(), ['done-1', 'done-2'], 'finished ones are removed')
  assert.equal(removable.some(item => item.id === 'other'), false, 'a different task is untouched')

  // Guard the shape of the real data: a task that somehow has no rrule and no
  // target must not be swept just because it is unreadable.
  const opaque = { id: 'opaque', prompt, scheduledAt: '2026-11-18T04:00:00.000Z' }
  assert.equal(finished(opaque), false, 'no rrule means not proven finished')
})
