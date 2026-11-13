/** User management UI. All memory text is inserted with textContent, never executable HTML. */
const $ = selector => document.querySelector(selector);
const state = { token: '', csrf: '', config: null, health: null, view: 'notes', role: '', context: 'default', query: '', offset: 0, selected: null, request: 0 };
const titles = { notes: '日记与来源', proposals: '更正与整理', snapshots: '回答的记忆依据', replay: '回放预览', policy: '使用与共享', health: '状态与维护' };
const kinds = { diary: '日记', impression: '印象', public: '公共记录' };
const usages = { normal: '普通使用', prefer_when_relevant: '相关时优先', explicit_only: '仅明确回顾', excluded: '排除使用' };
const origins = { self: '角色记录', backfill: '后台补记', user: '使用者手写', external_unattributed: '外部修改' };

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden') element[key] = !!value;
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}

function button(label, action, variant = 'secondary') {
  return h('button', { class: `button ${variant}`, type: 'button', onclick: event => operate(event.currentTarget, action) }, label);
}
function field(label, input, hint = '') { return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null); }
function pre(value) { return h('pre', {}, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function panel(title, ...children) { return h('section', { class: 'panel' }, title ? h('h2', {}, title) : null, ...children); }
function empty(text) { return h('p', { class: 'empty' }, text); }
function date(value) { if (!value) return '时间未记录'; if (typeof value === 'object') return value.start || value.from ? `${date(value.start || value.from)} — ${date(value.end || value.to)}` : JSON.stringify(value); const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleString('zh-CN', { hour12: false }); }
function labelRole(id) { return state.config?.roles.find(role => role.id === id)?.name || id || '未归属'; }
function roleParams(extra = {}) { return { role_id: state.role, context_id: state.context, ...extra }; }
function list(value) { return Array.isArray(value) ? value : value?.items || []; }
function tokens(value) { return String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean); }
function noteTitle(note) { return note.title || String(note.body || '').split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 52) || '未命名记录'; }
function prettyStatus(value) { return ({ proposed: '待处理', approved: '已批准', rejected: '已拒绝', stale: '版本已变化', committed: '已提交', completed: '已完成', pending: '待处理', running: '处理中', pending_review: '待审阅', withdrawn: '已撤回', excluded: '已排除', archived: '已归档' })[value] || value || '未标记'; }

function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = error ? 'error' : '';
  $('#notice').hidden = !message;
}
async function operate(control, fn) {
  if (control?.disabled) return;
  if (control) control.disabled = true;
  try { await fn(); }
  catch (error) { notify(error.message || String(error), true); }
  finally { if (control?.isConnected) control.disabled = false; }
}

