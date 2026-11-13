import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryError, id, hash, now, canonical } from './common.mjs';
import { VaultIO } from './storage/io.mjs';
import { NOTE_KINDS, copy, text, token, strings, validTimestamp, decodeNote, revisionHex, spanKey, overlaps, usage } from './storage/format.mjs';
import { mutations } from './storage/mutations.mjs';

/*
 * Porting references (behavioral rules, not an embedded AstrBot runtime):
 * astrbot_plugin_private_companion@38212f66de2a3629fbbac41416525fc519d0f195
 * memory/access.py capture/evidence; native_observations.py; sources/dependencies.py.
 * This implementation uses ordinary authoritative files and an append-only
 * control journal, not that project's SQLite fact-atom/current-truth model.
 */
const DIRECT_ORIGINS = new Set(['user_input', 'assistant_output', 'tool_output']);
const INTERNAL_DIRS = ['原文', '公共', '修订', '关系', '提议', '控制', '状态', '注入记录', '索引', '暂存', '资料'];
const MAX_RAW_BYTES = 33_554_432;
const CONTROL_FILE = '控制/actions.jsonl';
const CHECKPOINT = '控制/checkpoint.json';

function folder(value) {
  text(value, 'directory', { max: 128 });
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value) || value === '.' || value === '..') {
    throw new MemoryError('invalid_directory', 'A role directory must be one portable path component.');
  }
  return value;
}
function stripHash(record) { const { record_hash, ...body } = record; return body; }
function sourceIdentity(source) {
  if (!source.instance_id || !source.session_id || !source.native_event_id) return null;
  return canonical([source.instance_id, source.session_id, source.native_event_id, source.native_revision ?? null]);
}
function effectTargets(effect) {
  return effect.targets ?? (effect.note_id ? [{ note_id: effect.note_id, revision_id: effect.revision_id ?? '*' }] : []);
}

