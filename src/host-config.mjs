/** Shared JSON configuration only: no storage, provider or native-module imports. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))

export async function readHostConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('memory config: expected an object')
  const { configFile, ...overrides } = input
  if (configFile === undefined) return overrides
  if (typeof configFile !== 'string' || !configFile.trim()) throw new Error('memory config: configFile must be a nonempty path')
  const filename = isAbsolute(configFile) ? configFile : resolve(packageRoot, configFile)
  let loaded
  try { loaded = JSON.parse(await readFile(filename, 'utf8')) }
  catch (cause) {
    throw new Error(`memory config: cannot load JSON configuration ${filename}; copy memory.config.example.json to memory.config.json and configure it before enabling the plugin`, { cause })
  }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error(`memory config: ${filename} must contain a JSON object`)
  return { ...loaded, ...overrides }
}