async function api(route, payload) {
  const options = { method: payload === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', headers: { Authorization: `Bearer ${state.token}` } };
  if (payload !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-CSRF-Token'] = state.csrf;
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(`/api/${route}`, options);
  const result = await response.json();
  if (!response.ok || result.error) {
    if (response.status === 401) { $('#login-panel').hidden = false; $('#connection').className = 'connection error'; $('#connection').textContent = '需要重新连接'; }
    const error = new Error(result.error?.message || `请求失败 (${response.status})`);
    error.code = result.error?.code;
    error.details = result.error?.details;
    throw error;
  }
  return result.result;
}

function confirmAction(title, description, preview, accept = '确认操作') {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-preview').textContent = typeof preview === 'string' ? preview : JSON.stringify(preview, null, 2);
  $('#confirm-accept').textContent = accept;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

async function loadState() {
  const data = await api('state');
  state.config = data.config;
  state.health = data.health;
  state.csrf = data.csrfToken;
  const roles = data.config.roles || [];
  if (!roles.some(role => role.id === state.role)) state.role = roles[0]?.id || '';
  const select = $('#role-select');
  select.replaceChildren(...roles.map(role => h('option', { value: role.id }, role.name || role.id)));
  select.value = state.role;
  if (!state.context || state.context === 'default') state.context = data.config.contextId || 'default';
  $('#context-input').value = state.context;
  $('#connection').className = 'connection ready';
  $('#connection').textContent = '已连接 · 使用者管理视角';
  $('#login-panel').hidden = true;
}

async function render() {
  if (!state.config) return;
  const request = ++state.request;
  $('#page-title').textContent = titles[state.view];
  for (const nav of document.querySelectorAll('[data-view]')) nav.classList.toggle('active', nav.dataset.view === state.view);
  $('#content').replaceChildren(empty('正在读取…'));
  const views = { notes: renderNotes, proposals: renderProposals, snapshots: renderSnapshots, replay: renderReplay, policy: renderPolicy, health: renderHealth };
  const result = await views[state.view]();
  if (request === state.request) $('#content').replaceChildren(result);
}

async function refresh() { await loadState(); await render(); }

async function renderNotes() {
  const result = await api(`notes?${new URLSearchParams(roleParams({ q: state.query, offset: String(state.offset), limit: '100' }))}`);
  const search = h('input', { class: 'search', type: 'search', placeholder: '搜索正文或标签', value: state.query, 'aria-label': '搜索日记' });
  const detail = h('div', { class: 'panel note-detail' }, empty('选择一篇记录，查看正文、来源与管理操作。'));
  const rows = h('div', { class: 'note-list' });
  const selectNote = async (noteId) => {
    state.selected = noteId;
    for (const card of rows.children) card.classList.toggle('selected', card.dataset.note === noteId);
    const data = await api(`note?id=${encodeURIComponent(noteId)}`);
    if (state.selected !== noteId) return;
    detail.replaceChildren(await noteDetail(data.note, data.relations));
  };
  for (const note of result.items || []) {
    const card = h('button', { type: 'button', class: 'note-card', 'data-note': note.note_id, onclick: event => operate(event.currentTarget, () => selectNote(note.note_id)) },
      h('div', { class: 'status-line' }, h('span', { class: 'badge' }, kinds[note.kind] || note.kind), h('span', { class: 'date' }, date(note.source_time || note.created_at))),
      h('strong', {}, noteTitle(note)), h('p', {}, String(note.body || '').slice(0, 95)),
      h('div', { class: 'tags' }, (note.tags || []).slice(0, 4).map(tag => h('span', { class: 'tag' }, tag))));
    rows.append(card);
  }
  if (!rows.children.length) rows.append(empty('这里还没有匹配的记录。'));
  const toolbar = h('form', { class: 'toolbar', onsubmit: event => { event.preventDefault(); state.query = search.value; state.offset = 0; operate(null, render); } }, search, h('button', { class: 'button secondary', type: 'submit' }, '查找'), button('手写一条', () => { detail.replaceChildren(noteEditor(null)); }, ''));
  const pagination = h('div', { class: 'pagination' }, `${result.total || 0} 条 · 当前 ${Math.min(state.offset + 1, result.total || 0)}–${Math.min(state.offset + 100, result.total || 0)}`, h('div', { class: 'actions' },
    button('上一页', async () => { state.offset = Math.max(0, state.offset - 100); await render(); }), button('下一页', async () => { if (state.offset + 100 < result.total) { state.offset += 100; await render(); } })));
  const root = h('div', {}, toolbar, h('div', { class: 'two-pane' }, h('div', {}, rows, pagination), detail));
  const initial = result.items?.find(note => note.note_id === state.selected) || result.items?.[0];
  if (initial) await selectNote(initial.note_id);
  return root;
}

async function noteDetail(note, relations) {
  const container = h('div');
  const usage = note.usage_policy?.mode || note.usage_policy || note.state?.usage_policy || 'normal';
  const badges = h('div', { class: 'tags' }, h('span', { class: 'badge' }, kinds[note.kind] || note.kind), h('span', { class: 'badge muted' }, origins[note.origin] || note.origin || '来源未标记'));
  if (note.locked || note.state?.locked) badges.append(h('span', { class: 'badge warn' }, '已锁定'));
  if (note.lifecycle || note.state?.lifecycle) badges.append(h('span', { class: 'badge warn' }, prettyStatus(note.lifecycle || note.state.lifecycle)));
  container.append(h('div', { class: 'detail-header' }, h('div', {}, badges, h('h2', {}, noteTitle(note)), h('div', { class: 'detail-meta' }, `${labelRole(note.author_role_id)} · ${date(note.source_time || note.created_at)}`, h('br'), `语境：${note.context_id} · 使用：${usages[usage] || usage}`)), button('编辑', () => container.replaceChildren(noteEditor(note)))));
  container.append(h('div', { class: 'prose' }, note.body || ''), h('div', { class: 'tags' }, (note.tags || []).map(tag => h('span', { class: 'tag' }, tag))));
  container.append(h('h3', { class: 'section-heading' }, '原话与来源'));
  if (!note.sources?.length) container.append(h('p', { class: 'hint' }, '这条记录没有原话引用。使用者手写记录可以没有来源；它不应被说成过去发生过的对话。'));
  for (const source of note.sources || []) {
    container.append(h('div', { class: 'source' }, h('small', {}, source.event_id), h('p', { class: 'source-context' }, source.context_before || ''), h('blockquote', {}, source.quote || ''), h('p', { class: 'source-context' }, source.context_after || ''),
      button('查看完整原文', async () => {
        const event = await api(`event?id=${encodeURIComponent(source.event_id)}`);
        await confirmAction('原文事件', `${event.speaker || ''} · ${date(event.source_time || event.captured_at)} · ${event.origin || ''}`, `${event.text || ''}\n\n事件：${event.event_id}\n会话：${event.source?.session_id || '未知'}\n这只是来源记录，不代表对日记解释的认证。`, '关闭');
      }, 'text')));
  }
  if (relations?.length) {
    container.append(h('h3', { class: 'section-heading' }, '相关更正与后续'));
    for (const relation of relations) container.append(h('div', { class: 'source' }, h('strong', {}, `${relation.type} · ${prettyStatus(relation.status || relation.initial_status)}`), h('p', { class: 'hint' }, relation.reason || ''), h('small', {}, `${relation.from?.note_id} → ${relation.to?.note_id}`), h('details', {}, h('summary', {}, '查看关系与修订'), pre(relation))));
  }
  const usageSelect = h('select', {}, Object.entries(usages).map(([key, title]) => h('option', { value: key }, title)));
  usageSelect.value = usage;
  const management = h('section', {}, h('h3', { class: 'section-heading' }, '管理这条记录'), h('div', { class: 'toolbar' }, usageSelect, button('保存使用策略', () => performNoteAction(note, 'usage', { usage_policy: usageSelect.value }))),
    h('div', { class: 'actions' }, button('锁定', () => performNoteAction(note, 'lock')), button('解锁', () => performNoteAction(note, 'unlock')), button('撤回说法', () => container.replaceChildren(actionEditor(note, 'withdraw')), 'danger'), button('排除使用', () => container.replaceChildren(actionEditor(note, 'exclude')), 'danger'), button('恢复', () => container.replaceChildren(actionEditor(note, 'restore'))), button('归档', () => performNoteAction(note, 'archive'))),
    h('p', { class: 'hint' }, '锁定保护正文；撤回与排除影响后续召回。已经进入聊天历史的内容，需要在 DSH 中清理相关上下文或开启干净会话。'));
  container.append(management, h('details', {}, h('summary', {}, '记录编号与完整元数据'), pre(note)));
  return container;
}

function noteEditor(note) {
  const bodyInput = h('textarea', { rows: 16, required: true, maxlength: 131072 }, note?.body || '');
  const tagInput = h('input', { value: (note?.tags || []).join(', '), placeholder: '用逗号分隔' });
  const facetInput = h('input', { value: (note?.facets || []).join(', '), placeholder: '共同经历、决定理由、经验…' });
  const kindInput = h('select', {}, Object.entries(kinds).map(([key, name]) => h('option', { value: key }, name)));
  kindInput.value = note?.kind || 'diary';
  const operationKey = crypto.randomUUID();
  const form = h('form', { onsubmit: event => {
    event.preventDefault();
    operate(form.querySelector('button[type=submit]'), async () => {
      const payload = roleParams({ body: bodyInput.value, tags: tokens(tagInput.value), facets: tokens(facetInput.value), kind: kindInput.value, operation_key: operationKey });
      if (note) { payload.note_id = note.note_id; payload.expected_revision = note.revision_id; }
      if (!await confirmAction(note ? '保存这个修订' : '保存手写记录', note ? '保留旧修订，新内容受编辑保护。若原记录已撤回或排除，编辑不会自动恢复其召回资格。' : '这条内容标为使用者手写，不伪造原话或过去的共同经历。公共记录将明确发布到公共范围。', payload.body, '保存')) return;
      const result = await api('note', payload);
      state.selected = result.note_id || result.note?.note_id || note?.note_id;
      notify('已保存。新修订及保护状态可在记录中查看。');
      await render();
    });
  } }, h('h2', {}, note ? '编辑记录' : '手写一条记录'), h('p', { class: 'hint' }, note ? `正在编辑 ${note.note_id}。提交时会检查修订版本，避免覆盖其他编辑。` : `${labelRole(state.role)} · ${state.context}`),
    note ? null : field('类型', kindInput), field('正文', bodyInput), h('div', { class: 'row' }, field('标签', tagInput), field('用途', facetInput)), h('div', { class: 'actions' }, h('button', { class: 'button', type: 'submit' }, '保存'), button('返回', render)));
  return form;
}

function actionEditor(note, action) {
  const title = { withdraw: '撤回这项说法', exclude: '排除这条记忆', restore: '恢复这条记录' }[action];
  const reason = h('textarea', { rows: 3, placeholder: '可填写原因，方便以后回查', maxlength: 4000 });
  const includeSources = h('input', { type: 'checkbox' });
  const restoreActions = h('input', { placeholder: '有需要时填写明确的操作 ID，用逗号分隔' });
  let selectedSpan = null;
  const originalBody = h('textarea', { rows: 7, readonly: true }, note.body || '');
  const selectionStatus = h('p', { class: 'hint' }, '尚未选择部分范围；当前操作针对整条修订。');
  const approvedBody = h('textarea', { rows: 7, placeholder: '可选：手写或整理完整、语义连贯的保留正文。它将在同一次操作中成为获准使用的新修订。', maxlength: 131072 });
  const partialControls = action === 'withdraw' ? h('details', {}, h('summary', {}, '只撤回其中一部分'),
    h('p', { class: 'hint' }, '在下面原文中选中要撤回的部分，再记录选区。系统不会自动删字后拼接剩余内容。'), originalBody,
    h('div', { class: 'actions' }, button('记录所选范围', () => {
      const start = originalBody.selectionStart;
      const end = originalBody.selectionEnd;
      if (start === end) throw new Error('请先在正文中选中要撤回的文字。');
      const encoder = new TextEncoder();
      selectedSpan = { start_utf8_byte: encoder.encode(originalBody.value.slice(0, start)).length, end_utf8_byte: encoder.encode(originalBody.value.slice(0, end)).length };
      selectionStatus.textContent = `已选：${originalBody.value.slice(start, end)}`;
    }), button('改为整条撤回', () => { selectedSpan = null; selectionStatus.textContent = '当前操作针对整条修订。'; approvedBody.value = ''; })),
    selectionStatus, field('获准继续使用的完整正文', approvedBody, '留空时保留部分撤回的精确范围，但整条记录暂停默认召回，直到你批准安全可读的版本。')) : null;
  const form = h('form', { onsubmit: event => {
    event.preventDefault();
    operate(form.querySelector('button[type=submit]'), async () => {
      const extra = { reason: reason.value, include_known_derivatives: true };
      if (action === 'withdraw' && selectedSpan) {
        extra.targets = [{ note_id: note.note_id, revision_id: note.revision_id, body_spans: [selectedSpan] }];
        if (approvedBody.value.trim()) extra.approved_body = approvedBody.value;
      }
      if (includeSources.checked) extra.source_exclusions = (note.sources || []).map(source => ({ event_id: source.event_id, text_sha256: source.text_sha256, start_utf8_byte: source.start_utf8_byte, end_utf8_byte: source.end_utf8_byte }));
      if (action === 'restore' && restoreActions.value.trim()) extra.restore_action_ids = tokens(restoreActions.value);
      await performNoteAction(note, action, extra);
    });
  } }, h('h2', {}, title), h('p', { class: 'hint' }, noteTitle(note)),
    h('p', { class: 'callout' }, action === 'withdraw' ? '撤回影响这条已选修订的默认使用，历史与原文继续保留。只改错其中一部分时，可以先返回编辑，保留完整语义，再明确决定要使用的修订。' : action === 'exclude' ? '排除只表示以后不再自动使用，不裁定内容真假。已知派生内容也会等待复核。它不会擦除现有聊天历史或备份。' : '恢复只解除明确选择的限制。其他未解除的排除、来源限制或角色权限仍然生效。'),
    field('原因', reason), partialControls,
    action === 'withdraw' ? null : h('label', { class: 'check' }, includeSources, action === 'exclude' ? '同时排除这条记录引用的原文片段，阻止从这些片段再次补记。' : '同时申请恢复引用片段的使用（需明确相关排除操作 ID）。'),
    action === 'restore' ? field('要解除的操作 ID', restoreActions, '留空时只恢复当前条目的限制，不顺便恢复被排除的原文。') : null,
    h('details', {}, h('summary', {}, '所选修订与引用范围'), pre({ note_id: note.note_id, revision_id: note.revision_id, sources: note.sources })),
    h('div', { class: 'actions' }, h('button', { class: `button ${action === 'restore' ? '' : 'danger'}`, type: 'submit' }, '预览并提交'), button('返回', render)));
  return form;
}

async function performNoteAction(note, action, extra = {}) {
  const payload = { action, targets: [{ note_id: note.note_id, revision_id: note.revision_id }], ...extra };
  const description = action === 'restore' ? '只恢复所选修订及明确列出的限制；不会自动批准其他待处理更正。' : '请核对目标和范围。操作将写入管理记录；不会改写对话原文。';
  if (!await confirmAction(`确认：${({ withdraw: '撤回', exclude: '排除', restore: '恢复', lock: '锁定', unlock: '解锁', usage: '调整使用策略', archive: '归档' })[action]}`, description, payload)) return;
  await api('action', payload);
  notify('管理决定已提交。之后的召回将按新状态处理；现有聊天历史不会因此自动清空。');
  await render();
}

async function renderProposals() {
  const proposals = list(await api('proposals'));
  const noteIds = h('textarea', { rows: 2, placeholder: '要整理的 note_id，用逗号或换行分隔' });
  const kind = h('select', {}, h('option', { value: 'merge' }, '合并建议'), h('option', { value: 'impression' }, '印象修订建议'), h('option', { value: 'association' }, '关联线索建议'), h('option', { value: 'writing_rules' }, '日记写作规则建议'));
  const generate = button('准备整理提议', async () => {
    const ids = tokens(noteIds.value);
    if (!ids.length) throw new Error('请先填写要整理的记录编号。');
    if (!await confirmAction('准备整理提议', '将调用已配置的写作模型，结果进入提议，不直接覆盖或隐藏日记。', { role: labelRole(state.role), kind: kind.value, note_ids: ids }, '生成提议')) return;
    await api('organize', roleParams({ note_ids: ids, kind: kind.value }));
    notify('整理任务已处理。查看下面的新提议。');
    await render();
  }, '');
  const root = h('div', {}, panel('准备一次整理', h('p', { class: 'hint' }, '批准的是已展示的确切内容。目标修订发生变化时，旧提议不能继续覆盖它。'), field('记录编号', noteIds), h('div', { class: 'toolbar' }, kind, generate)));
  if (!proposals.length) root.append(panel('', empty('没有待处理或历史提议。')));
  for (const proposal of proposals.slice().reverse()) {
    const currentStatus = proposal.status || proposal.initial_status || 'proposed';
    const card = panel(`${proposal.kind || proposal.type || '记忆提议'} · ${prettyStatus(currentStatus)}`,
      h('p', { class: 'note-id' }, proposal.proposal_id), h('p', { class: 'proposal-body' }, proposal.reason || proposal.description || ''),
      h('p', { class: 'hint' }, `生成时间：${date(proposal.created_at)}。先检查完整内容、来源与受影响修订，再决定。`));
    const newContent = proposal.body || proposal.new_content || proposal.newContent || proposal.payload?.body;
    if (newContent) card.append(h('div', { class: 'prose' }, newContent));
    const expectedTargets = Array.isArray(proposal.expected) ? proposal.expected.filter(target => target.note_id) : [];
    if (expectedTargets.length) {
      const comparison = h('div');
      card.append(button('展开原修订对照', async () => {
        comparison.replaceChildren(empty('正在读取提议引用的原修订…'));
        const originals = [];
        for (const target of expectedTargets) {
          const data = await api(`note?${new URLSearchParams({ id: target.note_id, ...(target.revision_id ? { revision: target.revision_id } : {}) })}`);
          originals.push(panel(noteTitle(data.note), h('p', { class: 'note-id' }, `${target.note_id} · ${target.revision_id || data.note.revision_id}`), h('div', { class: 'prose' }, data.note.body || ''), h('details', {}, h('summary', {}, '原引用'), pre(data.note.sources || []))));
        }
        comparison.replaceChildren(h('h3', { class: 'section-heading' }, '提议依据的原修订'), ...originals, h('h3', { class: 'section-heading' }, '拟提交的确切内容与效果'), pre({ new_files: proposal.new_files, effects: proposal.effects, body: newContent, payload: proposal.payload }));
      }, 'text'), comparison);
    }
    card.append(h('details', { open: currentStatus === 'proposed' }, h('summary', {}, '确切提议内容与操作范围'), pre(proposal)));
    if (['proposed', 'pending_review'].includes(currentStatus)) {
      const decide = async decision => {
        if (!await confirmAction(decision === 'approve' ? '批准这份提议' : '拒绝这份提议', decision === 'approve' ? '执行下列确切内容和效果。目标已变化时操作会停止，不自动重新生成另一份内容。' : '拒绝决定会保留，相同材料不会反复要求审批。', proposal, decision === 'approve' ? '批准并执行' : '拒绝')) return;
        await api('proposal/decide', { proposal_id: proposal.proposal_id, decision, expected: proposal.proposal_hash || proposal.expected });
        notify(decision === 'approve' ? '提议已批准并提交。' : '提议已拒绝。');
        await render();
      };
      card.append(h('div', { class: 'actions' }, button('批准并执行', () => decide('approve'), ''), button('拒绝', () => decide('reject'))));
    }
    root.append(card);
  }
  return root;
}

async function renderSnapshots() {
  const snapshots = list(await api('snapshots'));
  const root = h('div', {}, panel('', h('p', {}, '这里保存实际交给模型的记忆快照。它说明当时提供了哪些材料，不等于解释模型全部思考过程。')));
  if (!snapshots.length) root.append(panel('', empty('还没有注入记录。')));
  for (const snapshot of snapshots.slice().reverse()) {
    const isPreview = String(snapshot.turn_id || '').startsWith('management-preview:');
    root.append(panel(isPreview ? '使用者手动预览 · 尚未发送给聊天模型' : `回合 ${snapshot.turn_id || '未知'}`,
      h('div', { class: 'tags' }, h('span', { class: 'badge' }, snapshot.engine || '未记录引擎'), h('span', { class: 'badge muted' }, `${snapshot.estimated_tokens ?? '?'} token`)),
      h('p', { class: 'note-id' }, snapshot.snapshot_id), h('div', { class: 'prose' }, snapshot.rendered_text || '本次没有注入相关记忆。'),
      h('div', { class: 'actions' }, button('用这个快照回放', async () => { state.replaySnapshot = snapshot.snapshot_id; state.view = 'replay'; await render(); })),
      h('details', {}, h('summary', {}, '条目修订、遗漏原因及请求关联'), pre(snapshot))));
  }
  return root;
}

function renderReplay() {
  const question = h('textarea', { rows: 5, required: true, placeholder: '输入要比较的历史问题，或当前想观察的问法。', maxlength: 16000 });
  const snapshot = h('input', { value: state.replaySnapshot || '', placeholder: '可从“回答的记忆依据”选择' });
  const modified = h('textarea', { rows: 2, placeholder: '要用于修订条件的 note_id，可留空' });
  const session = h('input', { placeholder: '可选：使用这个会话的实际读取权限' });
  const output = h('div');
  const form = h('form', { onsubmit: event => {
    event.preventDefault();
    operate(form.querySelector('button[type=submit]'), async () => {
      const payload = roleParams({ question: question.value, snapshot_id: snapshot.value.trim() || undefined, modified_note_ids: tokens(modified.value), session_id: session.value.trim() || undefined });
      if (!await confirmAction('运行隔离回放', '这会调用已配置的模型，比较无记忆、历史快照、修订后记忆。回放不会调用真实工具或写回日记。输出具有随机性。', { question: payload.question, snapshot_id: payload.snapshot_id, modified_note_ids: payload.modified_note_ids }, '开始回放')) return;
      output.replaceChildren(empty('正在生成回放结果…'));
      const result = await api('replay', payload);
      const cases = result.conditions || result.results || result.runs;
      if (Array.isArray(cases)) output.replaceChildren(h('div', { class: 'result-grid' }, cases.map(item => panel(item.label || item.condition || item.name || '回放结果', h('div', { class: 'prose' }, item.text || item.answer || item.output || JSON.stringify(item, null, 2)), item.usage ? h('details', {}, h('summary', {}, '调用用量'), pre(item.usage)) : null))), h('details', {}, h('summary', {}, '完整回放记录'), pre(result)));
      else output.replaceChildren(panel('回放结果', pre(result)));
      notify('回放结束。结果不会成为新的真实经历。');
    });
  } }, field('问题', question), h('div', { class: 'row' }, field('原始快照编号', snapshot), field('实际会话编号', session)), field('修订后记忆编号', modified), h('button', { class: 'button', type: 'submit' }, '预览并运行'));
  return h('div', {}, panel('比较记忆怎样影响回答', h('p', { class: 'callout' }, '重点看是否接得上经历、尊重当前变化、使用正确理由，以及有没有唐突地提及旧事。一次回答更讨喜，不代表它更准确。'), form), output);
}

function renderPolicy() {
  const role = state.config.roles.find(item => item.id === state.role);
  const ownAlias = role?.alias || role?.id || '';
  const selections = new Map();
  const chips = h('div', { class: 'role-chips' });
  const output = h('textarea', { rows: 7, readonly: true });
  const publicBox = h('input', { type: 'checkbox', checked: true });
  const timelineBox = h('input', { type: 'checkbox' });
  const validAlias = value => /^[a-z][a-z0-9_]*$/.test(value);
  const update = () => {
    if (!validAlias(ownAlias)) { output.value = '当前角色未配置合法占位符别名。请在插件配置 roles[].alias 中设置小写字母开头的字母、数字或下划线名称。'; return; }
    const lines = [`{{mem_self_${ownAlias}}}`];
    for (const [id, check] of selections) if (check.checked && id !== state.role) {
      const peer = state.config.roles.find(item => item.id === id);
      const alias = peer.alias || peer.id;
      if (validAlias(alias)) lines.push(`{{mem_read_${alias}}}`);
    }
    if (publicBox.checked) lines.push('{{mem_public}}');
    if (timelineBox.checked) lines.push(`{{mem_timeline_${ownAlias}}}`);
    output.value = lines.join('\n');
  };
  for (const peer of state.config.roles) {
    const check = h('input', { type: 'checkbox', checked: peer.id === state.role, disabled: peer.id === state.role, onchange: update });
    selections.set(peer.id, check);
    chips.append(h('label', { class: 'check' }, check, peer.name || peer.id));
  }
  publicBox.addEventListener('change', update);
  timelineBox.addEventListener('change', update);
  update();
  const previewQuery = h('textarea', { rows: 3, required: true, placeholder: '输入一个问题，看看当前规则会选出哪些记忆。', maxlength: 4000 });
  const previewSession = h('input', { placeholder: '可选：采用已有会话的实际读取权限' });
  const previewExplicit = h('input', { type: 'checkbox' });
  const previewOutput = h('div');
  const previewForm = h('form', { onsubmit: event => {
    event.preventDefault();
    operate(previewForm.querySelector('button[type=submit]'), async () => {
      const payload = roleParams({ query: previewQuery.value, session_id: previewSession.value.trim() || undefined, explicit: previewExplicit.checked });
      const result = await api('preview', payload);
      previewOutput.replaceChildren(h('div', { class: 'prose' }, result.rendered_text || '没有相关且符合使用规则的记忆。'), h('details', {}, h('summary', {}, '候选修订、预算和省略原因'), pre(result)));
      notify('候选预览已完成，没有生成聊天回复；预览快照单独标记。');
    });
  } }, field('预览问题', previewQuery), field('会话编号', previewSession, '留空时只按所选角色自身与公共范围预览，不假定能读取其他角色。'), h('label', { class: 'check' }, previewExplicit, '这是一次明确要求回顾，允许使用“仅明确回顾”的记录。'), h('p', { class: 'hint' }, '点击后可能调用配置的查询嵌入服务，但不会调用聊天模型或写入日记。'), h('button', { type: 'submit', class: 'button' }, '预览当前候选'));
  return h('div', {}, panel('人设里的读取声明', h('p', {}, '这页生成供你手写进 DSH 人设前缀的声明，不会直接修改人设或授予角色权限。请放在原生人设的 prefix 部分；当前适配器不从可能被忽略的 suffix 授权。实际会话以宿主解析后的绑定为准。'), h('h3', {}, '允许读取哪些角色的记忆'), chips, h('label', { class: 'check' }, publicBox, '允许读取公共记录'), h('label', { class: 'check' }, timelineBox, '提供自己的时间线入口'), field('占位符', output), button('复制声明', async () => { await navigator.clipboard.writeText(output.value); notify('已复制。请粘贴到相应角色的人设前缀（prefix）中。'); }, '')),
    panel('管理后的候选预览', previewForm, previewOutput),
    panel('每条记忆的使用方式', ...Object.entries(usages).map(([key, label]) => h('div', { class: 'list-line' }, h('div', {}, h('strong', {}, label), h('small', {}, ({ normal: '相关时进入候选，不强行提起。', prefer_when_relevant: '在相关候选中优先，仍受纠错与预算限制。', explicit_only: '仅在使用者明确要求回顾时使用。', excluded: '停止默认使用；可同时选择排除来源片段。' })[key])))),
    panel('共享的边界', h('p', {}, '公开一段经过批准的摘录，不等于公开整个私人会话。角色读到其他角色的日记，也不应把它说成自己亲历。'), h('p', { class: 'hint' }, '撤销读取权限后，下一个模型请求必须清理相关历史或重建上下文。单纯从下次检索中过滤，不能收回已经进入会话的内容。')));
}

function renderHealth() {
  const health = state.health || {};
  const session = h('input', { placeholder: '有实际会话时填写，补记会使用它的身份绑定' });
  const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7) });
  const output = h('div', {}, state.maintenanceResult ? panel(state.maintenanceResult.title, pre(state.maintenanceResult.result)) : null);
  const doOperation = async (route, payload, title, description) => {
    if (!await confirmAction(title, description, payload, '执行')) return;
    const result = await api(route, payload);
    state.maintenanceResult = { title, result };
    notify('操作已完成。下方保留返回结果。');
    await loadState();
    await render();
  };
  const contextPayload = () => roleParams({ session_id: session.value.trim() || undefined });
  const jobs = list(health.diary?.jobs);
  const jobList = panel('后台任务', jobs.length ? null : empty('目前没有可显示的后台任务。'));
  for (const job of jobs.slice(-40).reverse()) {
    const row = h('div', { class: 'list-line' }, h('div', {}, h('strong', {}, `${job.kind || '补记'} · ${prettyStatus(job.status)}`), h('small', {}, `${labelRole(job.role_id)} · ${job.job_id}`), job.error ? h('small', {}, typeof job.error === 'string' ? job.error : JSON.stringify(job.error)) : null));
    if (job.retryable === true) {
      const acknowledge = h('input', { type: 'checkbox' });
      const retry = button('继续处理', async () => {
        const payload = { role_id: job.role_id || state.role, context_id: job.context_id || state.context, session_id: job.session_id || undefined, job_id: job.job_id, acknowledge_unknown: acknowledge.checked };
        await doOperation('backfill/retry', payload, '继续后台任务', acknowledge.checked ? '你明确允许在前次调用结果未知时重新请求模型；前次请求可能已经计费。系统仍会保护已提交条目的幂等性。' : '只继续可安全恢复的材料。前次调用结果未知时，任务会继续暂停，不自动重复请求模型。');
      });
      row.append(h('div', {}, job.outcome_unknown ? h('p', { class: 'hint' }, '上次模型请求的结果未知，可能已经计费。') : null, h('label', { class: 'check' }, acknowledge, '结果未知时，允许重新调用模型'), retry));
    }
    jobList.append(row);
  }
  const cards = h('div', { class: 'summary-grid' },
    h('div', { class: 'summary' }, h('small', {}, '记忆来源'), h('strong', {}, '普通文件'), h('small', {}, '索引可以重建，管理决定保留')),
    h('div', { class: 'summary' }, h('small', {}, '配置的检索方式'), h('strong', {}, state.config.recall?.engine || '未配置'), h('small', {}, `每轮预算 ${state.config.recall?.tokenBudget ?? '未配置'} token；实际状态见下方`)),
    h('div', { class: 'summary' }, h('small', {}, '后台预算'), h('strong', {}, state.config.diary?.dailyTokenBudget ?? '未配置'), h('small', {}, '每日输入与输出 token 合计')));
  return h('div', {}, cards, panel('当前运行状态', h('p', { class: 'hint' }, '捕获、补记与检索分别报告进度和故障。检索不可用时，不代表原文也已停止保存。'), pre(health)), jobList,
    panel('补记与时间线', field('实际会话编号', session), h('div', { class: 'actions' }, button('处理补记积压', () => doOperation('backfill', contextPayload(), '处理补记积压', '调用后台写作模型，继续已记录的对话材料。遵守来源范围与后台预算，不生成离线经历。'), '')), h('hr'), field('月份', month), h('div', { class: 'actions' },
      button('生成机械时间目录', () => doOperation('timeline', { ...contextPayload(), month: month.value, generate: false }, '生成时间目录', '按现有日记组织目录，不生成新的事实解释。')),
      button('准备月度摘要提议', () => doOperation('timeline', { ...contextPayload(), month: month.value, generate: true }, '准备月度摘要', '调用写作模型生成带来源的提议；摘要不常驻系统提示词。')))),
    panel('索引与文件', h('p', {}, '外部编辑后可以同步文件状态。重建只处理可重建索引，不删除日记、原文、锁定或排除决定。'), h('div', { class: 'actions' },
      button('同步外部编辑', () => doOperation('reconcile', {}, '同步外部编辑', '读取文件变化、保存观察到的修订并保护外部编辑。')),
      button('重建索引', () => doOperation('rebuild', contextPayload(), '重建所选范围索引', '可能调用嵌入服务并产生费用。索引是派生资料，原始内容继续保留。')))),
    panel('完整导出', h('p', {}, '导出包含原文、日记、修订和管理状态。目的地由本地配置限定，页面不能指定任意系统路径。'), button('导出一份完整备份', () => doOperation('export', { name: 'memory-backup' }, '导出完整库', '将保存当前记忆库的完整副本，其中包含私人原文。请妥善保管导出目录。'), '')),
    panel('部署边界', h('p', {}, '管理令牌只属于使用者。模型可控的文件、shell 或浏览器工具必须与私有目录及管理会话隔离。本机地址与访问令牌不能代替操作系统权限边界。'), pre(state.config.security)), output);
}

for (const nav of document.querySelectorAll('[data-view]')) nav.addEventListener('click', () => operate(nav, async () => { state.view = nav.dataset.view; await render(); }));
$('#refresh-button').addEventListener('click', event => operate(event.currentTarget, refresh));
$('#role-select').addEventListener('change', event => operate(null, async () => { state.role = event.target.value; state.offset = 0; state.selected = null; await render(); }));
$('#context-input').addEventListener('change', event => operate(null, async () => { state.context = event.target.value.trim() || 'default'; state.offset = 0; state.selected = null; await render(); }));
$('#login-form').addEventListener('submit', event => {
  event.preventDefault();
  operate(event.submitter, async () => {
    const value = $('#token-input').value.trim();
    if (value.startsWith('http')) {
      const url = new URL(value);
      if (url.origin !== location.origin) throw new Error('这不是当前管理服务的链接，请直接打开完整的新链接。');
      state.token = new URLSearchParams(url.hash.slice(1)).get('token') || '';
    } else state.token = value;
    $('#token-input').value = '';
    await refresh();
    notify('已连接。');
  });
});

state.token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
if (state.token) operate(null, refresh);
else {
  $('#connection').className = 'connection';
  $('#connection').textContent = '等待连接';
  $('#login-panel').hidden = false;
  $('#content').replaceChildren(empty('连接后可以查看和管理这台机器上的记忆库。'));
}
