import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * 相关性裁判（relevance judge）。
 *
 * ## 为什么需要它
 *
 * v0.2.4 的闸门用一条**代理指标**判断相关性：
 *
 *   「query 里有没有一个在语料中罕见的词？」（`minTokenLen` + `minTokenIdf`）
 *
 * 这条判据在真实数据上会系统性失效。实测一例：
 *
 *   query = 「现在应该正常了，加了条目级去重」
 *   jieba → 正常 / 加 / 条目 / 级 / 重      ← 「去重」整个词消失（不在词典）
 *   闸门放行 → 正常(idf 2.19) / 条目(idf 2.81)
 *
 * 主题词因为被分词切碎而丢掉，剩下两个通用词因为「语料里不算太多」这个
 * **统计学理由**通过闸门。判据问的是「有没有罕见词」，而我们要问的是
 * 「这条日记跟这个 query 讲的是不是一回事」—— 问错了问题，调阈值救不回来。
 *
 * 这个模块把第二个问题直接交给一个判断器（judge）去答，**不再绕道分词**：
 * state 里放 query 原文 + 候选正文，judge 不关心「去重」被切成了什么。
 *
 * ## 两条实测结论（决定了这里的架构，别按直觉改回去）
 *
 * ### 1. 一次问一条，不能把候选打包进同一个 state
 *
 * 直觉上「state 放全部候选 + 每条一个 noul」最省请求，VCPToolBox 的
 * `jevRiverReranker` 就是这么写的。**实测它完全失效**：
 *
 *   批量（3 条候选同 state）→ 0.93 / 0.93 / 0.93   分离度 0.00
 *   单条（每次只放 1 条）    → 0.97 / 0.29 / 0.63   分离度 0.34
 *
 * 原因猜测：多个 noul 共享同一个 state 时，模型倾向于给出一致的、
 * 「整体相关度」式的判断，而不是逐条区分。无论如何，结论是硬的 ——
 * 必须在 state 里隔离，一条候选一次请求。
 *
 * 代价是请求数从 1 变成 N，所以**必须并发**（实测 8 条并发 1.2~2.0 秒，
 * 串行会到 4 秒以上，那就没法放在对话热路径里了）。
 *
 * ### 2. 用陈述句，不要用问句
 *
 *   问句「…讲的是不是同一件事？」 → 0.86 / 0.87      分离度 0.01（失败）
 *   陈述句「…讨论的是同一个主题。」 → 0.97 / 0.29 / 0.63  分离度 0.34
 *
 * `noul` 的语义是「判断某陈述是否为真」，把一个问句塞进 `instructions`
 * 等于让它先解析问题再回答，输出会漂移。**直接给陈述句**才符合原语的形状。
 *
 * ## 阈值（实测，非拍脑袋）
 *
 * 5 个 query × 8 篇真实日记（含 2 个全无关 query）的实测分布：
 *
 *   3 个有答案的 query：相关最高 0.97 / 0.97 / 0.94，噪声最高 0.61 / 0.21 / 0.05
 *   2 个全无关 query：最高分 0.12 / 0.05
 *
 * 「全无关」的上界 0.12，「相关」的下界 0.94，区间很宽。但**注意**：
 * 有答案时噪声能到 0.61（那条 query 带「正常了」「加了」这种事务性措辞），
 * 所以取区间中点 0.53 会让 0.61 漏进来。**默认 0.7** 才是安全的 ——
 * 它同时满足「3 条相关的都留住」和「那条 0.61 的噪声剔掉」。
 *
 * 样本很小（5 query / 8 文档），这个值**必须在你自己的语料上复验**。
 *
 * ## 其它硬约束
 *
 * - **默认关闭。** 未显式开启时实例永远 `applied=false`，主链路行为与
 *   v0.2.5 逐字节一致。
 * - **只重排、不扩充。** 最终条数不会因为裁判而增加。
 * - **失败一律回退。** 超时/网络/响应异常/未配置/概率非法，全部
 *   `applied:false`，由调用方保留原结果。**绝不返回半成品。**
 * - **打分缺失排最后，不凭空丢弃。**
 * - **热路径零重试。** 召回每次对话都跑，重试等于把延迟翻倍。
 *
 * @module dsh-vcprag/relevance-judge
 */

