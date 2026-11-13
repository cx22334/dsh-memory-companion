import { parseDocument, stringify } from 'yaml';
import { MemoryError, hash } from '../common.mjs';

export const NOTE_KINDS = new Set(['diary', 'public', 'impression']);
export const META_FIELDS = [
  'schema_version', 'note_id', 'kind', 'context_id', 'owner_role_id', 'author_role_id',
  'created_at', 'source_time', 'about_time', 'about_time_basis', 'origin', 'stance',
  'tags', 'facets', 'sources', 'derived_from', 'creation_operation_id'
];
export const SOURCE_LIMIT = 1_048_576;

export function copy(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new MemoryError('invalid_json_value', 'The value must be finite, serializable JSON.'); }
}
export function text(value, field, { max = 4096, empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) {
    throw new MemoryError('invalid_field', 'Invalid ' + field + '.', { field });
  }
  return value;
}
export function token(value, field = 'identifier') {
  text(value, field, { max: 256 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value === '.' || value === '..') {
    throw new MemoryError('invalid_identifier', 'Unsafe ' + field + '.', { field });
  }
  return value;
}
export function strings(value, field, max = 64) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new MemoryError('invalid_field', field + ' must be a bounded array.');
  return [...new Set(value.map(item => text(item, field, { max: 256 })))];
}
export function validTimestamp(value, { optional = true, day = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || (day && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Number.isNaN(Date.parse(value)) :
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value)))) {
    throw new MemoryError('invalid_timestamp', 'Use an explicit ISO timestamp with an offset, a date where allowed, or null.');
  }
  return value;
}
export function usage(value) {
  const selected = typeof value === 'object' && value ? value.mode : value;
  const mode = ({ explicit: 'explicit_only', never: 'excluded', default: 'normal' })[selected] ?? selected ?? 'normal';
  if (!['normal', 'prefer_when_relevant', 'explicit_only', 'excluded'].includes(mode)) {
    throw new MemoryError('invalid_usage_policy', 'Unknown usage policy.');
  }
  return mode;
}
export function metadata(input) {
  const result = {};
  for (const key of META_FIELDS) if (input[key] !== undefined) result[key] = copy(input[key]);
  return result;
}
export function encodeNote(note) {
  const meta = metadata(note);
  return Buffer.from('---\n' + stringify(meta, { version: '1.2', schema: 'core', lineWidth: 0, aliasDuplicateObjects: false }) +
    '---\n' + text(note.body, 'body', { max: 262144, empty: false }), 'utf8');
}
export function decodeNote(bytes, filePath) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw new MemoryError('note_encoding', 'A note must be UTF-8.', { path: filePath }); }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new MemoryError('note_frontmatter', 'A note needs YAML front matter and a Markdown body.', { path: filePath });
  const doc = parseDocument(match[1], { version: '1.2', schema: 'core', uniqueKeys: true, strict: true, customTags: [] });
  if (doc.errors.length || doc.warnings.length) throw new MemoryError('note_frontmatter', 'Invalid or unsupported YAML front matter.', { path: filePath });
  let meta;
  try { meta = doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new MemoryError('note_frontmatter', 'Aliases and recursive YAML are not supported.', { path: filePath }); }
  if (!meta || Array.isArray(meta) || typeof meta !== 'object' || meta.schema_version !== 1) {
    throw new MemoryError('note_schema', 'Unsupported note schema.', { path: filePath });
  }
  for (const key of Object.keys(meta)) if (!META_FIELDS.includes(key)) {
    throw new MemoryError('note_metadata_unknown', 'Unknown note metadata: ' + key, { path: filePath });
  }
  token(meta.note_id, 'note_id'); token(meta.owner_role_id, 'owner_role_id');
  token(meta.author_role_id, 'author_role_id'); token(meta.context_id, 'context_id');
  if (!NOTE_KINDS.has(meta.kind)) throw new MemoryError('note_kind', 'Unsupported note kind.', { path: filePath });
  if (!Array.isArray(meta.sources) || !Array.isArray(meta.derived_from)) throw new MemoryError('note_schema', 'sources and derived_from must be arrays.');
  strings(meta.tags, 'tags'); strings(meta.facets, 'facets');
  return { ...meta, body: match[2], revision_id: 'sha256:' + hash(raw), path: filePath };
}
export function revisionHex(revision) {
  if (typeof revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(revision)) {
    throw new MemoryError('invalid_revision', 'Expected a SHA-256 content revision.');
  }
  return revision.slice(7);
}
export function spanKey(ref) {
  return [ref.event_id, ref.text_sha256 ?? '', ref.start_utf8_byte ?? '*', ref.end_utf8_byte ?? '*'].join('|');
}
export function overlaps(a, b) {
  return a.event_id === b.event_id &&
    (!a.text_sha256 || !b.text_sha256 || a.text_sha256 === b.text_sha256) &&
    (a.start_utf8_byte == null || b.start_utf8_byte == null ||
      Math.max(a.start_utf8_byte, b.start_utf8_byte) < Math.min(a.end_utf8_byte, b.end_utf8_byte));
}

