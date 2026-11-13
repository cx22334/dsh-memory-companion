import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Structured errors survive the tool/HTTP boundary without exposing a stack. */
export class MemoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function id(prefix = 'id') { return `${prefix}_${randomUUID()}`; }
export function now() { return new Date().toISOString(); }

/** Canonical JSON is for fingerprints, never for changing stored source text. */
export function canonical(value) {
  const seen = new Set();
  const visit = item => {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new MemoryError('INVALID_NUMBER', 'Non-finite number');
      if (typeof item === 'bigint') return item.toString();
      return item;
    }
    if (seen.has(item)) throw new MemoryError('CYCLIC_VALUE', 'Cyclic data cannot be saved');
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map(visit)
      : Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, visit(item[key])]));
    seen.delete(item);
    return result;
  };
  return JSON.stringify(visit(value));
}

export function hash(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : canonical(value);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Conservative byte-token ceiling; model-reported usage is accounted separately. */
export function estimateTokens(text) { return Buffer.byteLength(String(text ?? ''), 'utf8'); }

/** Names are single path components. IDs are not silently renamed. */
export function safeSegment(value) {
  const name = String(value ?? '').trim();
  if (!name || name === '.' || name === '..' || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name)) {
    throw new MemoryError('INVALID_PATH_COMPONENT', 'Invalid file or directory component');
  }
  return name;
}

export async function readJSON(file, fallback = undefined) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw error; }
  try { return JSON.parse(text); }
  catch { throw new MemoryError('CORRUPT_JSON', `Invalid JSON: ${path.basename(file)}`); }
}

/** Same-directory publish; callers serialize conflicting mutations. */
export async function writeJSONAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

/** A rejected operation must not poison the queue for subsequent operations. */
export function serialQueue() {
  let tail = Promise.resolve();
  const enqueue = task => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
  enqueue.run = enqueue;
  enqueue.drain = () => tail;
  enqueue.idle = () => tail;
  return enqueue;
}

export function publicError(error) {
  return { code: error?.code || 'MEMORY_ERROR', message: error?.message || 'Memory operation failed', ...(error?.details === undefined ? {} : { details: error.details }) };
}

export function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
