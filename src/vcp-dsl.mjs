/** VCP diary DSL control plane, adapted from RAGDiaryPlugin@73fd165d.
 * No filesystem/provider dependencies: bootstrap may load this even if native fails.
 */
const assembled = new WeakMap();
const forms = /\[\[([^\]\r\n]*?日记本[^\]\r\n]*?)\]\]|<<([^\r\n]*?日记本[^\r\n]*?)>>|《《([^》\r\n]*?日记本[^》\r\n]*?)》》|\{\{([^}\r\n]*?日记本[^}\r\n]*?)\}\}/g;
const unsupported = /\[\[(?:VCPTimeLine|VCP元思考|AIMemo=)|(?:\[\[|《《)[^\r\n]*?知识库/;
function problem(code, message) { const error = new Error(message); error.code = code; throw error; }
const numeric = (value, min, max, field) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) problem('VCP_DSL_VALUE', `${field} must be between ${min} and ${max}`);
  return n;
};

export function parseModifiers(suffix, mode) {
  const opts = { multiplier: 1, river: true, time: null, group: false, bm25: null,
    decay: null, truncate: 0, expand: false, associate: false, last: null, random: null, valve: null, jev: null };
  let rest = suffix.trim();
  const leading = rest.match(/^:(\d+(?:\.\d+)?)(?=::|$)/);
  if (leading) { opts.multiplier = numeric(leading[1], 0.01, 20, 'K multiplier'); rest = rest.slice(leading[0].length); }
  if (rest && !rest.startsWith('::')) problem('VCP_DSL_SYNTAX', `Invalid diary suffix: ${rest}`);
  const seen = new Set();
  for (let part of rest.split('::').filter(Boolean)) {
    part = part.trim();
    const trailing = part.match(/:(\d+(?:\.\d+)?)$/);
    if (trailing) { opts.multiplier = numeric(trailing[1], 0.01, 20, 'K multiplier'); part = part.slice(0, -trailing[0].length); }
    let match, key;
    if (/^TagMemo/i.test(part)) problem('TAGMEMO_RETRIEVAL_RETIRED', '上游已停用 ::TagMemo / ::TagMemo+，请改为 ::RiverMemo。');
    if (/^Rerank/i.test(part)) problem('VCP_RERANK_REPLACED', '本插件使用 JEV：请把 ::Rerank 改为 ::Jev，或移除该后缀只用原生浪潮。');
    if (/^RiverMemo$/i.test(part)) key = 'river';
    else if ((match = part.match(/^Time(\d*\.?\d+)?$/i))) { key = 'time'; opts.time = match[1] === undefined ? 0.2 : numeric(match[1], 0, 1, 'Time ratio'); }
    else if (/^Group$/i.test(part)) { key = 'group'; opts.group = true; }
    else if ((match = part.match(/^BM25(\+)?(\d*\.?\d+)?$/i))) { key = 'bm25'; opts.bm25 = { mode: match[1] ? 'body' : 'tag', weight: match[2] === undefined ? 0.6 : numeric(match[2], 0, 1, 'BM25 weight') }; }
    else if ((match = part.match(/^TimeDecay(\d+)?(?:\/(\d*\.?\d+))?(?:\/([^\s]+))?$/i))) {
      key = 'decay'; opts.decay = { halfLife: numeric(match[1] || 30, 1, 36500, 'halfLife'), minScore: numeric(match[2] ?? 0.5, 0, 1, 'minScore'), targets: (match[3] || '').split(',').filter(Boolean) };
    } else if ((match = part.match(/^Truncate(\d*\.?\d+)$/i))) { key = 'truncate'; opts.truncate = numeric(match[1], 0, 1, 'Truncate'); }
    else if (/^Expand$/i.test(part)) { key = 'expand'; opts.expand = true; }
    else if (/^Associate$/i.test(part)) { key = 'associate'; opts.associate = true; }
    else if ((match = part.match(/^Last(\d*)$/i))) { key = 'last'; opts.last = numeric(match[1] || 10, 1, 10000, 'Last'); }
    else if ((match = part.match(/^Random(\d*)$/i))) { key = 'random'; opts.random = numeric(match[1] || 1, 1, 10000, 'Random'); }
    else if ((match = part.match(/^RoleValve(@.+)$/i))) {
      key = 'valve';
      if (!match[1].split(/[|&]/).every(x => /^@?(User|Assistant|System)(?:[<>]=?\d+|=\d+)?$/i.test(x))) problem('VCP_ROLE_VALVE', 'Invalid ::RoleValve expression');
      opts.valve = match[1];
    } else if ((match = part.match(/^Jev([1-4])?(\+(\d*\.?\d+)?)?$/i))) {
      key = 'jev'; opts.jev = { preset: match[1] || null, plus: !!match[2], autoAlpha: match[2] === '+', alpha: match[2] ? numeric(match[3] ?? 0.5, 0, 1, 'Jev fusion weight') : null };
    } else problem('VCP_DSL_UNSUPPORTED', `未实现的 VCP 修饰符 ::${part}；不会静默忽略。AIMemo、元思考、附件及冷知识库不属于本角色日记检索。`);
    if (seen.has(key)) problem('VCP_DSL_DUPLICATE', `Duplicate VCP modifier: ${part}`);
    seen.add(key);
  }
  const full = mode === 'full' || mode === 'gated_full';
  if (!full && (opts.last || opts.random)) problem('VCP_DSL_MODE', '::Last / ::Random 用于 {{全文日记本}} 或 <<条件全文日记本>>。');
  if (full && (opts.time !== null || opts.group || opts.associate || opts.decay || opts.truncate || opts.jev)) problem('VCP_DSL_MODE', '全文模式支持 Last / Random / BM25 / RoleValve；检索修饰符请用 [[...]] 或 《《...》》。');
  if (opts.last && opts.random) problem('VCP_DSL_MODE', '::Last and ::Random cannot be combined');
  return opts;
}

export function parseVcpText(text, config = {}) {
  const plans = [];
  if (unsupported.test(text)) problem('VCP_DSL_EXTERNAL_SERVICE', '当前支持角色日记检索 DSL；VCPTimeLine、VCP元思考、AIMemo 和冷知识库占位符需要其独立服务，不能冒充已接入。');
  const stripped = String(text).replace(forms, (placeholder, rag, gatedFull, gatedRag, full) => {
    const inner = rag ?? gatedFull ?? gatedRag ?? full;
    const marker = inner.indexOf('日记本');
    const names = inner.slice(0, marker).split('|').map(name => name.trim()).filter(Boolean);
    if (!names.length || names.some(name => /[\[\]{}<>《》/\\]/.test(name))) problem('VCP_DSL_BOOK', 'Invalid diary book name');
    const mode = rag !== undefined ? 'rag' : gatedFull !== undefined ? 'gated_full' : gatedRag !== undefined ? 'gated_rag' : 'full';
    const options = parseModifiers(inner.slice(marker + 3), mode);
    plans.push({ placeholder, names: [...new Set(names)], mode, options });
    if (plans.length > (config.vcpDsl?.maxDeclarations ?? 12)) problem('VCP_DSL_LIMIT', 'Too many diary declarations');
    // Static removal preserves the native persona prefix. Dynamic content goes
    // into DSH's runtime context, never repeatedly into the system prefix.
    return '';
  });
  return { plans, stripped };
}

export function prepareVcpAssembly(assembly, config) {
  if (assembled.has(assembly)) return assembled.get(assembly);
  const section = assembly.sections.find(entry => entry.name === 'deployment:persona-prefix');
  if (!section) return [];
  const parsed = parseVcpText(section?.text || '', config);
  if (section) section.text = parsed.stripped;
  assembled.set(assembly, parsed.plans);
  return parsed.plans;
}

export function roleValveAllows(expression, counts = {}) {
  if (!expression) return true;
  return expression.split('|').some(group => group.split('&').every(condition => {
    const [, role, op, value] = condition.match(/^@?(User|Assistant|System)(?:([<>]=?|=)(\d+))?$/i);
    const n = counts[role.toLowerCase()] || 0, target = Number(value);
    return !op ? n > 0 : op === '<' ? n < target : op === '>' ? n > target : op === '<=' ? n <= target : op === '>=' ? n >= target : n === target;
  }));
}

export function resolveBooks(plan, binding, config) {
  const roles = new Set([binding.role_id, ...(binding.read_role_ids || [])]);
  return plan.names.map(name => {
    const custom = config.vcpDsl?.books?.[name];
    const matches = config.roles.filter(role => [role.id, role.alias, role.name, role.directory].includes(name));
    const book = custom ? { name, ...custom } : name === '公共' ? { name, public: true, role_ids: [], kinds: ['public'] }
      : matches.length === 1 ? { name, role_ids: [matches[0].id], public: false, kinds: ['diary', 'impression'] } : null;
    if (!book || !Array.isArray(book.role_ids) || book.role_ids.some(role => !roles.has(role)) || (book.public && !binding.read_public)) {
      problem('VCP_BOOK_NOT_AUTHORIZED', '日记本不存在、名称有歧义或未获读取授权；请检查角色配置和 mem_read 声明。');
    }
    if (book.threshold !== undefined) numeric(book.threshold, 0, 1, 'Book similarity threshold');
    return book;
  });
}

export function selectionFor(books) {
  return { books: books.map(book => ({ role_ids: [...book.role_ids].sort(), public: book.public === true,
    kinds: book.kinds || ['diary', 'impression', 'public'] })) };
}
export function matchesSelection(note, selection) {
  return !selection || selection.books.some(book => book.kinds.includes(note.kind) &&
    (note.kind === 'public' ? book.public : book.role_ids.includes(note.owner_role_id)));
}
