/** DSH adapter using registered providers and durable events; never patches host history. */
import { createMemoryService } from './service.mjs'
import { MemoryError, hash, id, now, estimateTokens } from './common.mjs'
import { readHostConfig } from './host-config.mjs'

export const name = 'memory-companion'
export const inject = ['systemPrompt', 'tools', 'sessionPersistence']

const CONTEXT_NAME = 'memory-companion:recall'
const PERSONA_SECTION = 'deployment:persona-prefix'
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const NOTE_KEYS = new Set(['body', 'kind', 'tags', 'stance', 'facets', 'sources', 'relation'])

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('INVALID_INPUT', `${label}必须为对象`)
  return value
}

function text(value, label, maximum = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new MemoryError('INVALID_INPUT', `${label}必须为非空文本，长度不超过${maximum}`)
  }
  return value
}

function strings(value, label, maximum = 12) {
  if (!Array.isArray(value) || value.length > maximum) throw new MemoryError('INVALID_INPUT', `${label}必须为有限数组`)
  return value.map(item => text(item, label, 80))
}

function noteInput(value) {
  const input = object(value, '日记')
  for (const key of Object.keys(input)) if (!NOTE_KEYS.has(key)) throw new MemoryError('INVALID_INPUT', `不接受日记字段：${key}`)
  text(input.body, '正文')
  if (input.kind !== undefined && !['diary', 'impression', 'public'].includes(input.kind)) throw new MemoryError('INVALID_INPUT', '无效日记种类')
  if (input.tags !== undefined) strings(input.tags, '标签')
  if (input.stance !== undefined) text(input.stance, '陈述性质', 128)
  if (input.facets !== undefined) strings(input.facets, 'facets')
  const sources = validateReferences(input.sources)
  if (sources.length > 12) throw new MemoryError('INVALID_INPUT', 'At most 12 note sources are allowed')
  for (const source of sources) text(source.quote, 'quote', 50000)
  if (input.stance !== undefined && !['observation', 'interpretation', 'feeling'].includes(input.stance)) throw new MemoryError('INVALID_INPUT', 'Invalid stance')
  if (input.relation !== undefined) {
    const relation = object(input.relation, '关系')
    if (!['claims_correction', 'claims_retraction'].includes(relation.type)) throw new MemoryError('INVALID_INPUT', '这里只能提出更正或撤回关系')
    const target = object(relation.to, '关系目标')
    text(target.note_id, 'note_id', 256)
    text(target.revision_id, 'revision_id', 256)
    text(relation.reason, '关系理由', 2000)
  }
  return input
}

