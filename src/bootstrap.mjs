/** Stable placeholder providers; deliberately independent of storage/native imports. */
import { readHostConfig } from './host-config.mjs'

export const name = 'memory-companion-bootstrap'
export const inject = ['systemPrompt']

export async function apply(ctx, rawConfig = {}) {
  const config = await readHostConfig(rawConfig)
  const roles = Array.isArray(config.roles) ? config.roles : []
  const aliases = new Set()
  for (const role of roles) {
    const alias = role.alias ?? role.id
    if (typeof alias !== 'string' || !/^[a-z][a-z0-9_]*$/.test(alias) || aliases.has(alias)) {
      throw new Error('memory bootstrap: role aliases must be unique lowercase variable identifiers')
    }
    aliases.add(alias)
    const label = String(role.name ?? role.id)
    ctx.systemPrompt.variable(`mem_self_${alias}`, () => `记忆身份声明：${label}。记忆服务不可用时不提供记忆读写。`)
    ctx.systemPrompt.variable(`mem_read_${alias}`, () => `记忆读取范围声明：${label}；不授予写入或公开来源的权限。`)
    ctx.systemPrompt.variable(`mem_timeline_${alias}`, () => `可在具有读取权限时召回${label}的时间线；本入口不额外授予权限。`)
  }
  ctx.systemPrompt.variable('mem_public', () => '允许记忆服务读取获准的公共记录；公共记录仍是有出处的陈述。')
}