export class Vault {
  constructor(config) {
    this.config = config;
    this.io = new VaultIO(config.vaultPath);
    this.root = this.io.root;
    this._tail = Promise.resolve();
    this._opened = false; this._closed = false; this._healthy = true;
    this._issues = []; this._fileIssues = new Map();
    this._lastSeq = 0; this._lastHash = null; this._rawSeq = 0;
    this._bindings = new Map(); this._catalog = new Map(); this._events = new Map();
    this._sourceIds = new Map(); this._sourceRevisions = new Map(); this._branches = new Map();
    this._operations = new Map(); this._receipts = new Map(); this._proposals = new Map();
    this._relations = new Map(); this._relationStates = new Map(); this._effects = [];
    this._snapshots = new Map(); this._roles = new Map();
    this._rawSegment = null; this._manifest = null; this._lockToken = null;
  }
  _serial(work) {
    const result = this._tail.then(work);
    this._tail = result.catch(() => {});
    return result;
  }
  _assertOpen() {
    if (!this._opened || this._closed) throw new MemoryError('vault_closed', 'The vault is not open.');
  }
  _assertHealthy() {
    this._assertOpen();
    if (!this._healthy) throw new MemoryError('control_state_unavailable', 'Control state integrity is unknown; recall and mutations are suspended.', { issues: this._issues });
  }
  _issue(code, details = {}) { this._issues.push({ code, at: now(), ...details }); this._issues = this._issues.slice(-100); }
  _role(roleId) {
    const role = this._roles.get(roleId);
    if (!role) throw new MemoryError('unknown_role', 'The role is not configured.', { role_id: roleId });
    return role;
  }
  _context(contextId) {
    const context = contextId ?? this.config.contextId ?? 'default';
    token(context, 'context_id');
    const configured = new Set(['default', this.config.contextId ?? 'default', ...(this.config.contexts ?? []).map(x => x.id ?? x.context_id)]);
    if (!configured.has(context)) throw new MemoryError('unknown_context', 'The context is not configured.', { context_id: context });
    return context;
  }
  async _acquireLock() {
    const lockPath = await this.io.checked('控制/writer.lock');
    const nonce = id('lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, created_at: now() })); await handle.sync(); }
        finally { await handle.close(); }
        this._lockToken = nonce; return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse((await this.io.bytes(lockPath, 8192)).toString('utf8')); }
        catch { throw new MemoryError('vault_locked', 'The writer lock is unreadable; inspect it before opening another writer.'); }
        if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new MemoryError('vault_locked', 'The writer lock has no valid process identity.');
        let absent = false;
        try { process.kill(previous.pid, 0); } catch (e) { absent = e.code === 'ESRCH'; }
        if (!absent) throw new MemoryError('vault_locked', 'Another process may own this vault.', { pid: previous.pid });
        await fs.unlink(lockPath);
      }
    }
    throw new MemoryError('vault_locked', 'Could not acquire the vault writer lock.');
  }
  async open() {
    return this._serial(async () => {
      if (this._opened && !this._closed) return this;
      await this.io.initialize(); this.root = this.io.root;
      for (const directory of INTERNAL_DIRS) await this.io.mkdir(directory);
      await this._acquireLock();
      try {
        const existing = await this.io.json('vault.json', null);
        if (existing && existing.schema_version !== 1) throw new MemoryError('vault_schema', 'Unsupported vault schema; open with a compatible reader.');
        const configured = this.config.roles ?? [];
        if (!configured.length) throw new MemoryError('roles_required', 'Configure at least one role.');
        const directories = new Set();
        for (const item of configured) {
          const roleId = token(item.id ?? item.role_id, 'role_id');
          const old = existing?.roles?.find(r => r.id === roleId);
          const directory = folder(old?.directory ?? item.directory ?? item.name ?? roleId);
          if (INTERNAL_DIRS.includes(directory) || directories.has(directory.toLocaleLowerCase('en-US'))) {
            throw new MemoryError('role_directory_conflict', 'Role directories must be distinct from each other and internal directories.');
          }
          directories.add(directory.toLocaleLowerCase('en-US'));
          this._roles.set(roleId, { id: roleId, name: item.name ?? roleId, directory });
          await this.io.mkdir(path.join(directory, '日记'));
          await this.io.mkdir(path.join(directory, '印象'));
          await this.io.mkdir(path.join(directory, '时间线'));
        }
        this._manifest = existing ?? { schema_version: 1, vault_id: id('vault'), created_at: now(), roles: [...this._roles.values()] };
        if (!existing) {
          const existingRaw = (await this.io.walk('原文')).length;
          if (existingRaw || await this.io.exists(CONTROL_FILE)) throw new MemoryError('manifest_missing', 'Existing vault data has no manifest; do not initialize over it.');
          await this.io.jsonAtomic('vault.json', this._manifest);
          await this.io.immutable(CONTROL_FILE, Buffer.alloc(0));
          await this.io.jsonAtomic(CHECKPOINT, { schema_version: 1, vault_id: this._manifest.vault_id, log_seq: 0, record_hash: null });
        }
        this._opened = true; this._closed = false;
        await this._loadControls();
        await this._loadRaw();
        await this._loadSnapshots();
        if (this._healthy) {
          await this._recoverOperations();
          await this._reconcile();
        }
        return this;
      } catch (error) {
        await this._releaseLock(); this._opened = false; throw error;
      }
    });
  }
  async _releaseLock() {
    if (!this._lockToken) return;
    const location = '控制/writer.lock';
    try {
      const current = await this.io.json(location, null);
      if (current?.nonce === this._lockToken) await fs.unlink(await this.io.checked(location));
    } finally { this._lockToken = null; }
  }
  async close() {
    await this._serial(async () => { if (this._closed) return; this._closed = true; await this._releaseLock(); });
  }
  async _loadControls() {
    try {
      const bytes = await this.io.bytes(CONTROL_FILE, 536_870_912);
      const checkpoint = await this.io.json(CHECKPOINT);
      if (checkpoint.vault_id !== this._manifest.vault_id || !Number.isSafeInteger(checkpoint.log_seq)) throw new Error('checkpoint_identity');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content && !content.endsWith('\n')) throw new Error('truncated_control_tail');
      const hashes = new Map([[0, null]]);
      for (const line of content.split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line);
        if (record.schema_version !== 1 || record.vault_id !== this._manifest.vault_id ||
            record.log_seq !== this._lastSeq + 1 || record.previous_hash !== this._lastHash ||
            record.record_hash !== hash(canonical(stripHash(record)))) throw new Error('control_chain_invalid');
        this._lastSeq = record.log_seq; this._lastHash = record.record_hash;
        hashes.set(record.log_seq, record.record_hash); this._project(record);
      }
      if (checkpoint.log_seq > this._lastSeq || hashes.get(checkpoint.log_seq) !== checkpoint.record_hash) throw new Error('control_checkpoint_missing');
      if (checkpoint.log_seq < this._lastSeq) await this.io.jsonAtomic(CHECKPOINT, { schema_version: 1, vault_id: this._manifest.vault_id, log_seq: this._lastSeq, record_hash: this._lastHash });
    } catch (error) {
      this._healthy = false;
      this._issue('control_integrity_failure', { reason: error.code ?? error.message });
    }
  }
  _project(record) {
    const data = record.data ?? {};
    if (record.type === 'binding') this._bindings.set(data.binding.session_id, data.binding);
    if (record.type === 'proposal_registered') {
      this._proposals.set(data.proposal.proposal_id, data.proposal);
      if (data.relation) {
        this._relations.set(data.relation.relation_id, data.relation);
        this._relationStates.set(data.relation.relation_id, 'proposed');
      }
      if (data.idempotency_key) this._receipts.set(data.idempotency_key, { payload_hash: data.payload_hash, receipt: data.receipt });
    }
    if (record.type === 'operation_prepared') this._operations.set(data.operation_id, { ...data, status: 'prepared' });
    if (record.type === 'operation_stale') this._operations.set(data.operation_id, { ...this._operations.get(data.operation_id), status: 'stale', reason: data.reason });
    if (record.type === 'operation_commit' || record.type === 'note_observed') {
      for (const note of data.notes ?? []) this._catalog.set(note.note_id, { ...note, missing: false });
      for (const effect of data.effects ?? []) this._effects.push({ ...effect, log_seq: record.log_seq, effect_order: this._effects.length });
      if (data.operation_id) this._operations.set(data.operation_id, { ...data, status: 'committed' });
      if (data.idempotency_key) this._receipts.set(data.idempotency_key, { payload_hash: data.payload_hash, receipt: data.receipt });
      if (data.proposal_id) {
        const p = this._proposals.get(data.proposal_id);
        if (p) this._proposals.set(data.proposal_id, { ...p, status: data.decision === 'reject' ? 'rejected' : 'approved', operation_id: data.operation_id });
      }
      for (const update of data.relation_updates ?? []) this._relationStates.set(update.relation_id, update.status);
    }
    if (record.type === 'note_missing') {
      const current = this._catalog.get(data.note_id);
      if (current) this._catalog.set(data.note_id, { ...current, missing: true });
      for (const effect of data.effects ?? []) this._effects.push({ ...effect, log_seq: record.log_seq, effect_order: this._effects.length });
    }
    if (record.type === 'proposal_stale') {
      const p = this._proposals.get(data.proposal_id);
      if (p) this._proposals.set(data.proposal_id, { ...p, status: 'stale', stale_reason: data.reason });
    }
  }
  async _record(type, data, { actor = 'plugin', context_id = null } = {}) {
    this._assertHealthy();
    const record = { schema_version: 1, vault_id: this._manifest.vault_id, action_id: id('control'),
      log_seq: this._lastSeq + 1, previous_hash: this._lastHash, type, actor, context_id, created_at: now(), data: copy(data) };
    record.record_hash = hash(canonical(record));
    try {
      await this.io.append(CONTROL_FILE, Buffer.from(JSON.stringify(record) + '\n'));
      this._lastSeq = record.log_seq; this._lastHash = record.record_hash; this._project(record);
      await this.io.jsonAtomic(CHECKPOINT, { schema_version: 1, vault_id: this._manifest.vault_id, log_seq: this._lastSeq, record_hash: this._lastHash });
      return record;
    } catch (error) {
      this._healthy = false; this._issue('control_write_uncertain', { reason: error.code ?? error.message });
      throw new MemoryError('control_write_uncertain', 'A control write may have committed. Reopen and recover; do not repeat it with a different operation key.');
    }
  }
  async _loadRaw() {
    for (const file of (await this.io.walk('原文')).filter(f => f.endsWith('.jsonl'))) {
      let lines;
      try { lines = new TextDecoder('utf-8', { fatal: true }).decode(await this.io.bytes(file, 536_870_912)).split('\n'); }
      catch (error) { this._issue('raw_segment_unreadable', { file, reason: error.code ?? error.message }); continue; }
      for (let n = 0; n < lines.length; n++) {
        if (!lines[n]) continue;
        try {
          const record = JSON.parse(lines[n]);
          this._rawSeq = Math.max(this._rawSeq, record.raw_seq ?? 0);
          if (record.record_type === 'branch_ref') {
            this._branches.set(record.capture_key, record.event_id);
            continue;
          }
          if (record.record_type !== 'message' && record.record_type !== 'context_snapshot') continue;
          if (record.text_sha256 !== hash(record.text)) throw new Error('raw_text_hash_mismatch');
          const previous = this._events.get(record.event_id);
          if (previous && canonical(previous) !== canonical(record)) throw new Error('raw_event_identity_conflict');
          this._events.set(record.event_id, record);
          if (record.capture_key) this._sourceIds.set(record.capture_key, record.event_id);
          const key = sourceIdentity(record.source ?? {});
          if (key) {
            const versions = this._sourceRevisions.get(key) ?? [];
            if (!versions.includes(record.event_id)) versions.push(record.event_id);
            this._sourceRevisions.set(key, versions);
          }
        } catch (error) { this._issue('raw_record_invalid', { file, line: n + 1, reason: error.message }); }
      }
    }
  }
  async _appendRaw(record) {
    if (!this._rawSegment) this._rawSegment = path.join('原文', now().slice(0, 7), now().replace(/[:.]/g, '-') + '-' + id('segment') + '.jsonl');
    record.raw_seq = ++this._rawSeq;
    try { await this.io.append(this._rawSegment, Buffer.from(JSON.stringify(record) + '\n')); }
    catch (error) {
      this._rawSegment = null; this._issue('capture_gap', { reason: error.code ?? error.message });
      throw new MemoryError('capture_gap', 'The event was not confirmed durable. Capture progress was not advanced.');
    }
  }
  async capture(input) {
    return this._serial(async () => {
      this._assertOpen();
      const body = text(input.text ?? '', 'event text', { max: MAX_RAW_BYTES, empty: true });
      const source = copy(input.source ?? {});
      source.instance_id ??= input.instance_id ?? this._manifest.vault_id;
      source.session_id ??= input.session_id ?? null;
      source.native_event_id ??= input.native_event_id ?? null;
      source.native_revision ??= null;
      for (const key of ['instance_id', 'session_id', 'native_event_id', 'native_revision']) if (source[key] != null) source[key] = String(source[key]);
      const bound = this._healthy && source.session_id ? this._bindings.get(source.session_id) : null;
      const contextId = input.context_id ?? bound?.context_id ?? null;
      const roleId = input.context_role_id ?? bound?.role_id ?? null;
      if (roleId != null) this._role(roleId);
      if (contextId != null) this._context(contextId);
      const branchId = input.branch_id ?? bound?.branch_id ?? null;
      const speaker = input.speaker ?? input.role ?? 'unknown';
      const synthetic = input.synthetic === true || input.snapshot_id != null || input.origin === 'plugin_synthetic' || input.record_type === 'context_snapshot';
      const origin = synthetic ? 'plugin_synthetic' : input.origin ??
        ({ user: 'user_input', assistant: 'assistant_output', tool: 'tool_output' })[speaker] ?? 'unclassified';
      const nativeKey = sourceIdentity(source);
      const captureKey = input.capture_key ? text(input.capture_key, 'capture_key', { max: 2048 }) : nativeKey;
      const inherited = input.inherited_from_event_id ?? input.parent_event_id;
      if (inherited) {
        if (!input.fork_verified || !input.parent_branch_id) throw new MemoryError('unverified_fork', 'A fork reference needs verified upstream lineage.');
        const original = this._events.get(inherited);
        if (!original || original.context_id !== contextId || original.text !== body || original.speaker !== speaker) {
          throw new MemoryError('fork_event_mismatch', 'The inherited event does not match the verified source.');
        }
        const aliasKey = captureKey ?? canonical([source, branchId, inherited]);
        if (this._branches.get(aliasKey) === inherited) return copy(original);
        await this._appendRaw({ schema_version: 1, record_type: 'branch_ref', context_id: contextId,
          branch_id: branchId, parent_branch_id: input.parent_branch_id, fork_after_event_id: input.fork_after_event_id ?? inherited,
          event_id: inherited, source, capture_key: aliasKey, captured_at: now() });
        this._branches.set(aliasKey, inherited);
        return copy(original);
      }
      if (nativeKey && source.native_revision == null && !input.capture_key) {
        const observed = (this._sourceRevisions.get(nativeKey) ?? []).map(eventId => this._events.get(eventId)).find(event =>
          event && event.text === body && event.speaker === speaker && event.origin === origin &&
          event.context_id === contextId && event.context_role_id === roleId);
        if (observed) return copy(observed);
      }
      if (captureKey && this._sourceIds.has(captureKey)) {
        const existing = this._events.get(this._sourceIds.get(captureKey));
        if (existing.text === body && existing.speaker === speaker && existing.origin === origin &&
            existing.context_id === contextId && existing.context_role_id === roleId) return copy(existing);
        if (source.native_revision != null || input.capture_key) {
          throw new MemoryError('capture_identity_conflict', 'The same delivery identity has different content; supply a genuine new upstream revision.');
        }
        // Without an upstream revision, preserve a changed observation. Its local
        // capture ID distinguishes it; identical text never collapses different native events.
      }
      const eventId = id('event');
      const ambiguousRevision = !!(captureKey && this._sourceIds.has(captureKey));
      const effectiveKey = ambiguousRevision ? captureKey + '|observation:' + eventId : captureKey;
      const event = { schema_version: 1, record_type: synthetic ? 'context_snapshot' : 'message', event_id: eventId,
        source, capture_key: effectiveKey, branch_id: branchId, context_id: contextId, context_role_id: roleId, speaker, origin,
        evidence_eligible: !synthetic && DIRECT_ORIGINS.has(origin) && input.evidence_eligible !== false && !!roleId && !!contextId,
        source_time: validTimestamp(input.source_time ?? input.occurred_at ?? null), source_time_basis: (input.source_time ?? input.occurred_at) ? 'upstream_event_metadata' : 'unknown',
        captured_at: now(), text: body, text_sha256: hash(body) };
      if (input.snapshot_id) event.snapshot_id = token(input.snapshot_id, 'snapshot_id');
      if (Array.isArray(input.derived_from)) event.derived_from = copy(input.derived_from);
      if (ambiguousRevision) {
        event.revises_event_id = this._sourceIds.get(captureKey);
        event.revision_identity_uncertain = true;
      }
      await this._appendRaw(event); this._events.set(eventId, event);
      if (captureKey) this._sourceIds.set(captureKey, eventId);
      if (effectiveKey) this._sourceIds.set(effectiveKey, eventId);
      if (nativeKey) this._sourceRevisions.set(nativeKey, [...(this._sourceRevisions.get(nativeKey) ?? []), eventId]);
      return copy(event);
    });
  }
  async bind(input) {
    return this._serial(async () => {
      this._assertHealthy();
      const sessionId = text(input.session_id, 'session_id', { max: 2048 });
      const roleId = this._role(input.role_id).id;
      const previous = this._bindings.get(sessionId);
      const reads = [...new Set([roleId, ...strings(input.read_role_ids ?? [], 'read_role_ids')])].sort();
      for (const role of reads) this._role(role);
      const values = { session_id: sessionId, branch_id: input.branch_id ?? previous?.branch_id ?? id('branch'),
        role_id: roleId, context_id: this._context(input.context_id), read_role_ids: reads,
        read_public: input.read_public === true, allow_public: input.allow_public === true,
        policy_revision: String(input.policy_revision ?? previous?.policy_revision ?? '1') };
      if (previous && Object.keys(values).every(k => canonical(previous[k]) === canonical(values[k]))) return copy(previous);
      const binding = { ...values, binding_id: id('binding'), epoch: (previous?.epoch ?? 0) + 1 };
      await this._record('binding', { binding }, { context_id: binding.context_id });
      return copy(binding);
    });
  }
  getBinding(sessionId) { const value = this._bindings.get(sessionId); return value ? copy(value) : null; }
  _checkedBinding(binding, { user = false } = {}) {
    if (!binding) throw new MemoryError('binding_required', 'A bound role is required.');
    this._role(binding.role_id); this._context(binding.context_id);
    if (!user) {
      const current = this._bindings.get(binding.session_id);
      if (!current || current.binding_id !== binding.binding_id || current.epoch !== binding.epoch ||
          current.policy_revision !== binding.policy_revision || current.role_id !== binding.role_id ||
          current.context_id !== binding.context_id) throw new MemoryError('binding_stale', 'The original role/session binding is no longer current.');
      return current;
    }
    return { ...binding, read_role_ids: [...this._roles.keys()], read_public: true, allow_public: true };
  }
  canReadEvent(event, binding) {
    if (!this._healthy || !event || !binding || event.context_id !== binding.context_id) return false;
    const readable = new Set([binding.role_id, ...(binding.read_role_ids ?? [])]);
    return !!event.context_role_id && readable.has(event.context_role_id);
  }
  async getEvent(eventId) {
    this._assertOpen();
    const event = this._events.get(eventId);
    return event ? copy(event) : null;
  }
  async listEvents(filter = {}) {
    this._assertOpen();
    const limit = Math.max(1, Math.min(Number(filter.limit ?? 10000), 100000));
    return [...this._events.values()].filter(event =>
      (!filter.session_id || event.source?.session_id === filter.session_id) &&
      (!filter.role_id || event.context_role_id === filter.role_id) &&
      (!filter.context_id || event.context_id === filter.context_id))
      .sort((a, b) => (a.raw_seq ?? 0) - (b.raw_seq ?? 0)).slice(-limit).map(copy);
  }
  _sourceRestored(effect, ref) {
    return this._effects.some(later => later.effect_order > effect.effect_order && later.action === 'restore' &&
      (!later.restore_action_ids?.length || later.restore_action_ids.includes(effect.action_id)) &&
      (later.source_exclusions ?? []).some(selected => spanKey(selected) === spanKey(ref)));
  }
  getSourceExclusions(eventId) {
    return this._effects.flatMap(effect => ['exclude', 'withdraw'].includes(effect.action) ?
      (effect.source_exclusions ?? []).filter(ref => ref.event_id === eventId && !this._sourceRestored(effect, ref))
        .map(ref => ({ ...copy(ref), action_id: effect.action_id })) : []);
  }
  isSourceExcluded(ref) {
    if (!this._healthy) return true;
    return this.getSourceExclusions(ref.event_id).some(exclusion => overlaps(exclusion, ref));
  }
  async resolveSources(refs, binding) {
    this._assertHealthy();
    if (!Array.isArray(refs) || refs.length > 64) throw new MemoryError('invalid_sources', 'Use a bounded source list.');
    const results = [];
    for (const candidate of refs) {
      const reference = typeof candidate === 'string' ? { event_id: candidate } : candidate;
      if (!reference || typeof reference !== 'object') throw new MemoryError('invalid_source', 'A source must identify a captured event.');
      const event = this._events.get(reference.event_id);
      if (!event || !this.canReadEvent(event, binding)) throw new MemoryError('source_unavailable', 'The source is unavailable in this role/context.', { event_id: reference.event_id });
      if (!event.evidence_eligible || event.origin === 'plugin_synthetic') throw new MemoryError('synthetic_evidence', 'Synthetic or unbound material cannot certify original dialogue.');
      if (reference.text_sha256 && reference.text_sha256 !== event.text_sha256) throw new MemoryError('source_revision_conflict', 'The source fingerprint changed.');
      const bytes = Buffer.from(event.text, 'utf8');
      let start = reference.start_utf8_byte, end = reference.end_utf8_byte;
      if (start == null && end == null && reference.quote != null) {
        text(reference.quote, 'quote', { max: 1_048_576 });
        const needle = Buffer.from(reference.quote, 'utf8');
        const occurrence = reference.occurrence ?? 0;
        if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence > 1000) throw new MemoryError('invalid_quote_occurrence', 'Invalid quote occurrence.');
        start = -1; let next = 0;
        for (let count = 0; count <= occurrence; count++) {
          start = bytes.indexOf(needle, next); if (start < 0) break; next = start + Math.max(needle.length, 1);
        }
        if (start < 0) throw new MemoryError('quote_missing', 'The proposed quote does not occur in the original event.');
        end = start + needle.length;
      } else if (start == null && end == null) { start = 0; end = bytes.length; }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length || end - start > 1_048_576) {
        throw new MemoryError('invalid_source_span', 'The source range is invalid or too large.');
      }
      let quote, before, after;
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        quote = decoder.decode(bytes.subarray(start, end));
        before = decoder.decode(bytes.subarray(0, start));
        after = decoder.decode(bytes.subarray(end));
      } catch { throw new MemoryError('source_utf8_boundary', 'A source range must not split a UTF-8 character.'); }
      if (reference.quote != null && reference.quote !== quote) throw new MemoryError('quote_mismatch', 'The quote and byte range disagree.');
      const normalized = { event_id: event.event_id, text_sha256: event.text_sha256, start_utf8_byte: start, end_utf8_byte: end,
        quote, context_before: [...before].slice(-160).join(''), context_after: [...after].slice(0, 160).join(''),
        quote_check: 'quote_found', source_kind: event.origin };
      if (this.isSourceExcluded(normalized)) throw new MemoryError('source_excluded', 'This original source range is excluded.');
      results.push(normalized);
    }
    return [...new Map(results.map(ref => [spanKey(ref), ref])).values()];
  }
  _noteRestored(effect, note) {
    return this._effects.some(later => later.action === 'restore' && later.effect_order > effect.effect_order &&
      (!later.restore_action_ids?.length || later.restore_action_ids.includes(effect.action_id)) &&
      effectTargets(later).some(target => target.note_id === note.note_id && target.revision_id === note.revision_id));
  }
  _directState(note) {
    const state = { locked: false, hold: false, archived: false, excluded: false, usage_policy: 'normal', action_ids: [] };
    for (const effect of this._effects) {
      if (!effectTargets(effect).some(target => target.note_id === note.note_id)) continue;
      if (effect.action === 'lock') state.locked = true;
      if (effect.action === 'unlock') state.locked = false;
      if (effect.action === 'usage') state.usage_policy = effect.usage_policy;
      if (['withdraw', 'exclude', 'archive'].includes(effect.action) && !this._noteRestored(effect, note)) {
        state.action_ids.push(effect.action_id);
        if (effect.action === 'withdraw') state.hold = true;
        if (effect.action === 'exclude') state.excluded = true;
        if (effect.action === 'archive') state.archived = true;
      }
    }
    return state;
  }
  _dependencyBlocked(note, seen = new Set()) {
    const key = note.note_id + '|' + note.revision_id;
    if (seen.has(key)) return true;
    const next = new Set(seen); next.add(key);
    for (const ref of note.sources ?? []) {
      const event = this._events.get(ref.event_id);
      if (!event || event.text_sha256 !== ref.text_sha256 || !event.evidence_eligible || this.isSourceExcluded(ref)) return true;
      for (const ancestor of event.derived_from ?? []) {
        if (ancestor.note_id && this._blockedReference(ancestor, next)) return true;
      }
      if (event.snapshot_id) {
        const snap = this._snapshots.get(event.snapshot_id);
        if (!snap || (snap.items ?? []).some(item => this._blockedReference(item, next))) return true;
      }
    }
    for (const reference of note.derived_from ?? []) {
      if (reference.note_id && this._blockedReference(reference, next)) return true;
      if (reference.snapshot_id) {
        const snap = this._snapshots.get(reference.snapshot_id);
        if (!snap || (snap.items ?? []).some(item => this._blockedReference(item, next))) return true;
      }
    }
    return false;
  }
  _blockedReference(reference, seen) {
    const current = this._catalog.get(reference.note_id);
    if (!current || current.missing || current.revision_id !== reference.revision_id) return true;
    const state = this._directState(current);
    return state.hold || state.excluded || state.archived || state.usage_policy === 'excluded' || this._dependencyBlocked(current, seen);
  }
  isEligible(note, binding, { explicit = false } = {}) {
    if (!this._opened || !this._healthy || !note || !binding || note.context_id !== binding.context_id || note._unobserved || note._missing) return false;
    const current = this._catalog.get(note.note_id);
    if (!current || current.missing || current.revision_id !== note.revision_id || current.evidence_valid === false ||
        this._fileIssues.has(note.path) || this._fileIssues.has(path.join(this.root, current.path))) return false;
    if (note.creation_operation_id && this._operations.get(note.creation_operation_id)?.status !== 'committed') return false;
    if (note.kind === 'public' ? !binding.read_public : !new Set([binding.role_id, ...(binding.read_role_ids ?? [])]).has(note.owner_role_id)) return false;
    const state = this._directState(note);
    if (state.hold || state.excluded || state.archived || state.usage_policy === 'excluded' ||
        (!explicit && state.usage_policy === 'explicit_only')) return false;
    return !this._dependencyBlocked(note);
  }
  _decorate(note) {
    const control = this._directState(note);
    const blocked = this._healthy ? this._dependencyBlocked(note) : true;
    return { ...note, locked: control.locked, usage_policy: control.usage_policy, control,
      status: !this._healthy ? 'state_unknown' : note._missing ? 'missing' : note._unobserved ? 'unobserved' :
        control.excluded ? 'excluded' : control.hold ? 'withdrawn' : control.archived ? 'archived' :
          blocked ? 'source_unavailable' : 'active' };
  }
  _revisionPath(noteId, revision) { return path.join('修订', token(noteId, 'note_id'), revisionHex(revision) + '.md'); }
  async _readCurrent(noteId) {
    const current = this._catalog.get(noteId);
    if (!current) return null;
    let note;
    try {
      note = decodeNote(await this.io.bytes(current.path, 16_777_216), await this.io.checked(current.path));
      if (note.note_id !== noteId) throw new MemoryError('note_identity_changed', 'A note file changed its identity.');
      if (note.creation_operation_id && this._operations.get(note.creation_operation_id)?.status !== 'committed') {
        const historic = decodeNote(await this.io.bytes(this._revisionPath(noteId, current.revision_id)), await this.io.checked(current.path));
        return { ...historic, _pending_replacement: true };
      }
      note._unobserved = note.revision_id !== current.revision_id;
      return note;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        const previous = decodeNote(await this.io.bytes(this._revisionPath(noteId, current.revision_id)), await this.io.checked(current.path));
        return { ...previous, _missing: true };
      } catch (historyError) { if (historyError.code === 'ENOENT') return null; throw historyError; }
    }
  }
  async getNote(noteId, revision) {
    return this._serial(async () => {
      this._assertOpen(); token(noteId, 'note_id');
      if (revision) {
        const note = decodeNote(await this.io.bytes(this._revisionPath(noteId, revision)), this._catalog.get(noteId)?.path ?? this._revisionPath(noteId, revision));
        return this._decorate(note);
      }
      let note = await this._readCurrent(noteId);
      if (note?._unobserved && this._healthy) {
        try { await this._observeExternal(note); note = await this._readCurrent(noteId); }
        catch (error) { this._fileIssues.set(note.path, { code: error.code ?? 'external_edit_invalid', message: error.message }); }
      }
      return note ? this._decorate(note) : null;
    });
  }
  async listNotes({ role_id, context_id, includeInactive = true } = {}) {
    return this._serial(async () => {
      this._assertOpen();
      if (this._healthy) await this._reconcile();
      const result = [];
      for (const entry of this._catalog.values()) {
        if (role_id && entry.owner_role_id !== role_id) continue;
        if (context_id && entry.context_id !== context_id) continue;
        try {
          const note = await this._readCurrent(entry.note_id);
          if (!note) continue;
          const decorated = this._decorate(note);
          if (includeInactive || decorated.status === 'active') result.push(decorated);
        } catch (error) { this._fileIssues.set(entry.path, { code: error.code ?? 'note_read_failed', message: error.message }); }
      }
      return result.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    });
  }
  async _observeExternal(note) {
    this._assertHealthy();
    const old = this._catalog.get(note.note_id);
    if (old && (old.owner_role_id !== note.owner_role_id || old.author_role_id !== note.author_role_id ||
        old.context_id !== note.context_id || old.kind !== note.kind)) throw new MemoryError('note_identity_changed', 'An external edit cannot silently rebind a note.');
    this._role(note.owner_role_id); this._role(note.author_role_id); this._context(note.context_id);
    const bytes = await this.io.bytes(note.path);
    await this.io.immutable(this._revisionPath(note.note_id, note.revision_id), bytes);
    const clean = { ...note, path: this.io.relative(note.path) };
    delete clean._unobserved; delete clean._missing;
    clean.evidence_valid = true;
    try {
      const adminScope = { role_id: note.owner_role_id, context_id: note.context_id,
        read_role_ids: [...this._roles.keys()], read_public: true };
      await this.resolveSources(note.sources, adminScope);
      await this._normalizeDerived(note.derived_from, adminScope);
    } catch (error) {
      clean.evidence_valid = false;
      this._fileIssues.set(note.path, { code: error.code ?? 'external_evidence_invalid', message: error.message });
    }
    await this._record('note_observed', { notes: [clean], effects: [{
      action_id: id('action'), action: 'lock', targets: [{ note_id: note.note_id, revision_id: note.revision_id }],
      reason: 'external_unattributed', actor: 'external_unattributed'
    }] }, { actor: 'external_unattributed', context_id: note.context_id });
    if (clean.evidence_valid) this._fileIssues.delete(note.path);
  }
  async _reconcile() {
    this._assertHealthy();
    const startingSequence = this._lastSeq;
    this._fileIssues.clear();
    const folders = [{ directory: '公共', kind: 'public', owner: null }];
    for (const role of this._roles.values()) {
      folders.push({ directory: path.join(role.directory, '日记'), kind: 'diary', owner: role.id });
      folders.push({ directory: path.join(role.directory, '印象'), kind: 'impression', owner: role.id });
    }
    const seen = new Map(); const candidates = [];
    for (const scope of folders) {
      for (const file of (await this.io.walk(scope.directory)).filter(f => /\.md$/i.test(f))) {
        try {
          const note = decodeNote(await this.io.bytes(file), file);
          if (note.kind !== scope.kind || (scope.owner && note.owner_role_id !== scope.owner)) throw new MemoryError('note_path_owner', 'The note does not belong to this folder.');
          if (note.creation_operation_id && this._operations.get(note.creation_operation_id)?.status !== 'committed') continue;
          if (seen.has(note.note_id)) {
            this._fileIssues.set(file, { code: 'duplicate_note_id' });
            this._fileIssues.set(seen.get(note.note_id), { code: 'duplicate_note_id' }); seen.set(note.note_id, null); continue;
          }
          seen.set(note.note_id, file); candidates.push(note);
        } catch (error) { this._fileIssues.set(file, { code: error.code ?? 'note_invalid', message: error.message }); }
      }
    }
    for (const note of candidates) {
      if (!seen.get(note.note_id)) continue;
      const current = this._catalog.get(note.note_id);
      if (!current || current.revision_id !== note.revision_id || current.path !== this.io.relative(note.path) || current.missing) {
        try { await this._observeExternal(note); }
        catch (error) { this._fileIssues.set(note.path, { code: error.code ?? 'external_edit_invalid', message: error.message }); }
      }
    }
    for (const current of [...this._catalog.values()]) {
      if (seen.has(current.note_id) || current.missing || await this.io.exists(current.path)) continue;
      const effect = { action_id: id('action'), action: 'exclude', targets: [{ note_id: current.note_id, revision_id: '*' }],
        source_exclusions: copy(current.sources ?? []), include_known_derivatives: true, reason: 'external_file_missing', actor: 'external_unattributed' };
      await this._record('note_missing', { note_id: current.note_id, effects: [effect] }, { actor: 'external_unattributed', context_id: current.context_id });
    }
    const issues = [...this._fileIssues.entries()].map(([file, issue]) => ({ file, ...issue }));
    return { changed: this._lastSeq !== startingSequence, notes: this._catalog.size, issues, errors: issues };
  }
  async reconcile() { return this._serial(() => this._reconcile()); }
  async saveState(key, value) {
    return this._serial(async () => {
      this._assertHealthy(); text(key, 'state key', { max: 4096 });
      await this.io.jsonAtomic(path.join('状态', hash(key) + '.json'), { schema_version: 1, key, value: copy(value), updated_at: now() });
      return copy(value);
    });
  }
  async loadState(key, fallback = null) {
    this._assertOpen(); text(key, 'state key', { max: 4096 });
    const stored = await this.io.json(path.join('状态', hash(key) + '.json'), null);
    if (!stored) return copy(fallback);
    if (stored.key !== key || stored.schema_version !== 1) throw new MemoryError('state_identity_conflict', 'State file identity does not match its key.');
    return copy(stored.value);
  }
  async _loadSnapshots() {
    for (const file of (await this.io.walk('注入记录')).filter(f => f.endsWith('.json'))) {
      try {
        const snapshot = await this.io.json(file);
        if (snapshot.snapshot_id) this._snapshots.set(snapshot.snapshot_id, snapshot);
      } catch (error) { this._issue('snapshot_unreadable', { file, reason: error.code ?? error.message }); }
    }
  }
  async saveSnapshot(input) {
    return this._serial(async () => {
      this._assertHealthy();
      const snapshot = copy(input);
      snapshot.snapshot_id ??= id('snapshot'); token(snapshot.snapshot_id, 'snapshot_id');
      const previous = this._snapshots.get(snapshot.snapshot_id);
      snapshot.created_at ??= previous?.created_at ?? now(); snapshot.schema_version = 1;
      if (previous && canonical(previous) !== canonical(snapshot)) throw new MemoryError('snapshot_conflict', 'A frozen snapshot cannot be replaced.');
      if (!previous) {
        await this.io.immutable(path.join('注入记录', snapshot.created_at.slice(0, 7), snapshot.snapshot_id + '.json'), Buffer.from(JSON.stringify(snapshot, null, 2) + '\n'));
        this._snapshots.set(snapshot.snapshot_id, snapshot);
      }
      return copy(snapshot);
    });
  }
  async listSnapshots(filter = {}) {
    this._assertOpen();
    const limit = Math.min(Math.max(Number(filter.limit ?? 100), 1), 10000);
    return [...this._snapshots.values()].filter(snapshot =>
      (!filter.session_id || snapshot.session_id === filter.session_id) &&
      (!filter.binding_id || snapshot.binding_id === filter.binding_id) &&
      (!filter.snapshot_id || snapshot.snapshot_id === filter.snapshot_id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit).map(copy);
  }
  async relations(binding) {
    this._assertOpen();
    const rows = [];
    for (const relation of this._relations.values()) {
      const from = this._catalog.get(relation.from?.note_id), to = this._catalog.get(relation.to?.note_id);
      if (binding && (!from || !to || !this._canReadNote(from, binding) || !this._canReadNote(to, binding))) continue;
      let status = this._relationStates.get(relation.relation_id) ?? 'proposed';
      if (status !== 'rejected' && (!from || !to || from.revision_id !== relation.from.revision_id || to.revision_id !== relation.to.revision_id)) status = 'stale';
      rows.push({ ...copy(relation), status });
    }
    return rows;
  }
  _canReadNote(note, binding) {
    return !!note && !!binding && note.context_id === binding.context_id &&
      (note.kind === 'public' ? binding.read_public === true : new Set([binding.role_id, ...(binding.read_role_ids ?? [])]).has(note.owner_role_id));
  }
  async exportTo(destination) {
    return this._serial(async () => {
      this._assertHealthy(); await this._reconcile();
      const target = path.resolve(text(destination, 'export destination', { max: 4096 }));
      const relation = path.relative(this.root, target);
      if (!relation || (!relation.startsWith('..' + path.sep) && relation !== '..' && !path.isAbsolute(relation))) {
        throw new MemoryError('export_inside_vault', 'Export outside the live vault to avoid recursive copies.');
      }
      const exportIO = new VaultIO(target); await exportIO.initialize();
      if ((await exportIO.walk('.')).length) throw new MemoryError('export_not_empty', 'Use an empty export destination.');
      const files = [];
      for (const original of await this.io.walk('.')) {
        const relative = this.io.relative(original);
        const first = relative.split(path.sep)[0];
        if (first === '索引' || first === '暂存' || relative === path.join('控制', 'writer.lock')) continue;
        const bytes = await this.io.bytes(original, 536_870_912);
        const fingerprint = hash(bytes);
        await exportIO.immutable(relative, bytes);
        if (hash(await this.io.bytes(original, 536_870_912)) !== fingerprint) throw new MemoryError('export_changed', 'A source file changed during export.', { path: relative });
        files.push({ path: relative.split(path.sep).join('/'), sha256: fingerprint, bytes: bytes.length });
      }
      const manifest = { schema_version: 1, export_id: id('export'), vault_id: this._manifest.vault_id,
        created_at: now(), control_checkpoint: { log_seq: this._lastSeq, record_hash: this._lastHash }, files,
        omitted: ['索引', '暂存', '控制/writer.lock'], pending_operations: [...this._operations.values()].filter(x => x.status === 'prepared').map(x => x.operation_id) };
      if (manifest.pending_operations.length) throw new MemoryError('export_pending_operations', 'Resolve pending operations before exporting a committed-only backup.');
      await exportIO.jsonAtomic('export-manifest.json', manifest);
      return { destination: exportIO.root, ...manifest };
    });
  }
  health() {
    return { opened: this._opened && !this._closed, control_state: this._healthy ? 'ready' : 'blocked',
      vault_id: this._manifest?.vault_id ?? null, path: this.root, control_seq: this._lastSeq,
      events: this._events.size, notes: this._catalog.size, proposals: this._proposals.size,
      directory_fsync_supported: this.io.directorySync, issues: copy(this._issues),
      file_issues: [...this._fileIssues.entries()].map(([file, issue]) => ({ file, ...issue })) };
  }
}
Object.assign(Vault.prototype, mutations);