/** 默认配置。全部保守值 —— 任何一个改动都该是显式行为。 */
const DEFAULTS = Object.freeze({
  enabled: false,
  /** 低于此概率的候选被剔除。0 = 不剔除，只重排。实测依据见文件头。 */
  threshold: 0.7,
  /** 最多送多少条候选去判。控制 token 与延迟。 */
  maxCandidates: 12,
  /** 并发请求数。8 实测 1.2~2.0s / 12 条候选。 */
  concurrency: 8,
  /** 单条请求硬超时。热路径，宁可放弃也不拖住对话。 */
  timeoutMs: 4000,
  /** state 里每条候选正文的截断长度。 */
  candidateChars: 400,
  /** state 里 query 的截断长度。 */
  queryChars: 400,
})

/**
 * 判定陈述句。
 *
 * 刻意用**陈述句**而非问句 —— 见文件头「两条实测结论」第 2 条。
 * 也不提「不要因为用词相同就给高分」这类元指令：实测加了反而让分数
 * 一起抬高（0.86/0.87），因为模型开始对「用词」这件事本身做评判。
 */
const STATEMENT = '这段记忆与当前查询讨论的是同一个主题。'

/**
 * 把文本安全截断。用字符数而非字节数 —— 中文按字符算更接近 token 数。
 *
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return ''
  return s.length > max ? s.slice(0, max) : s
}

/**
 * 概率是否合法。非法值一律视为「未知」，而不是「0」。
 *
 * 这个区分很重要：把解析失败的候选当成 0 分会把它静默判死，
 * 而「未知」的正确处理是排到最后、但仍有机会在名额富余时入选。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * 从裁判响应里取出某条候选的概率。缺失或非法一律返回 null。
 *
 * @param {Record<string, unknown>|null|undefined} answers
 * @param {string} id
 * @returns {number|null}
 */
export function probabilityOf(answers, id) {
  if (answers === null || typeof answers !== 'object') return null
  const answer = answers[id]
  if (answer === null || typeof answer !== 'object') return null
  const noul = answer.noul
  return isValidProbability(noul) ? noul : null
}

/**
 * 构造直连 transport：POST 到 Jev 兼容端点。
 *
 * 只依赖 `fetch`，不打代理、不重试。
 *
 * **注意**：TypeSafe 官方端点对部分地区返回 **451**
 * （`Typesafe is not available in your region`）。那种环境必须用下面的
 * `createProxyTransport`，否则裁判永远 `applied:false` —— 而且从外面
 * 看起来像是「开关打开了但没效果」。
 *
 * @param {{ url: string, apiKey: string, model: string }} options
 * @returns {(state: unknown, questions: unknown, opts: { timeoutMs: number }) => Promise<unknown>}
 */
export function createFetchTransport({ url, apiKey, model }) {
  return async function transport(state, questions, opts) {
    const timeoutMs = Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : DEFAULTS.timeoutMs
    // 硬超时用 AbortSignal.timeout —— 它按**墙钟**计时，不是 socket 空闲。
    // 这与 createProxyTransport 里手写的定时器语义必须一致，否则「直连
    // 4 秒超时、代理 5.8 秒才回来」这种不对称会很难查。
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, state, questions }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (cause) {
      // AbortSignal.timeout 抛的是 DOMException('TimeoutError') / AbortError，
      // 上游只看 `applied:false`，但排查时需要能一眼分辨「超时」还是「网络」。
      if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
        const error = new Error(`judge 请求超时（${timeoutMs}ms）`)
        error.code = 'JUDGE_TIMEOUT'
        throw error
      }
      throw cause
    }

    const text = await response.text()
    if (!response.ok) {
      throw httpError(response.status, text)
    }
    try {
      return JSON.parse(text)
    } catch {
      const error = new Error('judge 返回的不是合法 JSON')
      error.code = 'JUDGE_INVALID_JSON'
      throw error
    }
  }
}

