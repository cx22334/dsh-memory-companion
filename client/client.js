/**
 * DSH Web 客户端的「记忆」页：侧栏入口 + 右侧多分页管理设置页。
 * 格式是 DSH 客户端模块系统要求的 lazy-CJS（window.__ModuleLoader__.load），
 * 只用 DSH 运行时共享的 react 与 dsh-client-ui-primitives，不需要构建。
 * 页面通过 ctx.connection.rpc 调用宿主半侧 src/settings-host.mjs 的 /memory-companion 通道。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-companion',
  factory(require) {
    const React = require('react')
    const { Button, SegmentedTabs, Input, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'memory-companion'
    const NS = 'memoryCompanion'
    const CHANNEL = '/memory-companion'

    // ---------- 样式 ----------
    const S = {
      page: { height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '40px 48px 64px', color: 'var(--dsw-alias-label-primary)' },
      inner: { maxWidth: 760, margin: '0 auto' },
      title: { fontSize: 28, fontWeight: 600, margin: '0 0 6px' },
      subtitle: { color: 'var(--dsw-alias-label-secondary)', margin: '0 0 24px' },
      section: { margin: '28px 0 10px', fontSize: 15, fontWeight: 600 },
      card: { border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.25))', borderRadius: 'var(--dsw-radius-lg, 12px)', padding: '16px 18px', margin: '10px 0', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      row: { display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0' },
      label: { width: 150, flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
      grow: { flex: 1, minWidth: 0 },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: '4px 0 0' },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 13, wordBreak: 'break-all' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      err: { color: 'var(--dsw-alias-state-error-primary)' },
      bar: { position: 'sticky', bottom: 0, display: 'flex', gap: 12, alignItems: 'center', padding: '14px 0', marginTop: 24, background: 'var(--dsw-alias-bg-layer-0, var(--dsw-alias-bg-layer-1))' },
      select: { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.35))', borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '6px 8px' },
    }

    const clone = value => JSON.parse(JSON.stringify(value ?? {}))
    const get = (obj, path, fallback) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) ?? fallback
    function set(obj, path, value) {
      const next = clone(obj), keys = path.split('.')
      let o = next
      for (const k of keys.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {})
      o[keys[keys.length - 1]] = value
      return next
    }

    // ---------- 通用表单件 ----------
    function Field({ label, hint, children }) {
      return h('div', null,
        h('div', { style: S.row }, h('span', { style: S.label }, label), h('div', { style: S.grow }, children)),
        hint ? h('p', { style: { ...S.hint, marginLeft: 162 } }, hint) : null)
    }
    function Text({ value, onChange, placeholder, type }) {
      return h(Input, { value: value ?? '', placeholder, type: type || 'text', onChange: e => onChange(e.target.value) })
    }
    function NumberBox({ value, onChange, min, max }) {
      return h(Input, { type: 'number', value: value ?? '', min, max,
        onChange: e => onChange(e.target.value === '' ? undefined : Number(e.target.value)) })
    }
    function Select({ value, onChange, options }) {
      return h('select', { style: S.select, value: value ?? '', onChange: e => onChange(e.target.value) },
        options.map(([v, text]) => h('option', { key: v, value: v }, text)))
    }

    // ---------- 分页：概览 ----------
    function Overview({ data, call, reload }) {
      const rt = data.runtime || {}
      const [link, setLink] = useState(null)
      const statusText = { running: ['运行中', S.ok], starting: ['启动中', S.warn], failed: ['未能启动', S.err], stopped: ['已停止', S.warn], not_started: ['未启动', S.warn] }[rt.status] || [rt.status, null]
      const missing = (data.keys || []).filter(k => !k.configured)
      const openManagement = async () => {
        const r = await call('managementLink', {})
        if (r.ok) window.open(r.value.url, '_blank', 'noopener')
        else setLink(r.error.message)
      }
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.row }, h('span', { style: S.label }, '记忆服务'), h('b', { style: statusText[1] }, statusText[0]),
            h(Button, { variant: 'ghost', size: 'sm', onClick: reload }, '刷新')),
          rt.error ? h('p', { style: { ...S.hint, ...S.err } }, `${rt.error.code}：${rt.error.message}`) : null,
          missing.length ? h('p', { style: { ...S.hint, ...S.warn } }, `还缺密钥：${missing.map(k => k.label).join('、')}。到「模型与密钥」页填写。`) : null,
          data.invalid ? h('p', { style: { ...S.hint, ...S.err } }, `配置有误：${data.invalid}`) : null),
        h('div', { style: S.card },
          h(Field, { label: '配置文件' }, h('span', { style: S.mono }, data.configPath)),
          h(Field, { label: '记忆库位置' }, h('span', { style: S.mono }, data.effective?.vaultPath || '—')),
          h(Field, { label: '检索引擎' }, get(data.config, 'recall.engine', 'tagmemo') === 'baseline' ? '基础检索（TDB）' : '浪潮 TagMemo')),
        h('div', { style: S.section }, '日记管理'),
        h('div', { style: S.card },
          h('p', { style: { margin: 0 } }, '浏览和修改日记、审批更正、查看每次回答用到了哪些记忆。'),
          h('div', { style: S.row }, h(Button, { variant: 'primary', onClick: openManagement, disabled: rt.status !== 'running' }, '打开日记管理'),
            link ? h('span', { style: S.warn }, link) : null)),
        rt.health ? h('div', null, h('div', { style: S.section }, '详细状态'), h('div', { style: S.card }, h('pre', { style: { ...S.mono, margin: 0, whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' } }, JSON.stringify(rt.health, null, 2)))) : null)
    }

    // ---------- 分页：角色 ----------
    function Roles({ draft, setDraft }) {
      const roles = Array.isArray(draft.roles) ? draft.roles : []
      const update = (i, key, value) => setDraft(set(draft, 'roles', roles.map((r, j) => j === i ? { ...r, [key]: value } : r)))
      const remove = i => setDraft(set(draft, 'roles', roles.filter((_, j) => j !== i)))
      const add = () => {
        let n = roles.length + 1, alias = `role${n}`
        while (roles.some(r => r.alias === alias || r.id === alias)) alias = `role${++n}`
        setDraft(set(draft, 'roles', [...roles, { id: alias, alias, name: `角色${n}`, directory: `角色${n}` }]))
      }
      const copy = text => navigator.clipboard?.writeText(text)
      return h('div', null,
        h('p', { style: S.subtitle }, '每个角色有自己的日记。在该角色的人设开头写上它的身份声明，记忆就会按角色分开。'),
        roles.map((role, i) => {
          const alias = role.alias || role.id || ''
          const valid = /^[a-z][a-z0-9_]*$/.test(alias)
          return h('div', { key: i, style: S.card },
            h(Field, { label: '名字' }, h(Text, { value: role.name, onChange: v => update(i, 'name', v) })),
            h(Field, { label: '变量名', hint: valid ? null : '只能用小写英文字母开头，后面跟小写字母、数字或下划线。' },
              h(Text, { value: alias, onChange: v => setDraft(set(draft, 'roles', roles.map((r, j) => j === i ? { ...r, alias: v, id: r.id && r.id !== r.alias ? r.id : v } : r))) })),
            h(Field, { label: '日记文件夹' }, h(Text, { value: role.directory, onChange: v => update(i, 'directory', v) })),
            h(Field, { label: '写进人设' },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('code', { style: S.mono }, `{{mem_self_${alias}}}`),
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => copy(`{{mem_self_${alias}}}\n{{mem_public}}`) }, '复制'),
                h('span', { style: S.hint }, '第二行 {{mem_public}} 让它能读公共记录'))),
            h('div', { style: S.row }, h(Button, { variant: 'outline', size: 'sm', onClick: () => remove(i), disabled: roles.length <= 1 }, '删除这个角色')))
        }),
        h(Button, { variant: 'outline', onClick: add }, '添加角色'),
        h('p', { style: S.hint }, '删除角色不会删除它已有的日记文件；改变量名后，人设里的声明也要跟着改。'))
    }

    // ---------- 分页：模型与密钥 ----------
    function KeyRow({ item, call, onKeys }) {
      const [value, setValue] = useState(''), [msg, setMsg] = useState(null)
      const save = async () => {
        const r = await call('setKey', { ref: item.ref, value })
        if (r.ok) { setValue(''); setMsg(['已保存', S.ok]); onKeys(r.value.keys) } else setMsg([r.error.message, S.err])
      }
      const clear = async () => {
        const r = await call('clearKey', { ref: item.ref })
        if (r.ok) { setMsg(['已清除', S.ok]); onKeys(r.value.keys) } else setMsg([r.error.message, S.err])
      }
      const source = { file: 'DSH 已保存', env: '环境变量', 'project-env': '项目 .env', 'user-env': 'DSH .env' }[item.source] || item.source
      return h('div', { style: S.card },
        h('div', { style: S.row }, h('b', null, item.label),
          h('span', { style: item.configured ? S.ok : S.warn }, item.configured ? `已配置（${source}）` : '未配置'),
          h('span', { style: { ...S.mono, color: 'var(--dsw-alias-label-tertiary)' } }, item.ref)),
        h('div', { style: S.row },
          h('div', { style: S.grow }, h(Text, { type: 'password', value, placeholder: item.configured ? '输入新密钥以替换' : '粘贴 API 密钥', onChange: setValue })),
          h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: !value.trim() }, '保存密钥'),
          item.source === 'file' ? h(Button, { variant: 'ghost', size: 'sm', onClick: clear }, '清除') : null),
        msg ? h('p', { style: { ...S.hint, ...msg[1] } }, msg[0]) : null)
    }
    function Models({ data, draft, setDraft, call, onKeys }) {
      const f = (path, fallback) => get(draft, path, fallback)
      const put = path => value => setDraft(set(draft, path, value))
      return h('div', null,
        h('div', { style: S.section }, '嵌入模型（把日记变成向量）'),
        h('div', { style: S.card },
          h(Field, { label: '接口类型' }, h(Select, { value: f('google.protocol', 'google'), onChange: put('google.protocol'), options: [['google', 'Google Gemini'], ['openai-compatible', 'OpenAI 兼容']] })),
          h(Field, { label: '模型' }, h(Text, { value: f('google.model', 'gemini-embedding-001'), onChange: put('google.model') })),
          h(Field, { label: '维度', hint: '改模型或维度后，所有日记会重新向量化一次。' }, h(NumberBox, { value: f('google.dimensions', 768), onChange: put('google.dimensions'), min: 1 })),
          h(Field, { label: '接口地址' }, h(Text, { value: f('google.endpoint', 'https://generativelanguage.googleapis.com/v1beta'), onChange: put('google.endpoint') })),
          h(Field, { label: '密钥变量名' }, h(Text, { value: f('google.apiKeyEnv', 'GOOGLE_API_KEY'), onChange: put('google.apiKeyEnv') }))),
        h('div', { style: S.section }, '聊天模型（后台补写日记、整理）'),
        h('div', { style: S.card },
          h(Field, { label: '模型' }, h(Text, { value: f('chat.model', ''), onChange: put('chat.model'), placeholder: 'deepseek-chat' })),
          h(Field, { label: '接口地址', hint: 'OpenAI 兼容的地址，例如 https://api.deepseek.com/v1' }, h(Text, { value: f('chat.endpoint', 'https://api.deepseek.com/v1'), onChange: put('chat.endpoint') })),
          h(Field, { label: '密钥变量名' }, h(Text, { value: f('chat.apiKeyEnv', 'DEEPSEEK_API_KEY'), onChange: put('chat.apiKeyEnv') }))),
        h('div', { style: S.section }, 'API 密钥'),
        h('p', { style: S.hint }, data.credentialsAvailable
          ? '密钥存在 DSH 自己的凭据管理里，不写进记忆配置，也不会被模型读到。改了上面的变量名要先保存配置，再填密钥。'
          : '当前 DSH 没有提供凭据服务，只能通过同名环境变量提供密钥。'),
        (data.keys || []).map(item => h(KeyRow, { key: item.ref, item, call, onKeys })))
    }

    // ---------- 分页：检索与日记 ----------
    function Recall({ draft, setDraft }) {
      const f = (path, fallback) => get(draft, path, fallback)
      const put = path => value => setDraft(set(draft, path, value))
      return h('div', null,
        h('div', { style: S.section }, '检索'),
        h('div', { style: S.card },
          h(Field, { label: '检索引擎', hint: '浪潮是 VCP 的 TagMemo 原生引擎；基础检索只用 TDB 向量加关键词。' },
            h(Select, { value: f('recall.engine', 'tagmemo'), onChange: put('recall.engine'), options: [['tagmemo', '浪潮 TagMemo'], ['baseline', '基础检索（TDB）']] })),
          h(Field, { label: '每轮记忆上限', hint: '每轮最多注入多少 token 的记忆。' }, h(NumberBox, { value: f('recall.tokenBudget', 1200), onChange: put('recall.tokenBudget'), min: 128 })),
          h(Field, { label: '每轮最多几条' }, h(NumberBox, { value: f('recall.maxNotes', 5), onChange: put('recall.maxNotes'), min: 1 })),
          h(Field, { label: '检索超时（毫秒）' }, h(NumberBox, { value: f('recall.timeoutMs', 1500), onChange: put('recall.timeoutMs'), min: 100 }))),
        h('div', { style: S.section }, '后台补写日记'),
        h('div', { style: S.card },
          h(Field, { label: '开启' }, h(Switch, { checked: f('diary.enabled', true) !== false, onChange: put('diary.enabled'), label: '后台补写日记' })),
          h(Field, { label: '每天 token 上限' }, h(NumberBox, { value: f('diary.dailyTokenBudget', 20000), onChange: put('diary.dailyTokenBudget'), min: 0 })),
          h(Field, { label: '每隔几轮补一次' }, h(NumberBox, { value: f('diary.turnInterval', 8), onChange: put('diary.turnInterval'), min: 1 }))),
        h('div', { style: S.section }, '存储'),
        h('div', { style: S.card },
          h(Field, { label: '记忆库位置', hint: '留空用系统「文档」目录下的 DSH-Memory。不能放在 DSH 家目录里。改位置不会搬走已有的日记。' },
            h(Text, { value: f('vaultPath', ''), onChange: put('vaultPath') })),
          h(Field, { label: '时区' }, h(Text, { value: f('timezone', ''), onChange: put('timezone'), placeholder: 'Asia/Shanghai' }))))
    }

    // ---------- 页面 ----------
    function MemoryPage({ call }) {
      const [tab, setTab] = useState('overview')
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const load = useCallback(async () => {
        const r = await call('state', {})
        if (!r.ok) { setError(r.error.message); return }
        setError(null); setData(r.value); setDraft(clone(r.value.config))
      }, [call])
      useEffect(() => { load() }, [load])
      if (error) return h('div', { style: S.page }, h('div', { style: S.inner }, h('h1', { style: S.title }, '记忆'), h('p', { style: S.err }, error), h(Button, { onClick: load }, '重试')))
      if (!data || !draft) return h('div', { style: S.page }, h('div', { style: S.inner }, h('h1', { style: S.title }, '记忆'), h('p', { style: S.subtitle }, '读取中…')))
      const dirty = JSON.stringify(draft) !== JSON.stringify(data.config)
      const save = async () => {
        const r = await call('saveConfig', { config: draft })
        if (r.ok) { setNotice(['已保存。重启 DSH 后生效。', S.ok]); await load() } else setNotice([r.error.message, S.err])
      }
      const tabs = [
        { value: 'overview', label: '概览', id: 'mc-tab-overview', panelId: 'mc-panel' },
        { value: 'roles', label: '角色', id: 'mc-tab-roles', panelId: 'mc-panel' },
        { value: 'models', label: '模型与密钥', id: 'mc-tab-models', panelId: 'mc-panel' },
        { value: 'recall', label: '检索与日记', id: 'mc-tab-recall', panelId: 'mc-panel' },
      ]
      const onKeys = keys => setData({ ...data, keys })
      const body = tab === 'overview' ? h(Overview, { data, call, reload: load })
        : tab === 'roles' ? h(Roles, { draft, setDraft })
        : tab === 'models' ? h(Models, { data, draft, setDraft, call, onKeys })
        : h(Recall, { draft, setDraft })
      return h('div', { style: S.page },
        h('div', { style: S.inner },
          h('h1', { style: S.title }, '记忆'),
          h('p', { style: S.subtitle }, '角色日记、长期记忆和检索设置'),
          h(SegmentedTabs, { items: tabs, value: tab, onChange: setTab, label: '记忆设置分页' }),
          h('div', { id: 'mc-panel', role: 'tabpanel', style: { marginTop: 20 } }, body),
          tab !== 'overview' ? h('div', { style: S.bar },
            h(Button, { variant: 'primary', onClick: save, disabled: !dirty }, '保存配置'),
            h(Button, { variant: 'ghost', onClick: () => { setDraft(clone(data.config)); setNotice(null) }, disabled: !dirty }, '撤销修改'),
            notice ? h('span', { style: notice[1] }, notice[0]) : dirty ? h('span', { style: S.hint }, '有未保存的修改') : null) : null))
    }

    // 侧栏图标：书本
    function MemoryIcon({ size }) {
      const s = size || 20
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z' }),
        h('path', { d: 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5' }),
        h('path', { d: 'M9 8h7M9 11.5h5' }))
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const labels = { zh: { panel: '记忆' }, en: { panel: 'Memory' } }
        ctx.effect(() => ctx.locale.register(NS, labels))
        const t = ctx.locale.bind(NS)
        const call = async (endpoint, payload) => {
          try { return await ctx.connection.rpc.call(CHANNEL, endpoint, payload) }
          catch (error) { return { ok: false, error: { code: 'TRANSPORT', message: `连接插件失败：${error?.message || error}`, details: {} } } }
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ call }),
        }, MemoryPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel'),
        }, MemoryIcon))
      },
    }
  },
})