function validateReferences(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new MemoryError('INVALID_INPUT', '来源须为1至20条引用')
  return value.map(item => {
    const ref = object(item, '来源引用')
    for (const key of Object.keys(ref)) {
      if (!['event_id', 'quote', 'start_utf8_byte', 'end_utf8_byte', 'text_sha256'].includes(key)) throw new MemoryError('INVALID_INPUT', `不接受来源字段：${key}`)
    }
    text(ref.event_id, 'event_id', 256)
    if (ref.quote !== undefined) text(ref.quote, '引文', 50000)
    for (const key of ['start_utf8_byte', 'end_utf8_byte']) {
      if (ref[key] !== undefined && (!Number.isSafeInteger(ref[key]) || ref[key] < 0)) throw new MemoryError('INVALID_INPUT', '引文偏移必须为非负整数')
    }
    return ref
  })
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

function declarations(assembly, config) {
  const section = assembly.sections.find(entry => entry.name === PERSONA_SECTION)
  if (!section) return null
  const names = [...section.text.matchAll(/\{\{\s*(mem_[a-z0-9_]+)\s*\}\}/g)].map(match => match[1])
  if (!names.length) return null
  const byAlias = new Map(config.roles.map(role => [role.alias ?? role.id, role]))
  const self = names.filter(item => item.startsWith('mem_self_'))
  if (self.length !== 1) throw new MemoryError('IDENTITY_DECLARATION', '生效人设前缀须恰有一个mem_self身份声明')
  const owner = byAlias.get(self[0].slice('mem_self_'.length))
  if (!owner) throw new MemoryError('IDENTITY_DECLARATION', '人设引用了未配置的记忆角色')
  const reads = new Set([owner.id])
  for (const item of names) {
    if (item === 'mem_public' || item === self[0]) continue
    const prefix = item.startsWith('mem_read_') ? 'mem_read_' : item.startsWith('mem_timeline_') ? 'mem_timeline_' : null
    if (!prefix || !byAlias.has(item.slice(prefix.length))) throw new MemoryError('IDENTITY_DECLARATION', `未知记忆声明：${item}`)
    if (prefix === 'mem_read_') reads.add(byAlias.get(item.slice(prefix.length)).id)
  }
  return {
    role_id: owner.id,
    context_id: config.contextId,
    read_role_ids: [...reads].sort(),
    read_public: names.includes('mem_public'),
    allow_public: false,
    persona_revision: hash(section.text),
  }
}

function bindingSignature(binding) {
  return hash(JSON.stringify({
    role_id: binding.role_id, context_id: binding.context_id,
    read_role_ids: [...binding.read_role_ids].sort(), read_public: binding.read_public,
    allow_public: binding.allow_public,
  }))
}

function narrower(previous, next) {
  return previous.role_id !== next.role_id || previous.context_id !== next.context_id
    || (previous.read_public && !next.read_public)
    || previous.read_role_ids.some(role => !next.read_role_ids.includes(role))
}

function isSynthetic(event, message) {
  if (event.type === 'user/message') return message.source?.kind !== 'user'
  if (event.type === 'assistant/message') return message.source?.kind !== 'model'
  return message.source?.kind !== 'tool'
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const sourceSchema = {
  type: 'array', minItems: 1, maxItems: 20,
  items: {
    type: 'object', required: ['event_id'], additionalProperties: false,
    properties: {
      event_id: { type: 'string' }, quote: { type: 'string' }, text_sha256: { type: 'string' },
      start_utf8_byte: { type: 'integer', minimum: 0 }, end_utf8_byte: { type: 'integer', minimum: 0 },
    },
  },
}

/** Only an explicit deployment acknowledgement admits the DSH-facing local adapter. */
export async function apply(ctx, rawConfig = {}) {
  rawConfig = await readHostConfig(rawConfig)
  if (rawConfig.security?.mode !== 'host-enforced' || rawConfig.security?.deploymentAcknowledged !== true) {
    throw new MemoryError('ISOLATION_REQUIRED', '记忆插件未启动：须先用宿主沙箱或独立OS权限隔离模型对记忆库、身份配置和管理凭据的直接读写，再明确设置security.mode=host-enforced及deploymentAcknowledged=true。此配置是部署声明，不是插件自动验证。')
  }

  const service = await createMemoryService(rawConfig)
  const config = service.config
  const states = new Map()
  const captureFailures = new Map()
  let queue = Promise.resolve()
  let closing = false
  let closePromise
  let adapterError = null
  ctx.effect(() => () => {
    if (!closePromise) {
      closing = true
      closePromise = (async () => {
        await Promise.allSettled([...states.values()].map(state => state.catchup).filter(Boolean))
        await queue
        states.clear()
        await service.close()
      })()
    }
    return closePromise
  })
  let instanceId = config.host?.instanceId
  if (!instanceId) {
    instanceId = await service.vault.loadState('host_instance_id', null)
    if (!instanceId) {
      instanceId = id('dsh')
      await service.vault.saveState('host_instance_id', instanceId)
    }
  }

  function report(error) {
    adapterError = { code: error?.code ?? 'HOST_ADAPTER_ERROR', message: String(error?.message ?? error) }
    console.error(`[dsh-memory-companion] ${adapterError.code}: ${adapterError.message}`)
  }

  function enqueue(action) {
    const pending = queue.then(action)
    queue = pending.catch(report)
    return pending
  }

  function stateFor(session) {
    const sessionId = String(session.id)
    if (!states.has(sessionId)) states.set(sessionId, {
      session, sessionId, optedIn: undefined, binding: service.vault.getBinding(sessionId) ?? null,
      bindingReady: Promise.resolve(), epochRecords: null, turn: null, current: null,
      query: '', sourceIds: new Set(), recent: [], admitted: new Map(), loadedAdmission: false,
      cleanRequired: null, catchup: null, checkedNotes: new Map(), toolNames: new Map(), memoryCallIds: new Set(), toolMetadataLoaded: false,
    })
    const state = states.get(sessionId)
    state.session = session
    return state
  }

  async function epochsFor(state) {
    if (state.epochRecords === null) state.epochRecords = await service.vault.loadState(`host_epochs_${hash(state.sessionId)}`, [])
    if (!state.toolMetadataLoaded) {
      const metadata = await service.vault.loadState(`host_tools_${hash(state.sessionId)}`, { names: [], memory: [] })
      for (const [callId, toolName] of metadata.names) if (!state.toolNames.has(callId)) state.toolNames.set(callId, toolName)
      for (const callId of metadata.memory) state.memoryCallIds.add(callId)
      state.toolMetadataLoaded = true
    }
    return state.epochRecords
  }

  function saveToolMetadata(state) {
    return enqueue(() => service.vault.saveState(`host_tools_${hash(state.sessionId)}`, { names: [...state.toolNames], memory: [...state.memoryCallIds] }))
  }

  async function bindState(state, declared) {
    const epochs = await epochsFor(state)
    const old = service.vault.getBinding(state.sessionId) ?? state.binding
    const signature = bindingSignature(declared)
    if (old && old.policy_revision === signature) {
      state.binding = old
      return old
    }
    const next = await service.vault.bind({
      ...declared, binding_id: id('binding'), session_id: state.sessionId,
      branch_id: state.sessionId, policy_revision: signature, epoch: (old?.epoch ?? 0) + 1,
    })
    if (old && narrower(old, next)) state.cleanRequired = '角色或读取权限已收窄；旧历史可能含有无权材料'
    epochs.push({ effective_seq: state.session.seq, binding: next })
    await service.vault.saveState(`host_epochs_${hash(state.sessionId)}`, epochs)
    state.binding = next
    state.current = null
    service.recall.invalidate(state.sessionId)
    return next
  }

  async function capture(session, event, knownBinding, turn, snapshot, inherited = false) {
    if (!MESSAGE_TYPES.has(event.type)) return
    const message = event.type === 'user/message' ? event.data : event.data?.message
    if (!message || typeof message.id !== 'string') return
    if (event.type === 'tool/result' && config.host?.captureTools === false) return
    const content = messageText(message)
    const nonText = (message.content ?? []).filter(block => block?.type !== 'text').map(block => ({ type: block.type, id: block.id ?? null, name: block.name ?? null }))
    if (!content && !nonText.length) return
    const liveState = states.get(String(session.id))
    const toolName = liveState?.toolNames.get(message.source?.callId)
    const memoryTool = event.type === 'tool/result' && (toolName === 'memory_note' || toolName === 'memory_evidence' || liveState?.memoryCallIds.has(message.source?.callId))
    const synthetic = isSynthetic(event, message) || memoryTool
    const speaker = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : 'tool'
    const nativeKey = `${String(session.id)}:${message.id}`
    const revision = hash(JSON.stringify({ text: content, source: message.source, nonText }))
    const eventId = `event_${hash(`${instanceId}:${nativeKey}:${revision}`)}`
    try {
      const saved = await service.vault.capture({
        event_id: eventId,
        source: { instance_id: instanceId, session_id: String(session.id), native_event_id: message.id, native_revision: revision },
        branch_id: String(session.id), context_id: knownBinding?.context_id ?? config.contextId,
        context_role_id: knownBinding?.role_id ?? null,
        speaker, origin: synthetic ? 'plugin_synthetic' : speaker === 'user' ? 'user_input' : speaker === 'assistant' ? 'assistant_output' : 'tool_output',
        evidence_eligible: !synthetic && !inherited,
        source_time: typeof event.time === 'number' && Number.isFinite(event.time) ? new Date(event.time).toISOString() : now(), captured_at: now(),
        text: content, text_sha256: hash(content),
        snapshot_id: snapshot?.snapshot_id ?? null,
        derived_from: snapshot?.items?.map(item => ({ note_id: item.note_id, revision_id: item.revision_id })) ?? [],
        native_seq: event.seq, source_kind: message.source?.kind ?? 'unknown',
        native_turn: turn ?? null, inherited_unresolved: inherited, non_text_content: nonText, tool_name: toolName ?? null,
      })
      captureFailures.delete(eventId)
      const state = states.get(String(session.id))
      if (state && !synthetic && !inherited && state.turn === turn) state.sourceIds.add(saved.event_id)
      if (state && !synthetic && !inherited && (speaker === 'user' || speaker === 'assistant')) {
        state.recent = [...state.recent.filter(item => item.event_id !== saved.event_id), saved].slice(-6)
      }
      if (knownBinding && !synthetic && !inherited) await service.diary.observe(saved, knownBinding)
      return saved
    } catch (error) {
      captureFailures.set(eventId, { session_id: String(session.id), seq: event.seq, code: error?.code ?? 'CAPTURE_FAILED' })
      throw error
    }
  }

  async function catchUp(state) {
    const cursorKey = `host_cursor_${hash(`${instanceId}:${state.sessionId}`)}`
    const cursor = await service.vault.loadState(cursorKey, 0)
    const handle = await ctx.sessionPersistence.open(state.session.id, 'read')
    const epochs = await epochsFor(state)
    const batchSize = config.host?.persistenceBatchSize ?? 200
    let offset = cursor
    let turn = null
    try {
      while (!closing) {
        const { events } = await handle.read(offset, batchSize)
        if (!events.length) break
        for (const event of events) {
          if (event.type === 'turn/start') turn = event.data.turn
          if (event.type === 'tool/call') state.toolNames.set(event.data.callId, event.data.name)
          const binding = [...epochs].reverse().find(item => item.effective_seq <= event.seq)?.binding ?? null
          const inherited = event.seq < handle.inheritedEventCount
          await enqueue(() => capture(state.session, event, binding, event.data?.turn ?? turn, null, inherited))
        }
        offset += events.length
        await saveToolMetadata(state)
        await service.vault.saveState(cursorKey, offset)
        if (events.length < batchSize) break
      }
    } finally {
      await handle.close()
    }
  }

  function scheduleCatchUp(state) {
    if (state.catchup) return state.catchup
    state.catchup = catchUp(state).catch(report).finally(() => { state.catchup = null })
    return state.catchup
  }

  async function assertHistoryEligible(state) {
    if (!state.loadedAdmission) {
      const old = await service.vault.loadState(`host_admitted_${hash(state.sessionId)}`, [])
      state.admitted = new Map(old.map(item => [item.snapshot_id, item]))
      state.loadedAdmission = true
    }
    for (const snapshot of state.admitted.values()) {
      for (const item of snapshot.items ?? []) {
        const note = await service.vault.getNote(item.note_id)
        if (!note || note.revision_id !== item.revision_id || !service.vault.isEligible(note, state.binding, { explicit: false })) {
          state.cleanRequired = '旧会话历史包含已修改、撤回、排除或不再有权读取的记忆'
          break
        }
        state.checkedNotes.set(note.note_id, note)
      }
      if (state.cleanRequired) break
    }
    if (state.cleanRequired) throw new MemoryError('MEMORY_CONTEXT_RESET_REQUIRED', `${state.cleanRequired}。请建立不继承旧历史或旧摘要的新会话；插件未自动删除宿主历史。`)
  }

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const session = context.agent?.session
    if (!session || closing) return next()
    const state = stateFor(session)
    const declared = declarations(assembly, config)
    state.optedIn = declared !== null
    if (!declared) {
      state.current = null
      if (state.binding) {
        const admitted = await service.vault.loadState(`host_admitted_${hash(state.sessionId)}`, [])
        if (admitted.length) state.cleanRequired = '已移除记忆身份声明，但旧会话仍含有记忆材料'
      }
      return next()
    }
    state.bindingReady = enqueue(() => bindState(state, declared))
    await state.bindingReady
    void scheduleCatchUp(state)
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (closing) return
    const state = stateFor(session)
    if (event.type === 'turn/start') {
      state.turn = event.data.turn
      state.sourceIds = new Set()
      state.query = ''
      state.current = null
      return
    }
    if (state.optedIn === false) return
    if (event.type === 'tool/call') {
      state.toolNames.set(event.data.callId, event.data.name)
      void saveToolMetadata(state).catch(() => {})
      return
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'runtime-context') {
      const section = event.data.source.sections?.find(item => item.name === CONTEXT_NAME)
      if (section && state.current) {
        const admitted = { snapshot_id: state.current.snapshot_id, estimated_tokens: state.current.estimated_tokens, items: state.current.items, text_hash: hash(section.text) }
        state.admitted.set(admitted.snapshot_id, admitted)
        void enqueue(() => service.vault.saveState(`host_admitted_${hash(state.sessionId)}`, [...state.admitted.values()])).catch(() => {})
      }
    }
    const binding = state.binding
    const snapshot = state.current
    const turn = event.data?.turn ?? state.turn
    void enqueue(() => capture(session, event, binding, turn, snapshot)).catch(() => {})
  })

  ctx.on('session/flush', async (session) => {
    await queue
    const failed = [...captureFailures.values()].filter(item => item.session_id === String(session.id))
    if (failed.length) throw new MemoryError('CAPTURE_INCOMPLETE', '记忆原文存在未保存事件；请查看管理诊断并重试补抄', failed)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const state = stateFor(payload.agent.session)
    if (closing) return next()
    if (state.cleanRequired) throw new MemoryError('MEMORY_CONTEXT_RESET_REQUIRED', `${state.cleanRequired}。请建立不继承旧历史或旧摘要的新会话。`)
    if (!state.optedIn) return next()
    await state.bindingReady
    await queue
    payload.signal.throwIfAborted()
    const binding = service.vault.getBinding(state.sessionId) ?? state.binding
    if (!binding) throw new MemoryError('IDENTITY_UNBOUND', '当前会话尚未完成角色绑定')
    state.binding = binding
    state.turn = payload.turn
    const inputs = payload.messages.filter(message => message.source?.kind === 'user').map(messageText).filter(Boolean)
    if (inputs.length) {
      state.query = inputs.join('\n')
    }
    await assertHistoryEligible(state)
    if (!state.query) { state.current = null; return next() }
    const snapshot = await service.recall.recall({
      binding, turn_id: `${state.sessionId}:${binding.epoch}:${payload.turn}`,
      query: state.query, context: state.recent, signal: payload.signal,
    })
    payload.signal.throwIfAborted()
    for (const item of snapshot.items ?? []) {
      const note = await service.vault.getNote(item.note_id)
      if (!note || note.revision_id !== item.revision_id || !service.vault.isEligible(note, binding, { explicit: false })) {
        throw new MemoryError('MEMORY_CHANGED', '记忆在请求准备期间发生变化，请重新发送本轮请求')
      }
      state.checkedNotes.set(note.note_id, note)
    }
    const used = [...state.admitted.values()].reduce((sum, item) => sum + (item.estimated_tokens ?? 0), 0)
    const extra = state.admitted.has(snapshot.snapshot_id) ? 0 : snapshot.estimated_tokens
    if (used + extra > config.recall.historyBudget) {
      state.current = null
      state.cleanRequired = '会话中累计记忆已达到配置预算'
      throw new MemoryError('MEMORY_HISTORY_BUDGET', '累计记忆已达到预算，请新建不继承旧记忆摘要的干净会话。插件没有调用未确认的宿主历史清理接口。')
    }
    state.current = snapshot
    return next()
  })

  ctx.systemPrompt.context({
    name: CONTEXT_NAME, order: config.host?.contextOrder ?? 140, interpolate: false,
    text(context) {
      const state = context.agent?.session ? states.get(String(context.agent.session.id)) : undefined
      if (!state?.optedIn || closing || state.cleanRequired || !state.current) return ''
      const currentBinding = service.vault.getBinding(state.sessionId)
      if (!currentBinding || currentBinding.binding_id !== state.current.binding_id) {
        throw new MemoryError('MEMORY_BINDING_CHANGED', '请求准备期间角色绑定已变化，请建立相应身份的干净会话')
      }
      for (const note of state.checkedNotes.values()) {
        if (!service.vault.isEligible(note, currentBinding, { explicit: false })) {
          state.cleanRequired = '请求准备期间记忆权限或排除状态已变化'
          throw new MemoryError('MEMORY_CONTEXT_RESET_REQUIRED', `${state.cleanRequired}，请建立干净会话。`)
        }
      }
      return state.current.rendered_text
    },
  })

  ctx.tools.register({
    name: 'memory_note',
    description: '追加一条有来源的短日记，或提出更正/撤回关系。不能修改旧记忆、确认提议、指定作者或文件路径；不确定内容应保留限定。',
    parameters: {
      type: 'object', required: ['body', 'sources'], additionalProperties: false,
      properties: {
        body: { type: 'string', maxLength: 20000 }, kind: { type: 'string', enum: ['diary', 'impression', 'public'] },
        tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 80 } },
        stance: { type: 'string', enum: ['observation', 'interpretation', 'feeling'] },
        facets: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 80 } },
        sources: { ...sourceSchema, maxItems: 12, items: { ...sourceSchema.items, required: ['event_id', 'quote'] } },
        relation: {
          type: 'object', required: ['type', 'to', 'reason'], additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['claims_correction', 'claims_retraction'] }, reason: { type: 'string' },
            to: { type: 'object', required: ['note_id', 'revision_id'], additionalProperties: false, properties: { note_id: { type: 'string' }, revision_id: { type: 'string' } } },
          },
        },
      },
    },
    output,
    async execute(args, execution) {
      const input = noteInput(args)
      const state = execution.agent?.session ? stateFor(execution.agent.session) : null
      if (!state?.optedIn || !state.binding || state.turn === null || closing) throw new MemoryError('IDENTITY_UNBOUND', '记日记需要已绑定且正在进行的会话')
      await queue
      execution.signal.throwIfAborted()
      state.memoryCallIds.add(execution.rootCallId ?? execution.callId)
      await saveToolMetadata(state)
      return service.diary.note(input, state.binding, {
        turn_id: `${state.sessionId}:${state.binding.epoch}:${state.turn}`,
        source_event_ids: [...state.sourceIds],
      })
    },
  })

  ctx.tools.register({
    name: 'memory_evidence',
    description: '核对已经知道ID的记忆来源。只返回有权读取且未排除的原文引文；不会搜索整个记忆库。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        note_id: { type: 'string' }, sources: sourceSchema,
        current_turn: { type: 'boolean', const: true, description: 'Return this turn\'s captured source IDs and quotations before writing memory_note. Exactly one selector is required.' },
      },
    },
    output,
    async execute(args, execution) {
      const input = object(args, '来源请求')
      for (const key of Object.keys(input)) if (!['note_id', 'sources', 'current_turn'].includes(key)) throw new MemoryError('INVALID_INPUT', `不接受字段：${key}`)
      if ([input.note_id !== undefined, input.sources !== undefined, input.current_turn === true].filter(Boolean).length !== 1 || (input.current_turn !== undefined && input.current_turn !== true)) throw new MemoryError('INVALID_INPUT', '请选择note_id或sources之一')
      const state = execution.agent?.session ? stateFor(execution.agent.session) : null
      if (!state?.optedIn || !state.binding || closing) throw new MemoryError('IDENTITY_UNBOUND', '读取来源需要已绑定会话')
      await queue
      execution.signal.throwIfAborted()
      state.memoryCallIds.add(execution.rootCallId ?? execution.callId)
      await saveToolMetadata(state)
      let references
      if (input.note_id !== undefined) {
        const note = await service.vault.getNote(text(input.note_id, 'note_id', 256))
        if (!note || !service.vault.isEligible(note, state.binding, { explicit: true })) throw new MemoryError('MEMORY_NOT_AVAILABLE', '该记忆当前不可读取')
        references = note.sources
      } else if (input.current_turn === true) {
        references = [...state.sourceIds]
        if (!references.length) return { evidence: [], omitted: 0, message: 'No eligible source has been captured for this turn yet.' }
      } else references = validateReferences(input.sources)
      const resolved = await service.vault.resolveSources(references, state.binding)
      const budget = config.host?.evidenceTokenBudget ?? config.recall.tokenBudget
      const evidence = []
      let used = 0
      for (const ref of resolved) {
        execution.signal.throwIfAborted()
        const source = await service.vault.getEvent(ref.event_id)
        if (!source || !service.vault.canReadEvent(source, state.binding)) throw new MemoryError('SOURCE_NOT_AVAILABLE', '来源权限已变化')
        const row = { ...ref, speaker: source.speaker, origin: source.origin, source_time: source.source_time }
        const cost = estimateTokens(JSON.stringify(row))
        if (used + cost > budget) break
        evidence.push(row)
        used += cost
      }
      return { evidence, omitted: resolved.length - evidence.length, message: evidence.length ? '引文存在不等于内容已经证实；请保留发言者及来源性质。' : '所选引文超过本次预算，请用更短的明确字节范围重试。' }
    },
  })

  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'memory', description: '查看记忆插件状态；管理与审批使用独立用户管理界面。',
      input: { hint: 'status' },
      handler({ agent, rawInput }) {
        if (rawInput.trim() && rawInput.trim() !== 'status') return { kind: 'error', text: '此命令仅支持status。编辑、审批和清理请使用独立管理界面。' }
        const state = states.get(String(agent.session.id))
        return { kind: 'success', text: JSON.stringify({ enabled: state?.optedIn === true, role_id: state?.binding?.role_id ?? null, clean_context_required: state?.cleanRequired ?? null, capture_failures: captureFailures.size, error: adapterError, service: service.health(), management_command: 'node src/cli.mjs open --config <config.json> (user terminal only)' }, null, 2) }
      },
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(String(agent.session.id))
    if (state) { state.current = null; state.sourceIds.clear() }
    service.recall.invalidate(String(agent.session.id))
  })

}
