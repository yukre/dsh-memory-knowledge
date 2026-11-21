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
        presetHint: '留空 = 用 DSH 的默认预设，这台安装实际跑出来是 standard。整理任务每次都用这个预设新开一个会话；想省钱可以填一个便宜的模型预设。',
        tag: '快照标签名',
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
        presetHint: 'Empty = the DSH default preset (standard on this install). The nightly task opens a new session with it; a cheaper preset saves money.',
        tag: 'Snapshot tag',
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
.dmk-page{height:100%;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);font-size:14px}
.dmk-col{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.dmk-page h1{font-size:20px;line-height:28px;font-weight:500;margin:0 0 4px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dmk-page h2{font-size:16px;font-weight:600;margin:28px 0 10px}
.dmk-sub{color:var(--dsw-alias-label-secondary,inherit);font-size:13px;margin:0 0 12px}
.dmk-cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.dmk-card{min-width:104px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-card-fill,transparent)}
.dmk-card b{display:block;font-size:20px;font-weight:600}
.dmk-card span{color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.dmk-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.dmk-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;font-size:13px}
/* The generic hover fill would repaint a primary button grey, so the primary
   variant owns its hover and disabled colours.
   The label colour must be label-primary-foreground, NOT label-on-color: the
   fill inverts with the theme (near-black in light, near-white in dark) while
   label-on-color is always white, so the dark theme rendered a white block with
   invisible white text. label-primary-foreground is the token the host's own
   primary buttons pair with that fill, and it inverts too. */
.dmk-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dmk-btn:disabled{opacity:.5;cursor:default}
.dmk-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#3b6fd8);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dmk-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#2f5fbe);border-color:transparent}
/* Disabled keeps the normal fill and only fades it. Swapping in
   button-primary-dimmed looked reasonable but that token is a LIGHT surface in
   the light theme (bluish-100) while the paired label is white — 1.16:1, i.e.
   '整理中…' was invisible. Fading the proven combination instead guarantees the
   label and fill still invert together. */
.dmk-btn-primary:disabled{background:var(--dsw-alias-button-primary-fill,#3b6fd8);color:var(--dsw-alias-label-primary-foreground,#fff);opacity:.55;cursor:default}
.dmk-msg{margin:6px 0;font-size:13px}
.dmk-msg.ok{color:var(--dsw-alias-state-success-primary,inherit)}
.dmk-msg.err{color:var(--dsw-alias-state-error-primary,inherit)}
.dmk-list{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dmk-item{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.15))}
.dmk-item a{color:var(--dsw-alias-link,inherit)}
.dmk-pre{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));padding:8px;border-radius:6px;margin-top:6px}
.dmk-del{background:var(--dsw-alias-file-diff-deleted-bg,rgba(255,0,0,.12));text-decoration:line-through;border-radius:2px}
.dmk-ins{background:var(--dsw-alias-file-diff-added-bg,rgba(0,255,0,.15));border-radius:2px}
.dmk-field{display:flex;flex-direction:column;gap:4px;margin:10px 0;max-width:560px}
.dmk-field input,.dmk-field textarea{padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-card-fill,transparent);color:inherit;font:inherit}
.dmk-field textarea{min-height:60px}
.dmk-check{display:flex;gap:6px;align-items:center;margin:10px 0}
.dmk-hint{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.5));color:var(--dsw-alias-label-secondary,inherit);font-size:10px;line-height:1;cursor:help;margin-left:5px;flex:none}
.dmk-hint:hover{border-color:var(--dsw-alias-label-primary,inherit);color:var(--dsw-alias-label-primary,inherit)}
.dmk-label-row{display:flex;align-items:center}
.dmk-scope{margin:14px 0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-card-fill,transparent)}
.dmk-scope-title{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:4px}
.dmk-scope-desc{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;margin-bottom:8px}
.dmk-scope textarea{margin-top:6px}
.dmk-health{padding:10px 14px;border-radius:8px;margin:10px 0;background:var(--dsw-alias-card-fill,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dmk-health.ok{border-color:var(--dsw-alias-state-success-primary,transparent)}
.dmk-health.warn{border-color:var(--dsw-alias-state-warn-primary,orange)}
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
      try {
        const diff = Date.now() - ms
        if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
        if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
        return new Date(ms).toLocaleString()
      } catch { return String(ms) }
    }

    /** Render `[-old-]{+new+}` marks as colored del/ins. */
    function DiffText({ text }) {
      const parts = []
      const re = /\[-([\s\S]*?)-\]|\{\+([\s\S]*?)\+\}/g
      let last = 0
      let m
      let i = 0
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push(text.slice(last, m.index))
        if (m[1] !== undefined) parts.push(h('del', { key: `d${i++}`, className: 'dmk-del' }, m[1]))
        else parts.push(h('ins', { key: `i${i++}`, className: 'dmk-ins' }, m[2]))
        last = re.lastIndex
      }
      if (last < text.length) parts.push(text.slice(last))
      return h('pre', { className: 'dmk-pre' }, parts)
    }

    function Recent({ items, reload }) {
      const [open, setOpen] = useState({})
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [confirming, setConfirming] = useState('')
      const toggle = async (change) => {
        if (open[change] !== undefined) { setOpen(o => { const n = { ...o }; delete n[change]; return n }); return }
        const data = await api('diff', { change })
        setOpen(o => ({ ...o, [change]: data.text || '（这次改动没有可显示的差异）' }))
      }
      const undo = async (change) => {
        setBusy(change)
        setConfirming('')
        const data = await api('undo', { change })
        setBusy('')
        setNote(data.ok ? (data.detail ? `已撤销：${data.detail}` : '已撤销') : (data.message || data.detail || '撤销失败'))
        reload()
      }
      if (!items || items.length === 0) return h('div', { className: 'dmk-sub' }, t('noRecent'))
      return h('div', null,
        note ? h('div', { className: `dmk-msg ${note.startsWith('已撤销') ? 'ok' : 'err'}` }, note) : null,
        h('div', { className: 'dmk-list' }, items.map(item => h('div', { className: 'dmk-item', key: item.change },
          h('div', { className: 'dmk-row' },
            h('span', null, `${opName(item.op)} · ${actorName(item.actor)}`),
            item.title ? h('span', { title: item.path }, item.title) : null,
            h('span', { className: 'dmk-sub', title: new Date(item.at).toLocaleString() }, formatTime(item.at)),
            item.canDiff ? h('button', { className: 'dmk-btn', onClick: () => toggle(item.change) }, open[item.change] !== undefined ? t('hideDiff') : t('diff')) : null,
            item.canUndo
              ? (confirming === item.change
                ? h('span', null,
                  h('button', { className: 'dmk-btn', onClick: () => undo(item.change) }, `确认撤销${item.op === 'add' ? '（会删除这条记忆）' : ''}`),
                  ' ', h('button', { className: 'dmk-btn', onClick: () => setConfirming('') }, '取消'))
                : h('button', { className: 'dmk-btn', disabled: busy === item.change, onClick: () => setConfirming(item.change) }, t('undo')))
              : null),
          open[item.change] !== undefined
            ? (/^[-+~ ]/m.test(open[item.change]) || open[item.change].includes('[-')
              ? h(DiffText, { text: open[item.change] })
              : h('pre', { className: 'dmk-pre' }, open[item.change]))
            : null))))
    }

    function Settings({ data, reload }) {
      const [form, setForm] = useState(() => ({
        enabled: data.config.curator.enabled,
        time: data.config.curator.time,
        agentPreset: data.config.curator.agentPreset,
        extra: data.config.curator.extraInstructions,
        // One list: a plain line includes, a `!`-prefixed line excludes.
        scopeRestricted: (data.config.capture.includeCwd || []).length > 0,
        scopePaths: [
          ...(data.config.capture.includeCwd || []),
          ...(data.config.capture.excludeCwd || []).map(path => `!${path}`),
        ].join('\n'),
      }))
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const set = key => e => { const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setForm(f => ({ ...f, [key]: value })) }
      const lines = text => String(text || '').split('\n').map(s => s.trim()).filter(Boolean)
      const save = async () => {
        setBusy(true)
        const listed = lines(form.scopePaths)
        const included = form.scopeRestricted ? listed.filter(line => !line.startsWith('!')) : []
        const excluded = listed.filter(line => line.startsWith('!')).map(line => line.slice(1).trim()).filter(Boolean)
        const data2 = await api('config', { patch: { curator: { enabled: !!form.enabled, time: form.time, agentPreset: form.agentPreset, extraInstructions: form.extra }, capture: { includeCwd: included, excludeCwd: excluded } } })
        setBusy(false)
        setNote(data2.ok ? '已保存，插件已按新设置重新加载' : (data2.message || '保存失败'))
        if (data2.ok) setTimeout(reload, 1500)
      }
      /**
       * The scope block: one switch decides whether the plugin applies to every
       * session or only to the folders listed. Exclusions live in the same list
       * as `!`-prefixed lines instead of a second textarea, so the two settings
       * that express one idea are read and edited in one place.
       */
      const scopeBlock = () => {
        const restricted = !!form.scopeRestricted
        return h('div', { className: 'dmk-scope' },
          h('div', { className: 'dmk-scope-title' },
            h('input', { type: 'checkbox', checked: restricted, onChange: e => setForm(f => ({ ...f, scopeRestricted: e.target.checked })) }),
            '只对指定目录生效',
            h('span', { className: 'dmk-hint', title: '关闭 = 对所有会话注入记忆并提供工具（默认）。开启 = 只有下面列出的目录里的会话生效。' }, '?')),
          h('div', { className: 'dmk-scope-desc' },
            restricted
              ? '每行一个目录，只对列出的目录生效。以 ! 开头的行表示排除（如 !/Users/me/tmp）。'
              : '当前对所有会话生效。开启上面的开关可限定目录。'),
          restricted
            ? h('textarea', {
              value: form.scopePaths,
              placeholder: '/Users/me/WorkBuddy\n/Users/me/project-a\n!/Users/me/tmp',
              onChange: set('scopePaths'),
            })
            : null)
      }

      // `hint` renders a ⓘ whose tooltip explains the default, so the field can
      // stay empty without the person having to guess what empty means.
      const field = (key, label, multiline, type, hint) => h('label', { className: 'dmk-field' },
        h('span', { className: 'dmk-label-row' }, label, hint ? h('span', { className: 'dmk-hint', title: hint }, '?') : null),
        multiline ? h('textarea', { value: form[key], onChange: set(key) }) : h('input', { type: type || 'text', value: form[key], onChange: set(key) }))
      return h('div', null,
        h('label', { className: 'dmk-check' }, h('input', { type: 'checkbox', checked: !!form.enabled, onChange: set('enabled') }), t('enabled')),
        field('time', t('time'), false, 'time'),
        field('agentPreset', t('preset'), false, 'text', t('presetHint')),
        scopeBlock(),
        field('extra', t('extra'), true),
        h('div', { className: 'dmk-row' }, h('button', { className: 'dmk-btn', disabled: busy, onClick: save }, busy ? '保存中…' : t('save')), note ? h('span', { className: `dmk-msg ${note.startsWith('已保存') ? 'ok' : 'err'}` }, note) : null))
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
      useEffect(() => {
        reload()
        const timer = setInterval(() => { if (!document.hidden) reload() }, 15000)
        return () => clearInterval(timer)
      }, [reload])
      useEffect(() => {
        if (!note || note.startsWith('已')) return
        const timer = setTimeout(() => setNote(''), 6000)
        return () => clearTimeout(timer)
      }, [note])
      const act = async (action, body) => {
        setBusy(action)
        const result = await api(action, body || {})
        setBusy('')
        if (result.ok === false) setNote(result.message || result.detail || '操作失败')
        else if (action === 'run-now') setNote('已开始整理，进度在左侧「记忆整理」工作区')
        else if (action === 'scan') {
          const sm = result.summary || {}
          const parts = Object.entries(sm).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([k, v]) => `${{ added: '新增', edited: '修改', moved: '移动', deleted: '删除', restamped: '补ID', copies: '复制', merged: '合并' }[k] || k} ${v.length}`)
          setNote(parts.length > 0 ? parts.join('，') : '文件没有变化')
        } else if (action === 'import') setNote(`已加入 ${result.queued} 个文件${result.unchanged ? `，${result.unchanged} 个没变化已跳过` : ''}`)
        else if (action === 'repair-task') setNote({ created: '整理任务已创建', recreated: '整理任务已重建', repaired: '整理任务已修复', ok: '整理任务正常，不用修', 'time-updated': '整理时间已更新', disabled: '夜间整理已关闭', 'schedule-service-missing': '定时任务服务不可用' }[result.status] || result.status || '完成')
        else setNote('完成')
        reload()
      }
      if (!data && error) return h('div', { className: 'dmk-page' }, h('div', { className: 'dmk-col' }, h('h1', null, t('title')), h('div', { className: 'dmk-msg err' }, `${t('failed')}：${error}`), h('button', { className: 'dmk-btn', onClick: reload }, t('retry'))))
      if (!data) return h('div', { className: 'dmk-page' }, h('div', { className: 'dmk-col' }, h('h1', null, t('title')), h('div', { className: 'dmk-sub' }, t('loading'))))
      const c = data.counts || {}
      const task = data.taskInfo
      const running = data.running
      const card = (value, label) => h('div', { className: 'dmk-card' }, h('b', null, String(value ?? 0)), h('span', null, label))
      const health = task === null
        ? { cls: 'warn', text: '⚠️ 整理任务不见了，点「修复整理任务」重建' }
        : !task.active
          ? { cls: 'warn', text: '⚠️ 夜间整理已暂停' }
          : { cls: 'ok', text: `✅ 每天 ${String(task.time ?? '').slice(0, 5)} 自动整理${data.lastRun ? ` · 上次 ${formatTime(data.lastRun.at)}${data.lastRun.writes ? `，写入 ${data.lastRun.writes} 条` : ''}` : ' · 还没跑过'}` }
      return h('div', { className: 'dmk-page' },
        h('div', { className: 'dmk-col' },
          h('h1', { 'data-window-drag': true }, t('title')),
          h('p', { className: 'dmk-sub' }, '每晚由整理员（后台 AI 会话）把对话里想明白的结论整理成记忆，平时不用管。'),
          error && data ? h('div', { className: 'dmk-msg err' }, `刷新失败：${error}（显示的是上次的结果）`) : null,
          h('div', { className: `dmk-health ${health.cls}` }, health.text),
          h('div', { className: 'dmk-cards' },
            card(c.memory, '记忆'), card(c.staging, '待验证'), card(c.archive, '已作废'), card(c.disputed, '有争议'), card(data.skills, 'Skill'), card(data.pendingHumanEdits, '你改过、等确认'), card(data.imports, '排队导入')),
          h('p', { className: 'dmk-sub' }, `待验证的条目被别的对话引用 ${data.config?.pools?.promoteVotes ?? 2} 次且没人反对就转正；${data.config?.pools?.stagingExpireDays ?? 60} 天没人用就归档。`),
          h('div', { className: 'dmk-row' },
            h('button', { className: 'dmk-btn dmk-btn-primary', disabled: !!busy || running, onClick: () => act('run-now'), title: running ? '整理正在进行，进度见左侧「记忆整理」工作区' : undefined }, running ? '整理中…' : t('runNow')),
            h('span', { className: 'dmk-sub' }, `会开一个后台整理会话，最多读 ${data.config?.curator?.maxSessionsPerRun ?? 30} 个会话 / ${Math.round((data.config?.curator?.maxCharsPerRun ?? 120000) / 10000)} 万字`),
            h('button', { className: 'dmk-btn', disabled: !!busy, onClick: () => act('scan') }, t('rescan')),
            h('button', { className: 'dmk-btn', disabled: !!busy, onClick: () => act('repair-task') }, t('repair'))),
          note ? h('div', { className: `dmk-msg ${note.startsWith('已') || note.includes('正常') || note.includes('没有变化') ? 'ok' : 'err'}` }, note) : null,
          h('h2', null, t('importTitle')),
          h('div', { className: 'dmk-sub' }, t('importHint')),
          h('div', { className: 'dmk-row' },
            h('input', { style: { flex: 1, minWidth: 260, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))', background: 'transparent', color: 'inherit' }, value: importPath, onChange: e => setImportPath(e.target.value), placeholder: '/Users/…/doc 或 ~/doc' }),
            h('button', { className: 'dmk-btn', disabled: !!busy || !importPath.trim(), onClick: () => act('import', { path: importPath.trim() }) }, t('importBtn'))),
          h('h2', null, t('recent')),
          h(Recent, { items: data.recent, reload }),
          h('h2', null, t('settings')),
          h(Settings, { data, reload })))
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