/** 把上游返回的 HTTP 错误统一成带 code 的 Error。 */
function httpError(status, body) {
  const error = new Error(`judge HTTP ${status}: ${truncate(body, 300)}`)
  error.code = `JUDGE_HTTP_${status}`
  error.status = status
  return error
}

/**
 * 构造走 HTTP CONNECT 隧道的 transport。
 *
 * ## 为什么这条路径必须在产品代码里，不能只留在 e2e 脚本
 *
 * TypeSafe 官方端点对部分地区返回 **451**（`Typesafe is not available in
 * your region`）。这不是「偶发网络问题」，是地域封锁 —— 直连永远不通。
 *
 * 如果只有 `createFetchTransport`，那面板上的「启用裁判」开关就是一个
 * **按下无效**的开关：它会打开、会保存、日志里也不会有任何异常，只是
 * 每次召回都静默走 `applied:false` 分支。用户看到的现象是「开了跟没开
 * 一样」，而排查方向会被引到阈值和并发数上去。
 *
 * Node 内置 `fetch` **不读** `HTTPS_PROXY` / `HTTP_PROXY`（undici 的
 * `EnvHttpProxyAgent` 需要显式配置，而 `undici` 并不是本插件的依赖），
 * 所以这里用 `node:http` 手工做 CONNECT 握手 + `node:https` 在裸 socket
 * 上发请求。这也正是 VCPToolBox 的 `jevClient` 走的路径。
 *
 * @param {{ url: string, apiKey: string, model: string, proxyUrl: string }} options
 * @returns {(state: unknown, questions: unknown, opts: { timeoutMs: number }) => Promise<unknown>}
 */
export function createProxyTransport({ url, apiKey, model, proxyUrl }) {
  return async function transport(state, questions, opts) {
    const timeoutMs = Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : DEFAULTS.timeoutMs
    const payload = JSON.stringify({ model, state, questions })
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }

    // URL 解析放在最外层：配置写错时要立刻给出可读错误，
    // 而不是在 Promise 里抛一个发生在 CONNECT 之后的 SyntaxError。
    const target = new URL(url)
    const proxy = new URL(proxyUrl)
    const isHttps = target.protocol === 'https:'
    const targetPort = target.port || (isHttps ? 443 : 80)

    return new Promise((resolve, reject) => {
      // 硬墙钟超时。
      //
      // **不能只靠 http.request 的 `timeout` 选项** —— 那是 socket
      // *空闲* 超时，不是墙钟。实测过一条真实故障：调用方设了 4000ms，
      // 实际却跑了 5803ms 才返回，因为 CONNECT 成功、TLS 也有零星数据
      // 流动，空闲计时被反复重置。裁判在召回热路径上，多拖 1.8 秒就是
      // 用户多等 1.8 秒，所以必须有真正到点就掐的定时器。
      //
      // fetch transport 那边用的是 AbortSignal.timeout（真墙钟），
      // 两条路径的超时语义必须一致。
      let settled = false
      let activeSocket = null
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        if (activeSocket !== null) activeSocket.destroy()
        const error = new Error(`judge 请求超时（${timeoutMs}ms）`)
        error.code = 'JUDGE_TIMEOUT'
        reject(error)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      const finish = (fn) => (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const done = finish(resolve)
      const fail = finish(reject)

      const connectReq = httpRequest({
        host: proxy.hostname,
        port: proxy.port || 8080,
        method: 'CONNECT',
        path: `${target.hostname}:${targetPort}`,
      })

      connectReq.on('connect', (res, socket) => {
        activeSocket = socket
        if (res.statusCode !== 200) {
          socket.destroy()
          fail(httpError(res.statusCode, `CONNECT 隧道建立失败（代理 ${proxy.host}）`))
          return
        }

        // 隧道已建立，之后在这个裸 socket 上跑 TLS + HTTP。
        // `agent: false` 防止连接被池化复用 —— 隧道是一次性的，
        // 复用会在下一次请求时踩到已关闭的 socket。
        const send = isHttps ? httpsRequest : httpRequest
        const req = send(
          {
            host: target.hostname,
            port: targetPort,
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            headers,
            socket,
            agent: false,
            servername: isHttps ? target.hostname : undefined,
            timeout: timeoutMs,
          },
          (response) => {
            let data = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              data += chunk
            })
            response.on('end', () => {
              socket.destroy()
              if (response.statusCode !== 200) {
                fail(httpError(response.statusCode, data))
                return
              }
              try {
                done(JSON.parse(data))
              } catch {
                const error = new Error('judge 返回的不是合法 JSON')
                error.code = 'JUDGE_INVALID_JSON'
                fail(error)
              }
            })
          },
        )
        req.on('error', fail)
        req.end(payload)
      })

      connectReq.on('error', fail)
      connectReq.end()
    })
  }
}

