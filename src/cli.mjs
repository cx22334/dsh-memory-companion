#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeConfig, managementAccessPath } from './config.mjs';
import { readJSON, writeJSONAtomic, MemoryError, publicError, safeSegment, within } from './common.mjs';

const HELP = `DSH Memory Companion

  node src/cli.mjs init --config memory.config.json --vault <directory> --role <alias>
  node src/cli.mjs serve --config memory.config.json
  node src/cli.mjs open --config memory.config.json
  node src/cli.mjs status --config memory.config.json
  node src/cli.mjs export --config memory.config.json --destination <new-directory>
  node src/cli.mjs restore --source <export-directory> --destination <new-directory>
  node src/cli.mjs rebuild --config memory.config.json --role <role-id>

serve opens the local administration endpoint, not the DSH application.
No command installs the plugin, changes DSH source, or contacts a model unless
the requested background job/index operation needs that configured provider.
Restore always creates an isolated copy; it never overwrites an existing vault.
`;

async function copyIsolated(source, destination) {
  const src = await fs.realpath(source);
  const dest = path.resolve(destination);
  if (within(src, dest)) throw new MemoryError('RESTORE_IN_SOURCE', '恢复目录不能在来源目录内');
  try { await fs.lstat(dest); throw new MemoryError('DESTINATION_EXISTS', '恢复只允许创建新目录，不能覆盖现有库'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = await readJSON(path.join(src, 'vault.json'));
  if (manifest.schema_version !== 1) throw new MemoryError('UNSUPPORTED_SCHEMA', '只接受格式 v1；未知格式不自动转换');
  const scan = async directory => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new MemoryError('SYMLINK_IN_BACKUP', '备份中包含符号链接，拒绝自动恢复');
      if (item.isDirectory()) await scan(path.join(directory, item.name));
      else if (!item.isFile()) throw new MemoryError('SPECIAL_FILE_IN_BACKUP', '备份中包含非普通文件');
    }
  };
  await scan(src);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false, dereference: false });
  return { destination: dest, vault_id: manifest.vault_id, status: 'isolated_copy', next: '用新配置打开此副本；控制状态有损坏时会保护性停用。原库不变。' };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, vault: { type: 'string' }, role: { type: 'string' },
    source: { type: 'string' }, destination: { type: 'string' }, help: { type: 'boolean', short: 'h' }
  } });
  const command = positionals[0] || 'help';
  if (values.help || command === 'help') { process.stdout.write(HELP); return; }
  if (command === 'restore') {
    if (!values.source || !values.destination) throw new MemoryError('MISSING_ARGUMENT', 'restore 需要 --source 和 --destination');
    process.stdout.write(`${JSON.stringify(await copyIsolated(values.source, values.destination), null, 2)}\n`);
    return;
  }
  const configPath = path.resolve(values.config || 'memory.config.json');
  if (command === 'init') {
    const role = safeSegment(values.role || 'companion');
    if (!/^[a-z][a-z0-9_]*$/u.test(role)) throw new MemoryError('INVALID_ROLE_ALIAS', '--role 使用小写字母、数字和下划线');
    try { await fs.lstat(configPath); throw new MemoryError('CONFIG_EXISTS', '配置已存在，不自动覆盖'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = normalizeConfig({ vaultPath: values.vault, roles: [{ id: role, alias: role, name: role, directory: role }] });
    await writeJSONAtomic(configPath, config);
    const placeholder = '{{mem_self_' + role + '}}';
    process.stdout.write(`已创建 ${configPath}\n在人设中声明 ${placeholder}，按需加 {{mem_public}}。\n`);
    return;
  }
  if (!['serve', 'open', 'status', 'export', 'rebuild'].includes(command)) throw new MemoryError('UNKNOWN_COMMAND', `未知命令 ${command}`);
  const supplied = await readJSON(configPath);
  if (command === 'open') {
    const access = await readJSON(managementAccessPath(normalizeConfig(supplied)), null);
    if (!access?.url) throw new MemoryError('MANAGEMENT_NOT_RUNNING', '管理服务尚未启动，或已关闭');
    process.stdout.write(`记忆管理：${access.url}\n请只在用户浏览器打开；若进程异常退出，请重启插件后再取新链接。\n`);
    return;
  }
  const input = command === 'serve' ? supplied : { ...supplied, diary: { ...supplied.diary, enabled: false }, management: { ...supplied.management, enabled: false } };
  const { createMemoryService } = await import('./service.mjs');
  const service = await createMemoryService(input);
  if (command === 'serve') {
    process.stdout.write(service.management ? `记忆管理：${service.management.url}\n请只在用户浏览器打开，不将含令牌链接交给模型。\n` : '管理界面已禁用。\n');
    const shutdown = async () => { try { await service.close(); process.exitCode = 0; } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  try {
    if (command === 'status') process.stdout.write(`${JSON.stringify(service.health(), null, 2)}\n`);
    if (command === 'export') {
      if (!values.destination) throw new MemoryError('MISSING_ARGUMENT', 'export 需要 --destination');
      process.stdout.write(`${JSON.stringify(await service.vault.exportTo(path.resolve(values.destination)), null, 2)}\n`);
    }
    if (command === 'rebuild') {
      const role = service.config.roles.find(item => item.id === values.role);
      if (!role) throw new MemoryError('UNKNOWN_ROLE', 'rebuild 需要配置中的 --role');
      const binding = await service.vault.bind({ session_id: `cli-rebuild:${role.id}:${service.config.contextId}`, role_id: role.id, context_id: service.config.contextId, read_role_ids: [role.id], read_public: true, policy_revision: 'cli-own-role' });
      process.stdout.write(`${JSON.stringify(await service.index.rebuild(binding), null, 2)}\n`);
    }
  } finally { await service.close(); }
}

main().catch(error => { process.stderr.write(`${JSON.stringify(publicError(error))}\n`); process.exitCode = 1; });
