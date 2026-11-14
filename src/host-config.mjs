/** Shared JSON configuration only: no storage, provider or native-module imports. */
import { readFile, writeFile, mkdir, link, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))

/** DSH 的家目录：跟随 DSH 自己的 DSH_HOME，未设置时为 ~/.dsh。 */
export function dshHome() {
  const value = process.env.DSH_HOME
  return value && value.trim() ? resolve(value) : join(homedir(), '.dsh')
}

/**
 * 插件自己的配置位置。放在 DSH 家目录下而不是包目录里：
 * DSH 安装插件时会把包复制进 profile 的 node_modules，重装或更新会覆盖包目录。
 */
export function defaultConfigPath() {
  return join(dshHome(), 'memory-companion', 'memory.config.json')
}

/** 系统的「文档」目录（Linux 读 XDG 设置，例如中文系统的 ~/文档）。 */
function documentsDir() {
  const home = homedir()
  if (process.platform === 'linux') {
    try {
      const dirs = readFileSync(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'), 'utf8')
      const match = dirs.match(/^XDG_DOCUMENTS_DIR="([^"]+)"/m)
      if (match) {
        const dir = match[1].replace(/^\$HOME/, home)
        if (isAbsolute(dir) && dir !== home) return dir
      }
    } catch { /* 没有 XDG 设置时用默认 */ }
  }
  return join(home, 'Documents')
}

/** 首次运行时生成的配置：以随包示例为底，换成本机合适的值。 */
async function generatedConfig() {
  const example = JSON.parse(await readFile(join(packageRoot, 'memory.config.example.json'), 'utf8'))
  return {
    ...example,
    vaultPath: join(documentsDir(), 'DSH-Memory'),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || example.timezone,
    // 个人单机使用：默认允许启动。需要严格隔离的部署可改回 false，见 docs/host-adapter.md。
    security: { ...example.security, deploymentAcknowledged: true },
  }
}

async function load(filename) {
  let text
  try { text = await readFile(filename, 'utf8') }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw new Error(`memory config: cannot read ${filename}`, { cause }) }
  let loaded
  try { loaded = JSON.parse(text) }
  catch (cause) { throw new Error(`memory config: ${filename} is not valid JSON`, { cause }) }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error(`memory config: ${filename} must contain a JSON object`)
  return loaded
}

/**
 * 读取配置，找不到就自动生成，不要求用户手动复制示例文件。
 * 查找顺序：patch 里显式指定且存在的 configFile → DSH 家目录下的插件配置 → 生成到 DSH 家目录。
 */
export async function readHostConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('memory config: expected an object')
  const { configFile, ...overrides } = input
  if (configFile !== undefined && (typeof configFile !== 'string' || !configFile.trim())) throw new Error('memory config: configFile must be a nonempty path')
  const candidates = []
  if (configFile) candidates.push(isAbsolute(configFile) ? configFile : resolve(packageRoot, configFile))
  const target = defaultConfigPath()
  if (!candidates.includes(target)) candidates.push(target)
  for (const filename of candidates) {
    const loaded = await load(filename)
    if (loaded) return { ...loaded, ...overrides, configPath: filename }
  }
  // 两个入口（bootstrap 与主插件）可能同时首次启动：先写临时文件，再用 link 原子发布，
  // 已存在就放弃自己的那份。另一个入口不会读到写了一半的文件。
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, JSON.stringify(await generatedConfig(), null, 2) + '\n', { flag: 'wx' })
    try {
      await link(temp, target)
      console.warn(`[memory-companion] 已生成默认配置：${target}`)
    } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { await unlink(temp).catch(() => {}) }
  const loaded = await load(target)
  return { ...loaded, ...overrides, configPath: target, configGenerated: true }
}
