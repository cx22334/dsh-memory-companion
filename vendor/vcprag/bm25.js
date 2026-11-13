/**
 * BM25 关键词检索。
 *
 * 参数取业界标准 k1=1.5 / b=0.75。数千篇以内建索引与查询都是毫秒级，
 * 无需任何外部依赖。
 *
 * @module dsh-vcprag/bm25
 */

/** 只由单个汉字构成。用于给 1-gram token 降权。 */
const HAN_ONLY = /^[\u4e00-\u9fff\u3400-\u4dbf]$/

/**
 * @typedef {object} Bm25Doc
 * @property {string} chunkId - 唯一 id，形如 `{docId}#{index}`。
 * @property {string} text - 参与打分的文本。
 * @property {string[]} [tags] - 用于 Tag 加权。
 * @property {string} [date] - ISO 日期，用于时间衰减。
 */

export class BM25 {
  /**
   * @param {number} [k1] - 词频饱和参数。
   * @param {number} [b] - 长度归一化参数。
   * @param {number} [singleCharWeight] - 汉字单字 token 的打分权重（1 = 不降权）。
   */
  constructor(k1 = 1.5, b = 0.75, singleCharWeight = 1) {
    this.k1 = k1
    this.b = b
    /**
     * 汉字单字的打分权重。
     *
     * 为什么需要它：中文用 1-gram + 2-gram 分词，没有真词典，
     * 于是查询里**每个汉字都成了一个独立 token**。这些单字在语料里
     * 出现频率极高（实测「上」出现在 217/371 个 chunk，「消」187/371），
     * IDF 只有 0.2~0.5 —— 但胜在数量多。
     *
     * 后果是灾难性的：查询「我只是调高了对话消息召回的上限」拆出 11 个
     * 单字，它们累计的分数压过了「上限」「召回」「对话」这些真正有区分度
     * 的双字词，最终 top-5 全是「恰好含几个常见字」的无关文档。
     * 实测：只用单字召回 与 用全部 token 召回，排序**完全一致** ——
     * 证明双字词基本没起作用。
     *
     * 单字并非无用：专有名词、生僻术语往往只靠单字命中。
     * 所以是降权而非丢弃。实测单字权重 0.15 时排序最接近人工判断。
     */
    this.singleCharWeight = singleCharWeight
    /** @type {{ chunkId: string, tokens: string[], length: number, raw: Bm25Doc, tf: Map<string, number> }[]} */
    this.docs = []
    /** @type {Map<string, number>} */
    this.idf = new Map()
    this.avgLength = 1
    this.built = false
  }

  /**
   * 建索引。
   *
   * @param {Bm25Doc[]} docs
   * @param {(text: string) => string[]} tokenizer - 已绑定别名的分词函数。
   * @returns {this}
   */
  build(docs, tokenizer) {
    this.docs = []
    /** @type {Map<string, number>} */
    const df = new Map()
    let totalLength = 0

    for (const doc of docs) {
      // 标题与 tags 参与词频但权重靠重复计入正文前（见 indexer 里拼 text 的方式）。
      const tokens = tokenizer(doc.text)
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      this.docs.push({
        chunkId: doc.chunkId,
        tokens,
        length: tokens.length,
        raw: doc,
        tf,
      })
      totalLength += tokens.length
      // 文档频率：每个 token 只算一次
      for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    }

    const N = this.docs.length
    this.avgLength = N > 0 ? totalLength / N : 1
    if (this.avgLength <= 0) this.avgLength = 1

    this.idf = new Map()
    for (const [token, n] of df) {
      // 标准 IDF：+1 保证非负，避免高频词把分数拉成负数
      this.idf.set(token, Math.log((N - n + 0.5) / (n + 0.5) + 1))
    }

    this.built = true
    return this
  }

  /**
   * 单文档打分。
   *
   * @param {string[]} queryTokens
   * @param {{ tf: Map<string, number>, length: number }} doc
   * @returns {number}
   */
  score(queryTokens, doc) {
    let sum = 0
    const seen = new Set()
    const lengthNorm = 1 - this.b + this.b * (doc.length / this.avgLength)

    for (const token of queryTokens) {
      if (seen.has(token)) continue
      seen.add(token)
      const frequency = doc.tf.get(token)
      if (frequency === undefined) continue
      const idf = this.idf.get(token) ?? 0
      // 汉字单字降权：见 constructor 里 singleCharWeight 的说明。
      // 只对「单个汉字」降权，拉丁词 / 双字词不受影响。
      const weight = token.length === 1 && HAN_ONLY.test(token) ? this.singleCharWeight : 1
      sum += (weight * idf * (frequency * (this.k1 + 1))) / (frequency + this.k1 * lengthNorm)
    }
    return sum
  }

  /**
   * 检索。
   *
   * @param {string[]} queryTokens
   * @param {number} [limit]
   * @returns {{ chunkId: string, score: number, doc: Bm25Doc, matched: string[] }[]}
   */
  search(queryTokens, limit = 30) {
    if (!this.built || this.docs.length === 0) return []

    const querySet = [...new Set(queryTokens)]
    const scored = []

    for (const doc of this.docs) {
      const score = this.score(querySet, doc)
      if (score <= 0) continue
      // 记录命中的 token，供 UI 的「命中 token」展示 —— 这是排查
      // 「关键词召回 0 命中」黑箱问题的唯一手段。
      const matched = querySet.filter((token) => doc.tf.has(token))
      scored.push({ chunkId: doc.chunkId, score, doc: doc.raw, matched })
    }

    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit)
  }

  /** 语料统计，供 UI 的索引 Tab 展示。 */
  stats() {
    return {
      docCount: this.docs.length,
      vocabularySize: this.idf.size,
      avgTokens: Math.round(this.avgLength),
    }
  }
}
