import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryError, id, hash, now, canonical } from '../common.mjs';
import { NOTE_KINDS, copy, text, token, strings, validTimestamp, usage, encodeNote, decodeNote, metadata, revisionHex, spanKey } from './format.mjs';

/*
 * Rule-level porting references:
 * private_companion@38212f66de2a3629fbbac41416525fc519d0f195
 * MemoryWriter.submit/commit_pending, MemoryManagement.command,
 * RoleJournalWriter._target_current, sources.dependencies.revoke_dependants.
 * Model corrections remain proposals here; this is not an automatic fact store.
 */
const EFFECTS = new Set(['withdraw', 'exclude', 'restore', 'lock', 'unlock', 'usage', 'archive']);
const RELATION_TYPES = new Set(['claims_correction', 'claims_retraction', 'supplements', 'related']);
function targetsOf(command) {
  const targets = command.targets ?? (command.note_id ? [{ note_id: command.note_id, revision_id: command.revision_id }] : []);
  if (!Array.isArray(targets) || targets.length > 256) throw new MemoryError('invalid_targets', 'Targets must be a bounded array.');
  return targets;
}
function publicProposal(result) { return { ...copy(result), pending: true, status: 'proposed' }; }

export const mutations = {
  _noteInfo(note) {
    const info = { ...metadata(note), revision_id: note.revision_id, path: this.io.relative(note.path), evidence_valid: true };
    info.sources = (info.sources ?? []).map(({ quote, context_before, context_after, ...reference }) => reference);
    return info;
  },
  async _assertExpected(expected = []) {
    if (!Array.isArray(expected)) throw new MemoryError('invalid_expected', 'Expected revisions must be an array.');
    for (const target of expected) {
      token(target.note_id, 'note_id'); revisionHex(target.revision_id);
      const current = await this._readCurrent(target.note_id);
      if (!current || current._missing) throw new MemoryError('note_missing', 'A target note no longer exists.', { note_id: target.note_id });
      if (current._unobserved) {
        await this._observeExternal(current);
        throw new MemoryError('revision_conflict', 'An external edit was observed and locked; refresh the preview.', { note_id: target.note_id, actual: current.revision_id });
      }
      if (current.revision_id !== target.revision_id) throw new MemoryError('revision_conflict', 'The preview is based on a different revision.', { note_id: target.note_id, actual: current.revision_id });
    }
  },
  async _normalizeDerived(refs, binding) {
    if (!Array.isArray(refs) || refs.length > 128) throw new MemoryError('invalid_dependencies', 'Dependencies must be bounded.');
    const resolved = [];
    for (const reference of refs) {
      if (reference?.snapshot_id) {
        const snapshot = this._snapshots.get(reference.snapshot_id);
        if (!snapshot) throw new MemoryError('snapshot_missing', 'A dependency snapshot is unavailable.');
        for (const item of snapshot.items ?? []) if (item.note_id) {
          resolved.push(...await this._normalizeDerived([{ note_id: item.note_id, revision_id: item.revision_id }], binding));
        }
        resolved.push({ snapshot_id: reference.snapshot_id });
      } else if (reference?.note_id) {
        const note = await this._readCurrent(reference.note_id);
        if (!note || !this._canReadNote(note, binding) || note.revision_id !== reference.revision_id ||
            !this.isEligible(note, binding, { explicit: true })) {
          throw new MemoryError('dependency_unavailable', 'A referenced note is changed, excluded, or outside the read scope.', { note_id: reference.note_id });
        }
        resolved.push({ note_id: note.note_id, revision_id: note.revision_id });
      } else throw new MemoryError('invalid_dependency', 'Dependencies must identify a note revision or saved snapshot.');
    }
    return [...new Map(resolved.map(item => [canonical(item), item])).values()];
  },
  async _prepareNote(input, binding, { origin = 'self', user = false, operationId, existing = null, publicApproved = false } = {}) {
    const bound = this._checkedBinding(binding, { user });
    const kind = input.kind ?? existing?.kind ?? 'diary';
    if (!NOTE_KINDS.has(kind)) throw new MemoryError('note_kind', 'Use diary, public, or impression.');
    if (kind === 'public' && !bound.allow_public && !publicApproved) throw new MemoryError('public_requires_approval', 'Public writing requires explicit approval.');
    const role = this._role(existing?.owner_role_id ?? bound.role_id);
    const contextId = existing?.context_id ?? bound.context_id;
    if (contextId !== bound.context_id) throw new MemoryError('note_context', 'A note cannot cross contexts.');
    const sources = user && existing ? copy(existing.sources) : await this.resolveSources(input.sources ?? [], bound);
    const dependencies = user && existing ? copy(existing.derived_from) : await this._normalizeDerived(input.derived_from ?? [], bound);
    const aboutTime = validTimestamp(input.about_time ?? existing?.about_time ?? null, { day: true });
    let basis = copy(input.about_time_basis ?? existing?.about_time_basis ?? { kind: 'unknown' });
    if (aboutTime != null) {
      if (!['explicit_source_date', 'user_confirmed'].includes(basis.kind)) throw new MemoryError('about_time_unproven', 'A date needs explicit source evidence or user confirmation.');
      if (basis.kind === 'user_confirmed' && !user) throw new MemoryError('user_confirmation_required', 'The model cannot certify a user-confirmed date.');
      if (basis.kind === 'explicit_source_date' && !sources.some(source => source.event_id === basis.event_id || (basis.event_ids ?? []).includes(source.event_id))) {
        throw new MemoryError('about_time_source_missing', 'The date basis must identify a cited event.');
      }
    } else basis = { kind: 'unknown' };
    const note = {
      schema_version: 1, note_id: existing?.note_id ?? id('note'), kind, context_id: contextId,
      owner_role_id: role.id, author_role_id: existing?.author_role_id ?? bound.role_id,
      created_at: existing?.created_at ?? now(), source_time: sources.length ? this._events.get(sources[0].event_id)?.source_time ?? null : null,
      about_time: aboutTime, about_time_basis: basis, origin: existing?.origin ?? origin,
      stance: input.stance ?? existing?.stance ?? 'observation',
      tags: strings(input.tags ?? existing?.tags, 'tags'), facets: strings(input.facets ?? existing?.facets, 'facets'),
      sources, derived_from: dependencies, creation_operation_id: operationId,
      body: text(input.body, 'body', { max: 262144 })
    };
    if (!['observation', 'interpretation', 'feeling'].includes(note.stance)) throw new MemoryError('invalid_stance', 'Unknown note stance.');
    const location = existing ? this.io.relative(existing.path) :
      path.join(kind === 'public' ? '公共' : path.join(role.directory, kind === 'impression' ? '印象' : '日记'),
        note.created_at.slice(0, 7), note.note_id + '.md');
    const bytes = encodeNote(note);
    if (bytes.length > 8_388_608) throw new MemoryError('note_too_large', 'The note and source metadata exceed the storage limit.');
    const record = decodeNote(bytes, await this.io.checked(location));
    return { record, bytes, destination: location, previous_revision: existing?.revision_id ?? null, replace: !!existing };
  },
  async _lookupReplay(key, payloadHash) {
    const old = this._receipts.get(key);
    if (old) {
      if (old.payload_hash !== payloadHash) throw new MemoryError('operation_conflict', 'This idempotency key already names different content.');
      return copy(old.receipt);
    }
    const pending = [...this._operations.values()].find(operation => operation.idempotency_key === key);
    if (pending) {
      if (pending.payload_hash !== payloadHash) throw new MemoryError('operation_conflict', 'The prepared operation has different content.');
      if (pending.status === 'stale') throw new MemoryError('operation_stale', 'The previous operation needs a new preview.');
      if (pending.status === 'prepared') return this._executePrepared(await this.io.json(pending.prepared_path));
    }
    return null;
  },
  async _commitOperation({ operation_id = id('operation'), actor = 'user', context_id = null, idempotency_key,
    payload_hash, expected = [], notes = [], effects = [], proposal_id, decision, relation_updates = [], receipt = {}, binding = null }) {
    this._assertHealthy();
    if (idempotency_key) {
      const replay = await this._lookupReplay(idempotency_key, payload_hash);
      if (replay) return replay;
    }
    await this._assertExpected(expected);
    const files = [];
    for (let index = 0; index < notes.length; index++) {
      const item = notes[index];
      const staged = path.join('暂存', operation_id, String(index).padStart(4, '0') + '.bin');
      await this.io.immutable(staged, item.bytes);
      await this.io.immutable(this._revisionPath(item.record.note_id, item.record.revision_id), item.bytes);
      files.push({ destination: item.destination, staged, sha256: hash(item.bytes), replace: item.replace,
        previous_revision: item.previous_revision, note_id: item.record.note_id });
    }
    const preparedPath = path.join('暂存', operation_id, 'prepared.json');
    const spec = { schema_version: 1, operation_id, actor, context_id, idempotency_key: idempotency_key ?? null,
      payload_hash: payload_hash ?? hash(canonical(receipt)), expected, files, binding: binding ? copy(binding) : null, notes: notes.map(item => this._noteInfo(item.record)),
      effects, proposal_id: proposal_id ?? null, decision: decision ?? null, relation_updates,
      receipt: { ...receipt, operation_id }, prepared_path: preparedPath };
    await this.io.immutable(preparedPath, Buffer.from(JSON.stringify(spec, null, 2) + '\n'));
    await this._record('operation_prepared', { operation_id, idempotency_key: spec.idempotency_key, payload_hash: spec.payload_hash,
      prepared_path: preparedPath }, { actor, context_id });
    return this._executePrepared(spec);
  },
  async _executePrepared(spec) {
    this._assertHealthy();
    const prior = this._operations.get(spec.operation_id);
    if (prior?.status === 'committed') return copy(prior.receipt);
    try {
      if (spec.actor === 'role' && spec.binding) this._checkedBinding(spec.binding);
      await this._assertExpected(spec.expected);
      for (const note of spec.notes ?? []) {
        const replacement = spec.files.some(file => file.note_id === note.note_id && file.replace);
        for (const reference of note.sources ?? []) if (this.isSourceExcluded(reference) && !replacement) throw new MemoryError('source_excluded', 'Prepared content now uses an excluded source.');
      }
      for (const item of spec.files) {
        const bytes = await this.io.bytes(item.staged);
        if (hash(bytes) !== item.sha256) throw new MemoryError('staged_file_changed', 'Prepared bytes no longer match their preview.');
        if (await this.io.exists(item.destination)) {
          const currentHash = hash(await this.io.bytes(item.destination));
          if (currentHash === item.sha256) continue;
          if (!item.replace || 'sha256:' + currentHash !== item.previous_revision) throw new MemoryError('revision_conflict', 'A destination changed after the operation was prepared.');
          await this.io.atomic(item.destination, bytes);
        } else {
          if (item.replace) throw new MemoryError('note_missing', 'A target disappeared after preview.');
          await this.io.immutable(item.destination, bytes);
        }
      }
      await this._record('operation_commit', { operation_id: spec.operation_id, idempotency_key: spec.idempotency_key,
        payload_hash: spec.payload_hash, notes: spec.notes, effects: spec.effects, proposal_id: spec.proposal_id,
        decision: spec.decision, relation_updates: spec.relation_updates, receipt: spec.receipt },
      { actor: spec.actor, context_id: spec.context_id });
      // Cleanup is deliberately after commit. Failure cannot undo the committed
      // user decision, and no arbitrary recursive delete is used.
      for (const file of [...spec.files.map(item => item.staged), spec.prepared_path]) {
        try { await fs.unlink(await this.io.checked(file)); } catch (error) { if (error.code !== 'ENOENT') this._issue('operation_cleanup_pending', { operation_id: spec.operation_id }); }
      }
      try { await fs.rmdir(await this.io.checked(path.join('暂存', spec.operation_id))); } catch {}
      return copy(spec.receipt);
    } catch (error) {
      if (this._healthy && this._operations.get(spec.operation_id)?.status !== 'committed' &&
          ['revision_conflict', 'note_missing', 'staged_file_changed', 'source_excluded', 'binding_stale', 'dependency_unavailable'].includes(error.code)) {
        await this._rollbackUncommitted(spec);
        await this._record('operation_stale', { operation_id: spec.operation_id, reason: error.code ?? error.message },
          { actor: 'plugin', context_id: spec.context_id });
      }
      throw error;
    }
  },
  async _rollbackUncommitted(spec) {
    for (const item of spec.files) {
      try {
        if (!await this.io.exists(item.destination) || hash(await this.io.bytes(item.destination)) !== item.sha256) continue;
        if (item.replace && item.previous_revision) {
          const previous = await this.io.bytes(this._revisionPath(item.note_id, item.previous_revision));
          await this.io.atomic(item.destination, previous);
        } else {
          const retained = path.join('暂存', spec.operation_id, item.note_id + '.uncommitted.md');
          await this.io.immutable(retained, await this.io.bytes(item.destination));
          await fs.unlink(await this.io.checked(item.destination));
        }
      } catch (error) { this._issue('operation_rollback_conflict', { operation_id: spec.operation_id, reason: error.code ?? error.message }); }
    }
  },
  async _recoverOperations() {
    for (const operation of [...this._operations.values()]) {
      if (operation.status !== 'prepared') continue;
      try { await this._executePrepared(await this.io.json(operation.prepared_path)); }
      catch (error) {
        this._issue('operation_recovery_blocked', { operation_id: operation.operation_id, reason: error.code ?? error.message });
        if (!this._healthy) break;
      }
    }
  },
  async appendNote(input, binding, { origin = 'self', idempotencyKey, user = false } = {}) {
    return this._serial(async () => {
      this._assertHealthy();
      const bound = this._checkedBinding(binding, { user });
      if (!['self', 'backfill', 'user'].includes(origin) || (origin === 'user' && !user)) throw new MemoryError('invalid_origin', 'Only the management entry may create user-authored notes.');
      const key = 'append:' + canonical([bound.role_id, bound.context_id, bound.session_id ?? 'management', idempotencyKey ?? id('request')]);
      const payloadHash = hash(canonical({ input, origin, user, role_id: bound.role_id, context_id: bound.context_id }));
      const replay = await this._lookupReplay(key, payloadHash);
      if (replay) {
        if (replay.proposal_id) return publicProposal(replay);
        return this._decorate(decodeNote(await this.io.bytes(this._revisionPath(replay.note_id, replay.revision_id)), this._catalog.get(replay.note_id)?.path));
      }
      if (input.kind === 'public' && !bound.allow_public && !user) {
        return publicProposal(await this._propose({ kind: 'public_note', new_notes: [input], expected: [], effects: [],
          reason: 'A role requested a public entry without public-write authorization.' }, bound, { key, payloadHash }));
      }
      const operationId = id('operation');
      const prepared = await this._prepareNote(input, bound, { origin, user, operationId });
      const receipt = { note_id: prepared.record.note_id, revision_id: prepared.record.revision_id };
      await this._commitOperation({ operation_id: operationId, actor: user ? 'user' : 'role', context_id: bound.context_id,
        idempotency_key: key, payload_hash: payloadHash, notes: [prepared], receipt, binding: bound });
      return this._decorate(prepared.record);
    });
  },
  async editNote(noteId, expectedRevision, body, patch = {}) {
    return this._serial(async () => {
      this._assertHealthy();
      const editHash = hash(canonical({ noteId, expectedRevision, body, patch }));
      if (patch.idempotencyKey) {
        const replay = await this._lookupReplay('edit:' + patch.idempotencyKey, editHash);
        if (replay) return this._decorate(decodeNote(await this.io.bytes(this._revisionPath(replay.note_id, replay.revision_id)), this._catalog.get(replay.note_id)?.path));
      }
      await this._assertExpected([{ note_id: noteId, revision_id: expectedRevision }]);
      const allowed = new Set(['tags', 'facets', 'stance', 'about_time', 'about_time_basis', 'reason', 'idempotencyKey']);
      for (const field of Object.keys(patch)) if (!allowed.has(field)) throw new MemoryError('edit_identity_forbidden', 'This edit cannot change note identity or sources.', { field });
      const previous = await this._readCurrent(noteId);
      const binding = { role_id: previous.owner_role_id, context_id: previous.context_id, read_role_ids: [...this._roles.keys()], read_public: true, allow_public: true };
      const operationId = id('operation');
      const prepared = await this._prepareNote({ ...metadata(previous), ...patch, body }, binding, {
        origin: previous.origin, user: true, operationId, existing: previous });
      const effect = { action_id: id('action'), actor: 'user', action: 'lock', targets: [{ note_id: noteId, revision_id: prepared.record.revision_id }],
        reason: patch.reason ?? 'User edited this note.' };
      const receipt = { note_id: noteId, revision_id: prepared.record.revision_id };
      await this._commitOperation({ operation_id: operationId, actor: 'user', context_id: previous.context_id,
        expected: [{ note_id: noteId, revision_id: expectedRevision }], notes: [prepared], effects: [effect], receipt,
        idempotency_key: patch.idempotencyKey ? 'edit:' + patch.idempotencyKey : null,
        payload_hash: editHash });
      return this._decorate(prepared.record);
    });
  },
  async _validateRelation(input, binding) {
    if (!input || !RELATION_TYPES.has(input.type)) throw new MemoryError('relation_type', 'Unsupported relation type.');
    for (const endpoint of [input.from, input.to]) {
      if (!endpoint) throw new MemoryError('relation_endpoint', 'A relation needs two explicit note revisions.');
      const note = await this._readCurrent(endpoint.note_id);
      if (!note || note.revision_id !== endpoint.revision_id || !this._canReadNote(note, binding)) {
        throw new MemoryError('relation_stale', 'The relation endpoint is changed or outside the role/context.');
      }
    }
    if (input.from.note_id === input.to.note_id && input.from.revision_id === input.to.revision_id) throw new MemoryError('relation_self', 'A revision cannot correct itself.');
    return { schema_version: 1, relation_id: id('relation'), context_id: binding.context_id, type: input.type,
      from: copy(input.from), to: copy(input.to), scope: input.scope ?? 'whole_revision', initial_status: 'proposed',
      proposed_by_role_id: binding.role_id, reason: text(input.reason ?? '', 'relation reason', { max: 16384, empty: true }),
      evidence_event_ids: strings(input.evidence_event_ids ?? [], 'evidence_event_ids'), created_at: now() };
  },
  async propose(payload, binding) {
    return this._serial(async () => {
      this._assertHealthy();
      const bound = binding ? this._checkedBinding(binding, { user: !binding.binding_id }) : this._managementBindingFor(payload);
      return this._propose(payload, bound);
    });
  },
  _managementBindingFor(payload) {
    const roleId = payload.owner_role_id ?? payload.author_role_id ?? this._catalog.get(payload.expected?.[0]?.note_id)?.owner_role_id;
    if (!roleId) throw new MemoryError('proposal_role_required', 'A management proposal needs an explicit owner or target.');
    return { role_id: this._role(roleId).id, context_id: this._context(payload.context_id),
      read_role_ids: [...this._roles.keys()], read_public: true, allow_public: true };
  },
  async _propose(payload, binding, { key, payloadHash } = {}) {
    this._assertHealthy();
    text(payload.kind ?? 'change', 'proposal kind', { max: 128 });
    key ??= payload.idempotency_key ? 'proposal:' + canonical([binding.role_id, binding.context_id, payload.idempotency_key]) : null;
    payloadHash ??= hash(canonical(payload));
    if (key) {
      const receipt = this._receipts.get(key);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new MemoryError('operation_conflict', 'The proposal key names different content.');
        return copy(this._proposals.get(receipt.receipt.proposal_id) ?? receipt.receipt);
      }
    }
    const expected = copy(payload.expected ?? []);
    await this._assertExpected(expected);
    for (const reference of expected) {
      if (!this._canReadNote(this._catalog.get(reference.note_id), binding)) throw new MemoryError('proposal_scope', 'A target is outside the role/context.');
    }
    if (!Array.isArray(payload.new_notes ?? []) || (payload.new_notes ?? []).length > 128) throw new MemoryError('proposal_size', 'Too many proposed notes.');
    const newNotes = [];
    for (const note of payload.new_notes ?? []) {
      const sources = await this.resolveSources(note.sources ?? [], binding);
      const derived = await this._normalizeDerived(note.derived_from ?? [], binding);
      if (!NOTE_KINDS.has(note.kind ?? 'diary')) throw new MemoryError('note_kind', 'Unsupported proposed note kind.');
      newNotes.push({ kind: note.kind ?? 'diary', body: text(note.body, 'body', { max: 262144 }), stance: note.stance ?? 'observation',
        tags: strings(note.tags, 'tags'), facets: strings(note.facets, 'facets'), sources, derived_from: derived,
        about_time: note.about_time ?? null, about_time_basis: note.about_time_basis ?? { kind: 'unknown' } });
    }
    const effects = copy(payload.effects ?? []);
    if (!Array.isArray(effects) || effects.length > 256) throw new MemoryError('proposal_size', 'Too many proposed effects.');
    for (const effect of effects) {
      if (!EFFECTS.has(effect.action) || ['restore', 'unlock'].includes(effect.action)) throw new MemoryError('proposal_effect', 'Models cannot propose unlocking or restoring an excluded memory through a generic change.');
      for (const target of targetsOf(effect)) {
        if (!expected.some(item => item.note_id === target.note_id && item.revision_id === target.revision_id)) {
          throw new MemoryError('proposal_precondition_missing', 'Every effect needs an explicit preview revision.');
        }
      }
    }
    const relation = payload.relation ? await this._validateRelation(payload.relation, binding) : null;
    if (relation) for (const endpoint of [relation.from, relation.to]) {
      if (!expected.some(item => item.note_id === endpoint.note_id && item.revision_id === endpoint.revision_id)) expected.push(copy(endpoint));
    }
    const proposal = { schema_version: 1, proposal_id: id('proposal'), kind: payload.kind ?? 'change',
      context_id: binding.context_id, author_role_id: binding.role_id, binding: copy(binding), initial_status: 'proposed',
      created_at: now(), expected, new_notes: newNotes, effects, reason: text(payload.reason ?? '', 'reason', { max: 16384, empty: true }),
      relation_id: relation?.relation_id ?? null };
    proposal.proposal_hash = hash(canonical(proposal));
    const proposalPath = path.join('提议', proposal.proposal_id + '.json');
    await this.io.immutable(proposalPath, Buffer.from(JSON.stringify(proposal, null, 2) + '\n'));
    if (relation) await this.io.immutable(path.join('关系', relation.relation_id + '.json'), Buffer.from(JSON.stringify(relation, null, 2) + '\n'));
    const receipt = { proposal_id: proposal.proposal_id, proposal_hash: proposal.proposal_hash };
    await this._record('proposal_registered', { proposal: { ...proposal, path: proposalPath, status: 'proposed' }, relation,
      idempotency_key: key, payload_hash: payloadHash, receipt }, { actor: 'role', context_id: binding.context_id });
    return copy(this._proposals.get(proposal.proposal_id));
  },
  async listProposals() {
    this._assertOpen();
    return [...this._proposals.values()].map(proposal => {
      let status = proposal.status ?? 'proposed';
      if (status === 'proposed' && proposal.expected.some(target => this._catalog.get(target.note_id)?.revision_id !== target.revision_id)) status = 'stale';
      return { ...copy(proposal), status };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async _normalizeEffect(command, { allowHistoric = false } = {}) {
    if (!EFFECTS.has(command.action)) throw new MemoryError('unknown_action', 'Unsupported management action.');
    const targets = [];
    for (const input of targetsOf(command)) {
      token(input.note_id, 'note_id');
      const current = await this._readCurrent(input.note_id);
      if (!current) throw new MemoryError('note_missing', 'The target note is unavailable.', { note_id: input.note_id });
      const revision = input.revision_id ?? current.revision_id;
      if (revision !== '*') revisionHex(revision);
      if (revision === '*' && command.action !== 'exclude') throw new MemoryError('explicit_revision_required', 'This action needs a specific revision.');
      if (!allowHistoric && revision !== '*' && current.revision_id !== revision) throw new MemoryError('revision_conflict', 'Refresh the preview before applying this action.');
      if (allowHistoric && revision !== '*' && current.revision_id !== revision) await this.io.bytes(this._revisionPath(input.note_id, revision));
      const target = { note_id: input.note_id, revision_id: revision };
      if (input.body_spans != null) {
        const snapshot = revision === current.revision_id ? current :
          decodeNote(await this.io.bytes(this._revisionPath(input.note_id, revision)), current.path);
        const bytes = Buffer.from(snapshot.body, 'utf8');
        if (!Array.isArray(input.body_spans) || !input.body_spans.length) throw new MemoryError('invalid_body_spans', 'Select explicit body ranges.');
        target.body_spans = input.body_spans.map(span => {
          const start = span.start_utf8_byte, end = span.end_utf8_byte;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length) throw new MemoryError('invalid_body_spans', 'The selected body range is invalid.');
          try {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            decoder.decode(bytes.subarray(0, start)); decoder.decode(bytes.subarray(start, end)); decoder.decode(bytes.subarray(end));
          } catch { throw new MemoryError('body_utf8_boundary', 'Body selection splits a UTF-8 character.'); }
          return { start_utf8_byte: start, end_utf8_byte: end };
        });
      }
      targets.push(target);
    }
    const sourceExclusions = [];
    for (const reference of command.source_exclusions ?? []) {
      const event = this._events.get(reference.event_id);
      if (!event) throw new MemoryError('source_missing', 'An exclusion source is unavailable.');
      const bytes = Buffer.from(event.text, 'utf8');
      const start = reference.start_utf8_byte ?? 0, end = reference.end_utf8_byte ?? bytes.length;
      if (reference.text_sha256 && reference.text_sha256 !== event.text_sha256) throw new MemoryError('source_revision_conflict', 'The exclusion refers to a changed event.');
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length) throw new MemoryError('invalid_source_span', 'Invalid exclusion source range.');
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        decoder.decode(bytes.subarray(0, start)); decoder.decode(bytes.subarray(start, end)); decoder.decode(bytes.subarray(end));
      } catch { throw new MemoryError('source_utf8_boundary', 'Exclusion must preserve UTF-8 boundaries.'); }
      sourceExclusions.push({ event_id: event.event_id, text_sha256: event.text_sha256, start_utf8_byte: start, end_utf8_byte: end });
    }
    if (!targets.length && !sourceExclusions.length) throw new MemoryError('action_targets_required', 'Select notes or exact source ranges.');
    const effect = { action_id: id('action'), action: command.action, actor: 'user', targets, source_exclusions: sourceExclusions,
      include_known_derivatives: command.include_known_derivatives !== false,
      reason: text(command.reason ?? '', 'reason', { max: 16384, empty: true }), created_at: now() };
    if (command.action === 'usage') effect.usage_policy = usage(command.usage_policy);
    if (command.action === 'withdraw') effect.recall_hold_note_ids = targets.map(target => target.note_id);
    if (command.action === 'restore') {
      effect.restore_action_ids = strings(command.restore_action_ids ?? [], 'restore_action_ids', 256);
      for (const selected of effect.restore_action_ids) {
        if (!this._effects.some(old => old.action_id === selected)) throw new MemoryError('restore_action_missing', 'A selected exclusion action no longer exists.');
      }
    }
    return effect;
  },
  async action(command) {
    return this._serial(async () => {
      this._assertHealthy();
      const actionKey = command.idempotencyKey ?? command.operation_key;
      const actionHash = hash(canonical(command));
      if (actionKey) {
        const replay = await this._lookupReplay('action:' + actionKey, actionHash);
        if (replay) return replay;
      }
      const effect = await this._normalizeEffect(command, { allowHistoric: command.action === 'withdraw' });
      const operationId = id('operation');
      const preparedNotes = []; const effects = [effect]; const expected = [];
      for (const target of effect.targets) {
        const current = await this._readCurrent(target.note_id);
        if (current._unobserved) { await this._observeExternal(current); throw new MemoryError('revision_conflict', 'External changes were locked; refresh the preview.'); }
        expected.push({ note_id: target.note_id, revision_id: current.revision_id });
      }
      if (command.approved_body != null) {
        if (command.action !== 'withdraw' || effect.targets.length !== 1) throw new MemoryError('approved_body_scope', 'An approved full body requires exactly one withdrawal target.');
        const previous = await this._readCurrent(effect.targets[0].note_id);
        const binding = { role_id: previous.owner_role_id, context_id: previous.context_id, read_role_ids: [...this._roles.keys()], read_public: true, allow_public: true };
        const prepared = await this._prepareNote({ ...metadata(previous), body: command.approved_body }, binding, { user: true, operationId, existing: previous, origin: previous.origin });
        preparedNotes.push(prepared);
        effects.push({ action_id: id('action'), action: 'restore', actor: 'user',
          targets: [{ note_id: previous.note_id, revision_id: prepared.record.revision_id }],
          restore_action_ids: [effect.action_id], source_exclusions: [], reason: 'User approved this complete readable replacement.', created_at: now() });
        effects.push({ action_id: id('action'), action: 'lock', actor: 'user',
          targets: [{ note_id: previous.note_id, revision_id: prepared.record.revision_id }], reason: 'User-approved readable replacement.' });
      }
      return this._commitOperation({ operation_id: operationId, actor: 'user',
        context_id: effect.targets.length ? this._catalog.get(effect.targets[0].note_id)?.context_id ?? null : null,
        expected, notes: preparedNotes, effects,
        idempotency_key: actionKey ? 'action:' + actionKey : null, payload_hash: actionHash,
        receipt: { action_id: effect.action_id, action: effect.action, targets: effect.targets,
          replacement_revision: preparedNotes[0]?.record.revision_id ?? null, status: 'committed' } });
    });
  },
  async decide(proposalId, decision, expected) {
    return this._serial(async () => {
      this._assertHealthy();
      if (!['approve', 'reject'].includes(decision)) throw new MemoryError('invalid_decision', 'Choose approve or reject.');
      const proposal = this._proposals.get(proposalId);
      if (!proposal) throw new MemoryError('proposal_missing', 'The proposal is unavailable.');
      if (expected != null && (typeof expected === 'string' ? expected !== proposal.proposal_hash : canonical(expected) !== canonical(proposal.expected))) {
        throw new MemoryError('proposal_preview_changed', 'The approved preview does not match the saved proposal.');
      }
      const key = 'decision:' + proposalId;
      const payloadHash = hash(canonical([proposal.proposal_hash, decision]));
      const replay = await this._lookupReplay(key, payloadHash);
      if (replay) return replay;
      if (decision === 'reject') return this._commitOperation({ actor: 'user', context_id: proposal.context_id, idempotency_key: key,
        payload_hash: payloadHash, proposal_id: proposalId, decision,
        relation_updates: proposal.relation_id ? [{ relation_id: proposal.relation_id, status: 'rejected' }] : [],
        receipt: { proposal_id: proposalId, decision, status: 'rejected' } });
      if (proposal.status === 'stale') throw new MemoryError('proposal_stale', 'Create a fresh preview before approval.');
      try {
        await this._assertExpected(proposal.expected);
        const binding = this._checkedBinding(proposal.binding, { user: !proposal.binding.binding_id });
        const operationId = id('operation');
        const notes = [];
        for (const input of proposal.new_notes) notes.push(await this._prepareNote(input, binding, {
          operationId, origin: 'backfill', user: true, publicApproved: true }));
        const effects = [];
        for (const command of proposal.effects) effects.push(await this._normalizeEffect(command));
        // Relation approval alone never withdraws anything: an explicit saved
        // effect must have appeared in the user-approved preview.
        return await this._commitOperation({ operation_id: operationId, actor: 'user', context_id: proposal.context_id,
          expected: proposal.expected, notes, effects, proposal_id: proposalId, decision,
          relation_updates: proposal.relation_id ? [{ relation_id: proposal.relation_id, status: 'confirmed' }] : [],
          idempotency_key: key, payload_hash: payloadHash,
          receipt: { proposal_id: proposalId, decision, status: 'approved', note_ids: notes.map(item => item.record.note_id) } });
      } catch (error) {
        if (this._healthy && ['revision_conflict', 'binding_stale', 'source_excluded', 'dependency_unavailable', 'note_missing'].includes(error.code)) {
          await this._record('proposal_stale', { proposal_id: proposalId, reason: error.code }, { actor: 'plugin', context_id: proposal.context_id });
        }
        throw error;
      }
    });
  }
};

