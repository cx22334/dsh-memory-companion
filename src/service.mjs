import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeConfig, publicConfig, managementAccessPath } from './config.mjs';
import { Vault } from './vault.mjs';
import { IndexEngine } from './index-engine.mjs';
import { RecallService } from './recall.mjs';
import { GoogleEmbedding, ChatProvider } from './providers.mjs';
import { DiaryService } from './diary.mjs';
import { startManagement } from './management.mjs';
import { publicError, readJSON, writeJSONAtomic } from './common.mjs';

/** Compose the file authority, replaceable index and user-only administration. */
export async function createMemoryService(input = {}) {
  const config = normalizeConfig(input);
  const vault = new Vault(config);
  await vault.open();
  const embedding = new GoogleEmbedding(config.google);
  const chat = new ChatProvider(config.chat);
  const index = new IndexEngine(config, { vault, embedding });
  const recall = new RecallService(config, { vault, index });
  const errors = [];
  let closed = false, reconciling = false, timer;
  const rememberError = error => {
    errors.push({ at: new Date().toISOString(), ...publicError(error) });
    if (errors.length > 30) errors.shift();
  };
  const diary = new DiaryService(config, { vault, chat, onChanged: () => index.invalidate() });
  // These are our own service methods, not patched DSH methods. Read APIs are untouched.
  for (const name of ['appendNote', 'editNote', 'action', 'decide']) {
    const implementation = vault[name].bind(vault);
    vault[name] = async (...args) => {
      const result = await implementation(...args);
      index.invalidate();
      if (name !== 'appendNote') recall.invalidate();
      return result;
    };
  }
  const reconcile = vault.reconcile.bind(vault);
  vault.reconcile = async (...args) => {
    const result = await reconcile(...args);
    if (result?.changed) { index.invalidate(); recall.invalidate(); }
    return result;
  };
  const service = {
    config, vault, embedding, chat, index, recall, diary, management: null,
    health() {
      return {
        version: '1.0.0-dev.2', status: closed ? 'closed' : 'open', config: publicConfig(config),
        vault: vault.health(), index: index.health(), diary: diary.health(),
        errors: errors.slice(), executionEvidence: 'not-tested-during-development'
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      const failures = [];
      for (const dispose of [() => service.management?.close(), () => diary.stop(), () => index.close(), () => vault.close()]) {
        try { await dispose(); } catch (error) { failures.push(error); }
      }
      if (service.management) {
        try {
          const access = await readJSON(managementAccessPath(config), null);
          if (access?.pid === process.pid && access?.url === service.management.url) await fs.unlink(managementAccessPath(config));
        } catch (error) { if (error.code !== 'ENOENT') failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Memory shutdown did not finish cleanly');
    }
  };
  try {
    try { await index.open(); } catch (error) { rememberError(error); }
    service.management = await startManagement(service);
    if (service.management) {
      const accessFile = managementAccessPath(config);
      await fs.mkdir(path.dirname(accessFile), { recursive: true, mode: 0o700 });
      await writeJSONAtomic(accessFile, { pid: process.pid, url: service.management.url, created_at: new Date().toISOString() });
    }
    if (config.diary.enabled) diary.start();
    timer = setInterval(async () => {
      if (closed || reconciling) return;
      reconciling = true;
      try { await vault.reconcile(); } catch (error) { rememberError(error); }
      finally { reconciling = false; }
    }, 5000);
    timer.unref();
    return service;
  } catch (error) {
    try { await service.close(); } catch (closeError) { rememberError(closeError); }
    throw error;
  }
}
