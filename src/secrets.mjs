/**
 * API 密钥来源。优先用 DSH 自己的凭据管理（设置页里保存的、模型页保存的、
 * 以及 DSH 读取的 .env），没有时再看进程环境变量。
 *
 * 设置宿主（settings-host.mjs）在 DSH 提供 credentials 服务时把读取到的值放进这里；
 * providers 在发请求时同步读取，所以这里只做内存缓存，不落盘。
 */
const cache = new Map()
let resolver = null

/** 由宿主装配：ref 是环境变量名，例如 GOOGLE_API_KEY。 */
export function setCredentialResolver(fn) { resolver = fn }

/** 预先读取一组引用，供之后同步使用。 */
export async function preloadSecrets(refs) {
  if (!resolver) return
  for (const ref of new Set(refs.filter(Boolean))) {
    try {
      const found = await resolver(ref)
      if (found?.value) cache.set(ref, found.value)
      else cache.delete(ref)
    } catch { /* 凭据服务暂不可用时退回环境变量 */ }
  }
}

export function rememberSecret(ref, value) {
  if (value) cache.set(ref, value)
  else cache.delete(ref)
}

/** 同步取值：DSH 凭据 → 进程环境变量。 */
export function secretValue(ref) {
  if (!ref) return ''
  return cache.get(ref) || process.env[ref] || ''
}
