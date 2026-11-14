/**
 * DSH 侧栏「记忆」页的宿主半侧：注册浏览器半侧（client/client.js）所在的 Loader 行，
 * 并提供页面用的 RPC 通道 /memory-companion。
 *
 * 它不依赖记忆服务本身：服务因为缺密钥、配置错误而没起来时，设置页仍然能打开、改配置、填密钥。
 */
import { readHostConfig, defaultConfigPath } from './host-config.mjs'
import { normalizeConfig, managementAccessPath } from './config.mjs'
import { readJSON, writeJSONAtomic } from './common.mjs'
import { setCredentialResolver, preloadSecrets, rememberSecret } from './secrets.mjs'
import { runtimeSnapshot } from './runtime-state.mjs'

export const name = 'memory-companion-settings'
export const inject = ['connection']

const CHANNEL = '/memory-companion'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const ok = value => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/** 配置里用到的密钥引用（环境变量名）及其用途。 */
function keyRefs(config) {
  const refs = [
    { ref: config.google?.apiKeyEnv || 'GOOGLE_API_KEY', label: '嵌入模型（向量化）' },
    { ref: config.chat?.apiKeyEnv || 'DEEPSEEK_API_KEY', label: '聊天模型（后台写日记、整理）' },
  ]
  if (config.jev?.endpoint) refs.push({ ref: config.jev.apiKeyEnv || 'JEV_API_KEY', label: 'JEV 精排模型' })
  const seen = new Set()
  return refs.filter(item => ENV_NAME.test(item.ref) && !seen.has(item.ref) && seen.add(item.ref))
}

export function apply(ctx) {
  let credentials = null
  ctx.inject(['credentials'], c => {
    credentials = c.credentials
    setCredentialResolver(ref => c.credentials.resolve(ref))
    // 启动时把已保存的密钥读进缓存，记忆服务发请求时直接用。
    readHostConfig({}).then(cfg => preloadSecrets(keyRefs(cfg).map(item => item.ref))).catch(() => {})
    return () => { credentials = null; setCredentialResolver(null) }
  })

  async function describeKeys(config) {
    const rows = []
    for (const item of keyRefs(config)) {
      let configured = false, source = null
      if (credentials) {
        try {
          const found = await credentials.resolve(item.ref)
          configured = !!found?.value; source = found?.source ?? null
        } catch { /* 退回环境变量 */ }
      }
      if (!configured && process.env[item.ref]) { configured = true; source = 'env' }
      rows.push({ ...item, configured, source })
    }
    return rows
  }

  const endpoints = {
    /** 页面初始数据：配置、密钥状态、运行状态。 */
    async state() {
      const raw = await readHostConfig({})
      const { configPath, configGenerated, ...config } = raw
      let normalized = null, invalid = null
      try { normalized = normalizeConfig(config) } catch (error) { invalid = String(error?.message || error) }
      return ok({
        configPath: configPath || defaultConfigPath(), configGenerated: !!configGenerated,
        config, effective: normalized && { vaultPath: normalized.vaultPath, timezone: normalized.timezone },
        invalid, keys: await describeKeys(config), credentialsAvailable: !!credentials,
        runtime: runtimeSnapshot(),
      })
    },

    /** 保存配置。先完整校验，校验不过不写文件。 */
    async saveConfig(payload) {
      const config = payload?.config
      if (!config || typeof config !== 'object' || Array.isArray(config)) return fail('INVALID_CONFIG', '配置必须是对象')
      try { normalizeConfig(config) } catch (error) { return fail(error?.code || 'INVALID_CONFIG', String(error?.message || error)) }
      const { configPath } = await readHostConfig({})
      const target = configPath || defaultConfigPath()
      const { configPath: _a, configGenerated: _b, ...clean } = config
      await writeJSONAtomic(target, clean)
      await preloadSecrets(keyRefs(clean).map(item => item.ref))
      return ok({ saved: target, restartRequired: true })
    },

    /** 把密钥存进 DSH 的凭据管理（$DSH_HOME/.credentials.yaml），不写进记忆配置。 */
    async setKey(payload) {
      if (!credentials) return fail('CREDENTIALS_UNAVAILABLE', '当前 DSH 没有提供凭据服务，只能用环境变量提供密钥。')
      const ref = payload?.ref, value = typeof payload?.value === 'string' ? payload.value.trim() : ''
      const config = await readHostConfig({})
      if (!keyRefs(config).some(item => item.ref === ref)) return fail('UNKNOWN_KEY', '只能设置当前配置用到的密钥。')
      if (!value) return fail('EMPTY_KEY', '密钥不能为空。')
      await credentials.set(ref, value)
      rememberSecret(ref, value)
      return ok({ keys: await describeKeys(config) })
    },

    async clearKey(payload) {
      if (!credentials) return fail('CREDENTIALS_UNAVAILABLE', '当前 DSH 没有提供凭据服务。')
      const ref = payload?.ref
      const config = await readHostConfig({})
      if (!keyRefs(config).some(item => item.ref === ref)) return fail('UNKNOWN_KEY', '只能清除当前配置用到的密钥。')
      await credentials.unset(ref)
      rememberSecret(ref, '')
      await preloadSecrets([ref])
      return ok({ keys: await describeKeys(config) })
    },

    /** 日记管理页（插件自带的本机网页）的当前链接。 */
    async managementLink() {
      const { configPath: _a, configGenerated: _b, ...config } = await readHostConfig({})
      const access = await readJSON(managementAccessPath(normalizeConfig(config)), null)
      if (!access?.url) return fail('MANAGEMENT_NOT_RUNNING', '日记管理页还没启动：记忆服务需要先正常运行。')
      return ok({ url: access.url })
    },
  }

  ctx.effect(() => ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
    const run = Object.hasOwn(endpoints, endpoint) ? endpoints[endpoint] : null
    if (!run) return fail('UNKNOWN_ENDPOINT', `未知操作 ${endpoint}`)
    try { return await run(payload) }
    catch (error) { return fail(error?.code || 'ERROR', String(error?.message || error)) }
  }))
}
