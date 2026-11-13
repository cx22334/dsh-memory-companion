import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryError, id } from '../common.mjs';

export class VaultIO {
  constructor(root) { this.root = path.resolve(root); this.directorySync = null; }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    this.root = await fs.realpath(this.root);
  }
  relative(file) {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.root, file);
    const rel = path.relative(this.root, absolute);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new MemoryError('path_outside_vault', 'The path is outside the vault.');
    }
    return rel;
  }
  async checked(file) {
    const rel = this.relative(file);
    let current = this.root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new MemoryError('vault_symlink', 'Symlinks are not accepted inside the vault.', { path: current });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return path.join(this.root, rel);
  }
  async mkdir(file) {
    const full = await this.checked(file);
    await fs.mkdir(full, { recursive: true, mode: 0o700 });
    await this.checked(full);
    return full;
  }
  async exists(file) {
    try { await fs.stat(await this.checked(file)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async bytes(file, limit = 16_777_216) {
    const full = await this.checked(file);
    const stat = await fs.stat(full);
    if (!stat.isFile() || stat.size > limit) throw new MemoryError('vault_file_size', 'Not a regular bounded vault file.', { path: full });
    return fs.readFile(full);
  }
  async json(file, fallback) {
    try { return JSON.parse((await this.bytes(file)).toString('utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' && arguments.length > 1) return fallback;
      if (error instanceof SyntaxError) throw new MemoryError('invalid_json_file', 'A vault JSON file is invalid.', { path: file });
      throw error;
    }
  }
  async syncDirectory(directory) {
    let handle;
    try { handle = await fs.open(directory, 'r'); await handle.sync(); this.directorySync = true; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
      this.directorySync = false;
    } finally { await handle?.close(); }
  }
  async atomic(file, bytes) {
    const destination = await this.checked(file);
    await this.mkdir(path.dirname(destination));
    const temporary = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + id('tmp') + '.tmp');
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, destination);
      await this.syncDirectory(path.dirname(destination));
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    return destination;
  }
  async jsonAtomic(file, value) { return this.atomic(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')); }
  async immutable(file, bytes) {
    const destination = await this.checked(file);
    await this.mkdir(path.dirname(destination));
    let handle;
    try {
      handle = await fs.open(destination, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await this.syncDirectory(path.dirname(destination));
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.bytes(destination, Math.max(bytes.length, 16_777_216));
      if (!existing.equals(Buffer.from(bytes))) throw new MemoryError('immutable_collision', 'An immutable file already has different content.', { path: destination });
    }
    return destination;
  }
  async append(file, bytes) {
    const destination = await this.checked(file);
    await this.mkdir(path.dirname(destination));
    const handle = await fs.open(destination, 'a', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    return destination;
  }
  async walk(directory) {
    const base = await this.checked(directory);
    const result = [];
    let entries;
    try { entries = await fs.readdir(base, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(base, entry.name);
      if (entry.isSymbolicLink()) throw new MemoryError('vault_symlink', 'A vault directory contains a symlink.', { path: full });
      if (entry.isDirectory()) result.push(...await this.walk(full));
      else if (entry.isFile()) result.push(full);
    }
    return result;
  }
}

