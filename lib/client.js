/**
 * dsh-memory-knowledge — browser half.
 *
 * A left-sidebar entry ("记忆知识库") that opens a main-area page with:
 * status, actions (run now, rescan, repair task, import), recent changes with
 * diff and undo, and settings saved through the Host's config editor.
 *
 * Every action goes through the same-origin routes under /memory-knowledge,
 * which call the same engine methods the agent tools use.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-knowledge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'dsh-memory-knowledge'
    const ROUTE = '/memory-knowledge'
    const MODULE = { ctx: null }

    /** Localized text: Chinese first, English when the host locale is English. */
    function lang() {
      try {
        const locale = MODULE.ctx && typeof MODULE.ctx.get === 'function' ? MODULE.ctx.get('locale') : null
        const value = String((locale && (locale.current || locale.locale || (locale.get && locale.get()))) || navigator.language || 'zh')
        return value.toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch { return 'zh' }
    }
    const T = {
      zh: {
        title: '记忆知识库', loading: '加载中…', failed: '加载失败', retry: '重试',
        memory: '记忆区', staging: '预备区', archive: '归档', disputed: '有争议', skills: 'Skill', pendingEdits: '待处理的人工修改', imports: '待导入',
        lastRun: '上次整理', never: '还没有整理过', task: '整理任务', taskMissing: '未建立',
        runNow: '立即整理', rescan: '重新扫描文件', repair: '修复整理任务', openFolder: '记忆文件夹',
        importTitle: '导入资料', importHint: '填一个目录或文件的绝对路径（.md/.txt），由下次整理逐块读入，源文件不会被改动。', importBtn: '加入导入队列',
        recent: '最近改动', noRecent: '还没有改动', diff: '看改动', hideDiff: '收起', undo: '撤销', undone: '已撤销',
        settings: '设置', save: '保存', saved: '已保存', time: '每天整理时间', enabled: '启用夜间整理', preset: '整理用的 agent 预设（留空=默认）',
        includeCwd: '只整理这些目录的会话（每行一个，留空=全部）', excludeCwd: '排除这些目录（每行一个）', tag: '快照标签名',
        extra: '给整理员的补充要求', votes: '转正需要的引用票数', expire: '预备区多少天未用就归档',
        recallLimit: '每次查询返回条数', snippet: '片段长度（字）', confirmUndo: '确定撤销这次改动吗？会恢复到改动前的版本。',
        ops: { add: '新增', update: '更新', supersede: '取代', retire: '作废', promote: '转正', expire: '过期归档', resolve: '处理争议', link: '加关系', unlink: '删关系', merge: '合并', dispute: '标争议', confirm: '确认', forget: '遗忘', 'human-add': '人工新增', 'human-edit': '人工修改', 'human-delete': '人工删除', move: '移动', restamp: '补 ID', 'adopt-copy': '复制件', undo: '撤销', skill: '生成 Skill', import: '导入', task: '整理任务' },
        actors: { human: '你', curator: '整理员', agent: '对话', plugin: '插件', command: '命令' },
      },
      en: {
        title: 'Memory knowledge base', loading: 'Loading…', failed: 'Failed to load', retry: 'Retry',
        memory: 'Memory', staging: 'Staging', archive: 'Archive', disputed: 'Disputed', skills: 'Skills', pendingEdits: 'Pending hand edits', imports: 'Queued imports',
        lastRun: 'Last curation', never: 'Never', task: 'Nightly task', taskMissing: 'Not created',
        runNow: 'Curate now', rescan: 'Rescan files', repair: 'Repair task', openFolder: 'Memory folder',
        importTitle: 'Import notes', importHint: 'Absolute path of a folder or file (.md/.txt). The next curation reads it chunk by chunk; the source is never modified.', importBtn: 'Queue import',
        recent: 'Recent changes', noRecent: 'No changes yet', diff: 'Diff', hideDiff: 'Hide', undo: 'Undo', undone: 'Undone',
        settings: 'Settings', save: 'Save', saved: 'Saved', time: 'Daily curation time', enabled: 'Nightly curation', preset: 'Curator agent preset (empty = default)',
        includeCwd: 'Only curate sessions under (one per line, empty = all)', excludeCwd: 'Exclude (one per line)', tag: 'Snapshot tag',
        extra: 'Extra instructions for the curator', votes: 'Citations needed to promote', expire: 'Archive unused staging after (days)',
        recallLimit: 'Results per recall', snippet: 'Snippet length (chars)', confirmUndo: 'Undo this change? The item returns to its previous version.',
        ops: {}, actors: {},
      },
    }
    const t = key => (T[lang()][key] ?? T.zh[key] ?? key)
    const opName = op => (T[lang()].ops[op] ?? T.zh.ops[op] ?? op)
    const actorName = actor => (T[lang()].actors[actor] ?? T.zh.actors[actor] ?? actor)

    async function api(action, body) {
      const init = body === undefined
        ? { method: 'GET', credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(`${ROUTE}/${action}`, init)
      let data
      try { data = await response.json() } catch { data = { ok: false, message: `HTTP ${response.status}` } }
      if (!response.ok && data.ok !== false) data.ok = false
      return data
    }

    const css = `
.dmk-page{height:100%;overflow:auto;padding:24px 28px;box-sizing:border-box;color:var(--color-text-primary,inherit);font-size:13px}
.dmk-page h1{font-size:18px;font-weight:600;margin:0 0 16px}
.dmk-page h2{font-size:14px;font-weight:600;margin:24px 0 10px}
.dmk-cards{display:flex;flex-wrap:wrap;gap:10px}
.dmk-card{min-width:96px;padding:10px 12px;border:1px solid var(--color-border-default,rgba(127,127,127,.25));border-radius:8px}
.dmk-card b{display:block;font-size:18px;font-weight:600}
.dmk-card span{opacity:.7;font-size:12px}
.dmk-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.dmk-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--color-border-default,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font-size:12px}
.dmk-btn:hover{background:var(--color-bg-hover,rgba(127,127,127,.12))}
.dmk-btn:disabled{opacity:.5;cursor:default}
.dmk-muted{opacity:.65;font-size:12px}
.dmk-msg{margin:6px 0;font-size:12px}
.dmk-list{border-top:1px solid var(--color-border-default,rgba(127,127,127,.2))}
.dmk-item{padding:8px 0;border-bottom:1px solid var(--color-border-default,rgba(127,127,127,.15))}
.dmk-item a{color:inherit}
.dmk-pre{white-space:pre-wrap;font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;background:var(--color-bg-subtle,rgba(127,127,127,.08));padding:8px;border-radius:6px;margin-top:6px}
.dmk-field{display:flex;flex-direction:column;gap:4px;margin:10px 0;max-width:560px}
.dmk-field input,.dmk-field textarea{padding:6px 8px;border-radius:6px;border:1px solid var(--color-border-default,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit}
.dmk-field textarea{min-height:60px}
.dmk-check{display:flex;gap:6px;align-items:center;margin:10px 0}
.dmk-panel-icon{opacity:.85}
.dmk-panel-icon.active{opacity:1}
`

    function Icon({ size, active }) {
      const s = size || 18
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', className: active ? 'dmk-panel-icon active' : 'dmk-panel-icon', 'aria-hidden': true },
        h('path', { d: 'M4 5.5C4 4.67 4.67 4 5.5 4H11v16H5.5C4.67 20 4 19.33 4 18.5v-13Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M20 5.5C20 4.67 19.33 4 18.5 4H13v16h5.5c.83 0 1.5-.67 1.5-1.5v-13Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('circle', { cx: 16.5, cy: 13.5, r: 1.3, fill: 'currentColor' }),
        h('circle', { cx: 15.2, cy: 9.6, r: 1, fill: 'currentColor' }),
        h('path', { d: 'M16.5 13.5l-1.3-3.9M16.5 13.5l1.8 1.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    function formatTime(ms) {
      if (!ms) return ''
      try { return new Date(ms).toLocaleString() } catch { return String(ms) }
    }

    function Recent({ items, reload }) {
      const [open, setOpen] = useState({})
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const toggle = async (change) => {
        if (open[change] !== undefined) { setOpen(o => { const n = { ...o }; delete n[change]; return n }); return }
        const data = await api('diff', { change })
        setOpen(o => ({ ...o, [change]: data.text || '（无可显示的差异）' }))
      }
      const undo = async (change) => {
        if (!window.confirm(t('confirmUndo'))) return
        setBusy(change)
        const data = await api('undo', { change })
        setBusy('')
        setNote(data.ok ? t('undone') : (data.message || data.detail || 'error'))
        reload()
      }
      if (!items || items.length === 0) return h('div', { className: 'dmk-muted' }, t('noRecent'))
      return h('div', null,
        note ? h('div', { className: 'dmk-msg' }, note) : null,
        h('div', { className: 'dmk-list' }, items.map(item => h('div', { className: 'dmk-item', key: item.change },
          h('div', { className: 'dmk-row' },
            h('span', null, `${opName(item.op)} · ${actorName(item.actor)}`),
            item.path ? h('a', { href: '#', onClick: e => { e.preventDefault(); openFile(item.path) } }, item.title || item.path.split('/').pop()) : h('span', null, item.title || ''),
            h('span', { className: 'dmk-muted' }, formatTime(item.at)),
            item.item && item.op !== 'undo' && item.op !== 'task' ? h('button', { className: 'dmk-btn', onClick: () => toggle(item.change) }, open[item.change] !== undefined ? t('hideDiff') : t('diff')) : null,
            item.item && !['undo', 'task', 'restamp', 'import'].includes(item.op) ? h('button', { className: 'dmk-btn', disabled: busy === item.change, onClick: () => undo(item.change) }, t('undo')) : null),
          open[item.change] !== undefined ? h('div', { className: 'dmk-pre' }, open[item.change]) : null))))
    }

    function openFile(path) {
      // The conversation renders file links; here a plain file URL opens the
      // system viewer when the desktop shell allows it, otherwise copies the path.
      try {
        navigator.clipboard && navigator.clipboard.writeText(path)
      } catch { /* clipboard unavailable */ }
      window.alert(path)
    }

    function Settings({ config, raw, reload }) {
      const initial = () => ({
        enabled: config.curator.enabled,
        time: config.curator.time,
        agentPreset: config.curator.agentPreset,
        extra: config.curator.extraInstructions,
        includeCwd: (config.capture.includeCwd || []).join('\n'),
        excludeCwd: (config.capture.excludeCwd || []).join('\n'),
        tag: config.injectTag,
        votes: String(config.pools.promoteVotes),
        expire: String(config.pools.stagingExpireDays),
        limit: String(config.recall.limit),
        snippet: String(config.recall.snippetChars),
      })
      const [form, setForm] = useState(initial)
      const [note, setNote] = useState('')
      const set = key => e => { const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setForm(f => ({ ...f, [key]: value })) }
      const lines = text => String(text || '').split('\n').map(s => s.trim()).filter(Boolean)
      const num = (text, fallback) => { const n = Number(text); return Number.isFinite(n) && n >= 0 ? n : fallback }
      const save = async () => {
        const patch = {
          injectTag: form.tag,
          curator: { enabled: !!form.enabled, time: form.time, agentPreset: form.agentPreset, extraInstructions: form.extra },
          capture: { includeCwd: lines(form.includeCwd), excludeCwd: lines(form.excludeCwd) },
          pools: { promoteVotes: num(form.votes, 2), stagingExpireDays: num(form.expire, 60) },
          recall: { limit: num(form.limit, 5), snippetChars: num(form.snippet, 400) },
        }
        const data = await api('config', { patch })
        setNote(data.ok ? t('saved') : (data.message || 'error'))
        if (data.ok) setTimeout(reload, 1500)
      }
      const field = (key, label, multiline) => h('label', { className: 'dmk-field' },
        h('span', null, label),
        multiline ? h('textarea', { value: form[key], onChange: set(key) }) : h('input', { value: form[key], onChange: set(key) }))
      return h('div', null,
        h('label', { className: 'dmk-check' }, h('input', { type: 'checkbox', checked: !!form.enabled, onChange: set('enabled') }), t('enabled')),
        field('time', t('time')),
        field('agentPreset', t('preset')),
        field('includeCwd', t('includeCwd'), true),
        field('excludeCwd', t('excludeCwd'), true),
        field('votes', t('votes')),
        field('expire', t('expire')),
        field('limit', t('recallLimit')),
        field('snippet', t('snippet')),
        field('tag', t('tag')),
        field('extra', t('extra'), true),
        h('div', { className: 'dmk-row' }, h('button', { className: 'dmk-btn', onClick: save }, t('save')), note ? h('span', { className: 'dmk-msg' }, note) : null))
    }

    function Page() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const [importPath, setImportPath] = useState('')
      const reload = useCallback(async () => {
        try {
          const result = await api('status')
          if (result.ok === false) { setError(result.message || t('failed')); return }
          setError('')
          setData(result)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        }
      }, [])
      useEffect(() => { reload(); const timer = setInterval(reload, 15000); return () => clearInterval(timer) }, [reload])
      const act = async (action, body) => {
        setBusy(action)
        const result = await api(action, body || {})
        setBusy('')
        const summary = result.summary ? Object.entries(result.summary).filter(([, v]) => v.length > 0).map(([k, v]) => `${k} ${v.length}`).join('，') : ''
        setNote(result.ok === false ? (result.message || result.detail || 'error') : (summary || result.status || (result.queued !== undefined ? `queued ${result.queued}` : 'OK')))
        reload()
      }
      if (error) return h('div', { className: 'dmk-page' }, h('h1', null, t('title')), h('div', { className: 'dmk-msg' }, `${t('failed')}：${error}`), h('button', { className: 'dmk-btn', onClick: reload }, t('retry')))
      if (!data) return h('div', { className: 'dmk-page' }, h('h1', null, t('title')), h('div', { className: 'dmk-muted' }, t('loading')))
      const c = data.counts || {}
      const card = (value, label) => h('div', { className: 'dmk-card' }, h('b', null, String(value ?? 0)), h('span', null, label))
      return h('div', { className: 'dmk-page' },
        h('h1', null, t('title')),
        h('div', { className: 'dmk-cards' },
          card(c.memory, t('memory')), card(c.staging, t('staging')), card(c.archive, t('archive')), card(c.disputed, t('disputed')),
          card(data.skills, t('skills')), card(Math.max(0, data.pendingHumanEdits || 0), t('pendingEdits')), card(data.imports, t('imports'))),
        h('div', { className: 'dmk-row dmk-muted' },
          `${t('lastRun')}：${data.lastRun ? formatTime(data.lastRun.at) : t('never')}`,
          ' · ',
          `${t('task')}：${data.task ? data.task.id : t('taskMissing')}`,
          ' · ',
          `${t('openFolder')}：${data.library}`),
        h('div', { className: 'dmk-row' },
          h('button', { className: 'dmk-btn', disabled: !!busy, onClick: () => act('run-now') }, t('runNow')),
          h('button', { className: 'dmk-btn', disabled: !!busy, onClick: () => act('scan') }, t('rescan')),
          h('button', { className: 'dmk-btn', disabled: !!busy, onClick: () => act('repair-task') }, t('repair'))),
        note ? h('div', { className: 'dmk-msg' }, note) : null,
        h('h2', null, t('importTitle')),
        h('div', { className: 'dmk-muted' }, t('importHint')),
        h('div', { className: 'dmk-row' },
          h('input', { style: { flex: 1, minWidth: 260, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' }, value: importPath, onChange: e => setImportPath(e.target.value), placeholder: '/Users/…/doc' }),
          h('button', { className: 'dmk-btn', disabled: !!busy || !importPath.trim(), onClick: () => act('import', { path: importPath.trim() }) }, t('importBtn'))),
        h('h2', null, t('recent')),
        h(Recent, { items: data.recent, reload }),
        h('h2', null, t('settings')),
        h(Settings, { config: data.config, raw: data.raw, reload }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        MODULE.ctx = ctx
        const style = document.createElement('style')
        style.setAttribute('data-dmk', '1')
        style.textContent = css
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove())
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, label: t('title') }, Page))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: t('title') }, Icon))
      },
    }
  },
})
