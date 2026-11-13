/**
 * 中英混合分词。
 *
 * ## 两套引擎，运行期选定
 *
 *   1. **jieba**（`@node-rs/jieba`）—— 真词典分词，中文首选。
 *      「上限」「召回」「对话」这类词会被切成完整词，单字噪音大幅减少。
 *
 *   2. **1-gram + 2-gram**（纯 JS，零依赖）—— 降级方案。
 *      「上下文折叠」→ 上/下文/上下/文折/折叠…，靠 2-gram 兜住双字名词。
 *
 * ## 为什么是「可选依赖」而不是硬依赖
 *
 * `@node-rs/jieba` 走 napi-rs，**13 个平台全部预编译**（含
 * `@node-rs/jieba-win32-x64-msvc`），安装时只下载一个 `.node`，不需要
 * 编译工具链。所以「装不上」不是常态 —— 但也不是零风险：
 *
 *   - 平台不在预编译列表里（比如某些嵌入式 / loongarch）
 *   - 用 `--no-optional` / 离线镜像装包，二进制被跳过
 *   - 应用打包时 node_modules 没被带进产物
 *
 * 任何一条成立，硬依赖就等于「整个插件起不来」。而记忆召回是增强功能，
 * 它的正确降级行为是**退回 1-gram 继续跑**，不是把主链路拖死。
 *
 * 代价：jieba 常驻约 48 MB RSS（词典 4.84 MB 展开成 trie）+ 启动 ~90 ms。
 * 这一点在 README 里写明了，介意的人可以把 recall.tokenizer 设成 'gram'。
 *
 * @module dsh-vcprag/tokenize
 */

import { createRequire } from 'node:module'

/** 汉字区间。扩展 B 区（\u{20000}+）也纳入，避免生僻字被当成英文。 */
const HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/

/** 拉丁/数字词：≥2 字符才算，单字母噪音太大。 */
const LATIN = /[a-z0-9_]{2,}/g

/** 拉丁 token 的合法形状（jieba 结果也要过这一关）。 */
const LATIN_TOKEN = /^[a-z0-9_]{2,}$/

/**
 * 停止词：命中率高但零区分度，直接丢弃以压缩倒排表。
 *
 * jieba 模式下作用更大 —— 真分词会把「的」「了」「只是」切成独立 token，
 * 不滤掉的话它们会占据大量倒排项。
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may',
  'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'she', 'use',
  '的', '了', '是', '在', '和', '有', '就', '不', '人', '都', '一', '上',
  '也', '很', '到', '说', '要', '去', '会', '着', '没', '看', '好', '自',
  '这', '那', '个', '们', '中', '为', '以', '与', '或', '而', '把', '被',
  // 以下为 jieba 模式补充：真分词会把虚词切成独立 token，
  // 它们在任何语料里都高频，留着只会稀释有效信号。
  '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '只是', '就是', '还是', '但是', '因为', '所以', '如果', '然后',
  '可以', '这个', '那个', '什么', '怎么', '为什么', '一个',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '先',

  // ---- 口语填充词（v0.2.4）----
  //
  // 这批的共同点是：**在语料里罕见，所以 IDF 很高**，但在对话里
  // 毫无信息量。不加进停用词表的话，它们会被 IDF 判据当成「强区分
  // 信号」，把噪声条目保下来。
  //
  // 实测：「修了，再简单测一下」里的「一下」idf=5.003（语料里几乎没
  // 出现过），高过「木马」(2.720)、「扫描」(3.001) —— 只靠 IDF 根本
  // 分不开「罕见虚词」和「罕见实词」。
  //
  // 结论：IDF 只能衡量「罕见」，衡量不了「是否有意义」。虚词必须在
  // 分词阶段就滤掉，这一步不能省。
  '一下', '一点', '一些', '一样', '一直', '一起', '一边',
  '应该', '不要', '不会', '不能', '不用', '不是', '不过', '不再',
  '还有', '而且', '或者', '虽然', '即使', '于是', '因此',
  '现在', '刚才', '马上', '立刻', '已经', '曾经', '正在',
  '看看', '试试', '想想', '说说', '来了', '去了', '好的', '是的',
  '这次', '那次', '下次', '上次', '这次', '的话', '时候',
])

/** jieba 可用性探测结果缓存（避免重复 try/catch 和重复加载词典）。 */
let jiebaState = null

/**
 * 探测并初始化 jieba。
 *
 * 只跑一次。返回 `{ engine, cut }` 或 `{ engine: 'gram', error }`。
 *
 * @returns {{ engine: 'jieba', cut: (text: string, hmm: boolean) => string[] }
 *   | { engine: 'gram', error: string }}
 */
function loadJieba() {
  if (jiebaState !== null) return jiebaState
  try {
    // 用 createRequire 而不是顶层 import：
    // 包的入口是 CommonJS，且我们必须在「模块不存在」时捕获而不是崩掉。
    const require = createRequire(import.meta.url)
    const { Jieba } = require('@node-rs/jieba')
    const { dict } = require('@node-rs/jieba/dict.js')
    const instance = Jieba.withDict(dict)
    jiebaState = {
      engine: 'jieba',
      cut: (text) => instance.cut(text, true),
    }
  } catch (error) {
    jiebaState = {
      engine: 'gram',
      error: String(error?.message ?? error),
    }
  }
  return jiebaState
}

