/** 记忆服务的运行状态，供设置页查看。同一个包内各入口共享这个模块实例。 */
const state = { status: 'not_started', since: null, error: null, service: null }

export function markStarting() { Object.assign(state, { status: 'starting', since: new Date().toISOString(), error: null, service: null }) }
export function markRunning(service) { Object.assign(state, { status: 'running', since: new Date().toISOString(), error: null, service }) }
export function markFailed(error) {
  Object.assign(state, { status: 'failed', since: new Date().toISOString(), service: null,
    error: { code: error?.code || error?.name || 'ERROR', message: String(error?.message || error) } })
}
export function markStopped() { Object.assign(state, { status: 'stopped', since: new Date().toISOString(), service: null }) }

export function runtimeSnapshot() {
  let health = null
  try { health = state.service?.health?.() ?? null } catch (error) { health = { error: String(error?.message || error) } }
  return { status: state.status, since: state.since, error: state.error, health }
}