/**
 * 创建裁判实例。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled=false] 总开关。**默认关闭。**
 * @param {(state: unknown, questions: unknown, opts: object) => Promise<unknown>} [options.transport]
 *   注入的 HTTP 层。未提供时 `applied` 恒为 false（视为未配置）。
 * @param {number} [options.threshold]
 * @param {number} [options.maxCandidates]
 * @param {number} [options.concurrency]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.candidateChars]
 * @param {number} [options.queryChars]
 */
export function createJudge(options = {}) {
  const config = { ...DEFAULTS, ...options }
  const transport = typeof config.transport === 'function' ? config.transport : null

  /**
   * 裁判是否具备运行条件。**不抛错** —— 调用方可能在每个请求都问一次。
   */
  function isConfigured() {
    return config.enabled === true && transport !== null
  }

  /**
   * 判定**单条**候选。
   *
   * state 里只有这一条 —— 这是实测出来的硬约束，不是风格选择。
   * 把多条候选塞进同一个 state 会让分数塌成一个常数（0.93/0.93/0.93）。
   *
   * @param {string} query
   * @param {{ chunkId: string, title?: string, text?: string }} candidate
   * @returns {Promise<number|null>} 概率，或 null（失败/非法）
   */
  async function judgeOne(query, candidate) {
    const state = {
      当前查询: truncate(query, config.queryChars),
      记忆标题: truncate(candidate?.title, 120),
      记忆正文: truncate(candidate?.text, config.candidateChars),
    }
    const questions = { verdict: { type: 'noul', instructions: STATEMENT } }

    const response = await transport(state, questions, { timeoutMs: config.timeoutMs })
    return probabilityOf(response?.answers, 'verdict')
  }

  /**
   * 并发判定若干候选。
   *
   * 用固定数量的 worker 从同一个游标取任务，而不是 `Promise.all` 直接铺开
   * —— 后者在有 30 条候选时会瞬间打 30 个连接，超出限流上限后整批失败。
   *
   * @param {string} query
   * @param {Array<{ chunkId: string, title?: string, text?: string }>} candidates
   * @returns {Promise<{
   *   applied: boolean,
   *   reason?: string,
   *   scores?: Map<string, number|null>,
   *   latencyMs?: number,
   *   judged?: number,
   *   scored?: number,
   *   failed?: number,
   * }>}
   */
  async function judge(query, candidates) {
    if (!isConfigured()) {
      return { applied: false, reason: 'disabled' }
    }

    const list = Array.isArray(candidates) ? candidates : []
    if (list.length === 0) {
      return { applied: false, reason: 'no_candidates' }
    }

    // 只送前 maxCandidates 条。后面的条目压根不参与判断 ——
    // 它们会拿到 null 分，按规则排到最后。
    const limit = Math.max(1, Math.round(config.maxCandidates))
    const shortlist = list.slice(0, limit)

    const started = performance.now()
    const scores = new Map()
    let scored = 0
    let failed = 0

    const width = Math.max(1, Math.min(Math.round(config.concurrency) || 1, shortlist.length))
    let cursor = 0

    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= shortlist.length) return
        const candidate = shortlist[index]
        const id = String(candidate.chunkId)
        try {
          const probability = await judgeOne(query, candidate)
          scores.set(id, probability)
          if (probability !== null) scored += 1
          else failed += 1
        } catch {
          // 单条失败不该拖垮整批：记 null（= 未知，排最后），继续判其余的。
          // 这一步是**局部降级**，与「整批判定失败」是两件事 —— 后者由
          // 下面 scored === 0 的分支处理。
          scores.set(id, null)
          failed += 1
        }
      }
    }

    await Promise.all(
      Array.from({ length: width }, () => worker()),
    )
    const latencyMs = Math.round(performance.now() - started)

    // 一条都没打上分 = 这次判断没有任何信息量，等同于失败。
    // 若照常 applied:true，会把全部候选都判成「未知」从而变成纯重排，
    // 而调用方以为过滤已经生效了 —— 属于最难排查的一种静默失效。
    if (scored === 0) {
      return {
        applied: false,
        reason: 'no_valid_scores',
        latencyMs,
        judged: shortlist.length,
        failed,
      }
    }

    return {
      applied: true,
      scores,
      latencyMs,
      judged: shortlist.length,
      scored,
      failed,
    }
  }

  return {
    isConfigured,
    judge,
    // 暴露出来便于测试与诊断；调用方不应依赖其可变性。
    config,
  }
}