/**
 * 当前实际生效的分词引擎名，供日志与 UI 展示。
 *
 * @param {string} [mode] - `'auto' | 'jieba' | 'gram'`。
 * @returns {'jieba' | 'gram'}
 */
export function resolveEngine(mode = 'auto') {
  if (mode === 'gram') return 'gram'
  const state = loadJieba()
  return state.engine
}

/** jieba 不可用时的原因（可用时为 null）。诊断 UI 用。 */
export function jiebaLoadError() {
  const state = loadJieba()
  return state.engine === 'jieba' ? null : state.error
}

/**
 * 分词入口。
 *
 * @param {string} text - 原始文本。
 * @param {Record<string, string[]>|null} aliases - 同义词组表：
 *   `{ "BM25": ["关键词检索", "词法检索"] }`。命中任一词即把整组词都注入。
 * @param {{ mode?: string }} [options] - `mode` 取 `'auto'`（默认，有 jieba 就用）
 *   / `'jieba'` / `'gram'`。强制 'jieba' 而实际不可用时**静默降级**，
 *   绝不抛错 —— 分词失败不该阻断召回。
 * @returns {string[]} token 列表（可重复，BM25 需要词频）。
 */
export function tokenize(text, aliases = null, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return []

  const mode = options?.mode ?? 'auto'
  const state = mode === 'gram' ? null : loadJieba()
  const out = state !== null && state.engine === 'jieba'
    ? tokenizeWithJieba(text, state.cut)
    : tokenizeWithGram(text)

  // 同义词组扩展
  // 解决「缩写 ↔ 全称」这类字面零重叠的问题。
  // 纯代号之间向量相似度往往很低（判为无关），别名表是唯一补救手段。
  if (aliases !== null && typeof aliases === 'object') {
    const lower = text.toLowerCase()
    for (const [canonical, group] of Object.entries(aliases)) {
      if (!Array.isArray(group) || group.length === 0) continue
      const canonicalLower = canonical.toLowerCase()
      // 命中规则：正文里出现了组内任一词，或出现了规范名本身
      const hit =
        lower.includes(canonicalLower) ||
        group.some((word) => typeof word === 'string' && lower.includes(word.toLowerCase()))
      if (!hit) continue
      // 把规范名与全组词都补进来，让两路召回都能匹配上。
      // 注意：这里刻意用 1-gram 版本展开，避免别名扩展触发二次 jieba 调用。
      out.push(...tokenizeWithGram(canonicalLower))
      for (const word of group) {
        if (typeof word === 'string') out.push(...tokenizeWithGram(word))
      }
    }
  }

  return out
}

/**
 * jieba 分词。
 *
 * `hmm: true` 让未登录词走 HMM 新词发现 —— 实测对本语料更准：
 * 「我只是调高了对话消息召回的上限」
 *   hmm=false → 我 / 只是 / 调 / 高 / 了 / 对话 / 消息 / 召回 / 的 / 上限
 *   hmm=true  → 我 / 只是 / 调高 / 了 / 对话 / 消息 / 召回 / 的 / 上限
 * 「调高」合成一个词后，「调」「高」不再作为噪声单字命中无关文档。
 *
 * @param {string} text
 * @param {(text: string) => string[]} cut
 * @returns {string[]}
 */
function tokenizeWithJieba(text, cut) {
  const out = []
  let pieces
  try {
    pieces = cut(text)
  } catch {
    // 单个字符串切词失败不该毁掉整次索引/召回 —— 退回 1-gram。
    return tokenizeWithGram(text)
  }
  for (const raw of pieces) {
    if (typeof raw !== 'string') continue
    const token = raw.trim().toLowerCase()
    if (token === '' || STOPWORDS.has(token)) continue
    // 纯标点 / 空白 / 全角符号：丢弃。保留汉字、拉丁、数字。
    if (!HAN.test(token) && !LATIN_TOKEN.test(token)) continue
    out.push(token)
  }
  return out
}

/**
 * 降级分词：中文 1-gram + 2-gram，拉丁词整取。
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeWithGram(text) {
  const out = []
  const lower = text.toLowerCase()

  // 1) 拉丁词与数字
  for (const match of lower.matchAll(LATIN)) {
    const word = match[0]
    if (!STOPWORDS.has(word)) out.push(word)
  }

  // 2) 中文 1-gram + 2-gram
  const chars = [...lower]
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (!HAN.test(ch)) continue
    if (!STOPWORDS.has(ch)) out.push(ch)
    const next = chars[i + 1]
    if (next !== undefined && HAN.test(next)) out.push(ch + next)
  }

  return out
}

/**
 * 只做去重，供「命中 token」这类 UI 展示用。
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function uniqueTokens(tokens) {
  return [...new Set(tokens)]
}