/**
 * 按裁判结果重排 + 过滤候选。
 *
 * 单独成函数是为了把「三条不变量」写成可测的纯逻辑：
 *
 *   1. 只重排不扩充 —— `out.length <= hits.length` 恒成立；
 *   2. 打分缺失排最后 —— 有分项恒在无分项之前；
 *   3. 失败原样返回 —— `applied:false` 时 `out` 与入参**同序等长**。
 *
 * @template {{ chunkId: string }} T
 * @param {T[]} hits 已按上游分数降序的候选。
 * @param {Map<string, number|null>} scores
 * @param {{ threshold?: number, k?: number }} [options]
 * @returns {{ out: T[], dropped: number, unknown: number }}
 */
export function applyVerdicts(hits, scores, options = {}) {
  const list = Array.isArray(hits) ? hits : []
  if (list.length === 0) return { out: [], dropped: 0, unknown: 0 }

  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0
  const k = Number.isFinite(options.k) ? Math.max(1, Math.round(options.k)) : list.length

  const known = []
  const unknown = []
  let dropped = 0

  list.forEach((hit, index) => {
    const probability = scores instanceof Map ? scores.get(String(hit.chunkId)) : undefined
    if (!isValidProbability(probability)) {
      // 无分项保留原相对顺序（index 隐式承担 tiebreak）
      unknown.push({ hit, index })
      return
    }
    // 阈值只对「有分」的条目生效。无分条目无从判断，放行 ——
    // 拿阈值去卡一个没有分数的条目，等于随便猜。
    if (threshold > 0 && probability < threshold) {
      dropped += 1
      return
    }
    known.push({ hit, index, probability })
  })

  // 有分项按概率降序；同分用上游顺序稳定 tiebreak。
  known.sort((left, right) => {
    if (right.probability !== left.probability) return right.probability - left.probability
    return left.index - right.index
  })

  const merged = [...known.map((entry) => entry.hit), ...unknown.map((entry) => entry.hit)]

  return {
    // 这里同时实现「只重排不扩充」：slice 只会缩短，永不增长。
    out: merged.slice(0, k),
    dropped,
    unknown: unknown.length,
  }
}

export const JUDGE_DEFAULTS = DEFAULTS
