import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as scope from '../memory-scope.js';
import * as memory from '../memory-engine.js';
import * as core from '../core.js';

const fact = (id, sourceChatId = 'a') => ({ id, text: `memory ${id}`, active: true, origin: 'auto', sourceChatId, sourceId: 0, knowledge: { Persona: 'known' } });
const fixture = () => ({ uuid: 'character-unique', version: 2, facts: [fact('shared')], candidates: [], chats: { a: { autoMemory: { cursor: 3, journal: [{ changes: [{ id: 'shared', before: null }] }] } }, b: {} },
    nameAliases: [{ alias: 'P', canonical: 'Persona' }], collectionPreferences: { focus: ['secrets'], custom: '' },
    rejectedMemories: [{ id: 'excluded', text: 'wrong memory', sourceChatId: 'a', sourceId: 1 }] });

test('existing and new rooms share the exact original store by default', () => {
    const root = fixture(), snapshot = JSON.stringify(root);
    assert.equal(scope.selectedMemoryStore(root, 'a'), root);
    assert.equal(scope.selectedMemoryStore(root, 'brand-new'), root);
    assert.equal(JSON.stringify(root), snapshot);
});

test('empty separation preserves every shared memory and starts collection after existing messages', () => {
    const root = fixture();
    const sharedBefore = JSON.stringify(root.facts);
    const privateStore = scope.separateRoomMemory(root, 'b', 2500);
    assert.deepEqual(privateStore.facts, []);
    assert.equal(privateStore.chats.b.autoMemory.cursor, 2500);
    assert.equal(scope.selectedMemoryStore(root, 'a'), root);
    assert.equal(scope.selectedMemoryStore(root, 'b'), privateStore);
    privateStore.facts.push(fact('private', 'b'));
    assert.equal(JSON.stringify(root.facts), sharedBefore);
    assert.equal(scope.selectedMemoryStore(JSON.parse(JSON.stringify(root)), 'b').facts[0].id, 'private');
});

test('copy deep-clones memories, locks, history, aliases; excludes source journals, embeddings and registries', () => {
    const root = fixture(); root.facts[0].pinned = true;
    root.facts.push({ ...fact('past'), active: false, archived: true, supersededBy: 'shared' });
    root.embeddingIndex = { entries: { shared: [1, 2] } };
    const isolated = scope.separateRoomMemory(root, 'b', 15, root);
    assert.equal(isolated.facts[0].pinned, true);
    assert.equal(isolated.facts[1].supersededBy, 'shared');
    assert.deepEqual(isolated.chats.b.autoMemory.journal, []);
    assert.equal(isolated.chats.a, undefined);
    assert.equal(isolated.embeddingIndex, undefined);
    assert.equal(isolated.chatMemoryScopes, undefined);
    isolated.facts[0].knowledge.Persona = 'unknown'; isolated.nameAliases[0].canonical = 'Another';
    assert.equal(root.facts[0].knowledge.Persona, 'known');
    assert.equal(root.nameAliases[0].canonical, 'Persona');
});

test('copying a separate room replaces only the target and later cleanup does not change source', () => {
    const root = fixture();
    const a = scope.separateRoomMemory(root, 'a', 10, root);
    a.facts[0].pinned = false;
    const b = scope.separateRoomMemory(root, 'b', 20, a);
    b.facts.push(fact('second','b'));
    memory.evictOldestMemories(b, 1, 'b');
    assert.equal(a.facts[0].active, true);
    assert.equal(root.facts[0].active, true);
    assert.equal(b.facts.filter(f => f.active && memory.isCurrent(f)).length, 1);
});

test('sharing again preserves private snapshot and skips private backlog in shared collector', () => {
    const root = fixture();
    const isolated = scope.separateRoomMemory(root, 'a', 3); isolated.facts.push(fact('private'));
    scope.shareRoomMemory(root, 'a', 50);
    assert.equal(scope.selectedMemoryStore(root, 'a'), root);
    assert.equal(root.chats.a.autoMemory.cursor, 50);
    assert.deepEqual(root.chats.a.autoMemory.journal, []);
    assert.equal(root.facts.length, 1);
    assert.equal(scope.resumeRoomMemory(root, 'a'), isolated);
    assert.equal(scope.selectedMemoryStore(root, 'a').facts[0].id, 'private');
});

for (const independent of [false, true]) test(`reset, independent=${independent}: clears only target including locked facts and undo`, () => {
    const root = fixture();
    const other = scope.separateRoomMemory(root, 'other', 7, root);
    const before = JSON.stringify(other);
    if (independent) scope.separateRoomMemory(root, 'a', 4, root);
    const old = scope.selectedMemoryStore(root, 'a'); old.facts[0].pinned = true;
    old.chats.a.lastReview = { checked: 40 };
    const sharedFacts = JSON.stringify(root.facts);
    const fresh = scope.resetRoomMemory(root, 'a', 50);
    assert.deepEqual(fresh.facts, []); assert.deepEqual(fresh.candidates, []);
    assert.equal(fresh.nameAliases, undefined); assert.equal(fresh.rejectedMemories, undefined);
    assert.equal(fresh.chats.a.lastReview, undefined);
    assert.deepEqual(fresh.chats.a.autoMemory.journal, []);
    assert.equal(fresh.chats.a.autoMemory.cursor, 50);
    assert.deepEqual(fresh.collectionPreferences, { focus: ['secrets'], custom: '' });
    assert.equal(JSON.stringify(other), before); assert.equal(JSON.stringify(root.facts), sharedFacts);
    assert.equal(memory.undoLatestMemoryBatch(fresh, fresh.chats.a), 0);
});

test('source list identifies shared rooms honestly and keeps separate rooms separate', () => {
    const root = fixture(); scope.separateRoomMemory(root, 'private', 0);
    const sources = scope.memoryCopySources(root, 'b');
    assert.equal(sources.some(s => s.key === 'room:b'), false);
    assert.equal(sources.find(s => s.key === 'room:a').shared, true);
    assert.equal(sources.find(s => s.key === 'room:a').store, root);
    assert.equal(sources.find(s => s.key === 'room:private').shared, false);
});

test('special room filenames cannot modify object prototypes', () => {
    const root = fixture(); scope.separateRoomMemory(root, '__proto__', 5);
    assert.equal(scope.selectedMemoryStore(root, '__proto__').chats.__proto__.autoMemory.cursor, 5);
    assert.equal({}.independent, undefined);
    assert.equal(scope.selectedMemoryStore(root, 'constructor'), root);
});

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function storageHarness() {
    const config = { characterStores: {} };
    const ctx = { characterId: 0, chatId: 'a', chat: [{ is_user: false, mes: 'existing reply' }], chatMetadata: {}, saveSettingsDebounced() {}, saveMetadata() {} };
    const box = { ...scope, ...memory, ...core, context: () => ctx, settings: () => config,
        ensureCharacterUuid: () => `character-${ctx.characterId}`, NAME: 'hundredlog', LEGACY_NAME: 'memorybean', diagnosticError() {} };
    vm.createContext(box);
    vm.runInContext(index.slice(index.indexOf('function sourceChatId('), index.indexOf('async function save(')), box);
    return { box, ctx, config };
}

test('real data routing survives reload, separates characters and does not prune shared memory from a private room', () => {
    const h = storageHarness(), a = h.box.data(); a.facts.push(fact('shared','b'));
    h.ctx.chatId = 'b'; assert.equal(h.box.data(), a);
    const isolated = scope.separateRoomMemory(a, 'b', 1); isolated.facts.push(fact('private','b'));
    assert.equal(h.box.data(), isolated);
    h.ctx.chat = Array.from({ length: 150 }, () => ({ is_user: false, mes: 'later' }));
    h.box.data(); assert.equal(a.facts.length, 1);
    assert.equal(isolated.facts.length, 0);
    h.ctx.characterId = 1; assert.notEqual(h.box.data(), a); assert.equal(h.box.data().facts.length, 0);
    h.ctx.characterId = 0; h.ctx.chatId = 'a'; assert.equal(h.box.data(), a);
});

test('legacy migration does not refill a reset independent room on reopen', () => {
    const h = storageHarness(); h.ctx.chatMetadata.hundredlog = { facts: [fact('legacy')], candidates: [] };
    const root = h.box.data(); assert.equal(root.facts.length, 1);
    scope.resetRoomMemory(root, 'a', h.ctx.chat.length);
    assert.equal(h.box.data().facts.length, 0);
    assert.equal(h.box.data().facts.length, 0);
    assert.equal(root.facts.length, 1);
});

class Element {
    constructor() { this.children = []; this.listeners = {}; this._value = ''; this.hidden = false; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get options() { return this.children; }
    get value() { return this._value || this.children[0]?.value || ''; }
    set value(value) { this._value = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    async fire(type) { return this.listeners[type]?.({ target: this }); }
}
function uiHarness() {
    const h = storageHarness();
    const nodes = new Map(); const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
    Object.assign(h.box, { $id: get, document: { createElement: () => new Element() },
        busy: false, extracting: false, translating: false, normalGenerating: false, memoryRun: null,
        memoryEpoch: 0, sourceMutationTimer: null, collectionStatusText: '',
        chatKey: c => `${c.characterId}:${c.chatId}`, stopCollection() {}, stopReviewJob() {}, clearTimeout,
        clearLegacyPrompt: async () => {}, refreshCollectionStatus() {}, save: async () => {}, status: s => h.status = s,
        makeButton: (label, fn) => { const b = new Element(); b.textContent = label; b.listeners.click = fn; return b; },
        render: () => h.box.renderMemoryScope(h.box.data(), false),
    });
    vm.runInContext(index.slice(index.indexOf("let memoryScopeChoiceKey = ''"), index.indexOf('function render() {')), h.box);
    h.root = h.box.data(); h.root.facts.push(fact('shared'));
    h.box.bindMemoryScope(); h.box.render();
    h.get = get;
    h.confirm = async label => {
        const button = get('memory-scope-choice').children[1]?.children.find(b => b.textContent === label);
        assert.ok(button, `missing confirmation: ${label}`); await button.fire('click');
    };
    return h;
}

test('actual UI: separate empty, restore shared, resume, reset and import all target the chosen scope', async () => {
    const h = uiHarness(), toggle = h.get('separate-memory');
    toggle.checked = true; await toggle.fire('change'); await h.confirm('빈 기억으로 시작');
    assert.equal(h.box.data().facts.length, 0); assert.equal(h.root.facts.length, 1);
    h.box.data().facts.push(fact('private'));
    toggle.checked = false; await toggle.fire('change'); await h.confirm('공용 기억 사용');
    assert.equal(h.box.data(), h.root);
    toggle.checked = true; await toggle.fire('change'); await h.confirm('보관된 독립 기억 이어쓰기');
    assert.equal(h.box.data().facts[0].id, 'private');
    await h.get('memory-reset').fire('click'); await h.confirm('이 방만 초기화');
    assert.equal(h.box.data().facts.length, 0); assert.equal(h.root.facts.length, 1);
    const other = scope.separateRoomMemory(h.root, 'other', 1); other.facts.push(fact('other','other'));
    h.box.render(); h.get('memory-source').value = 'room:other';
    await h.get('memory-import').fire('click'); await h.confirm('복사해서 가져오기');
    assert.equal(h.box.data().facts[0].id, 'other');
    h.box.data().facts[0].text = 'edited copy'; assert.notEqual(other.facts[0].text, 'edited copy');
});

test('scope toggle visibly waits for a choice and only checks after applying it', async () => {
    const h = uiHarness(), toggle = h.get('separate-memory'), panel = h.get('memory-scope-choice');
    let scrolled = 0, focused = 0;
    panel.scrollIntoView = () => scrolled++;
    panel.focus = () => focused++;
    toggle.checked = true; await toggle.fire('change');
    assert.equal(toggle.checked, false);
    assert.equal(toggle.indeterminate, true);
    assert.equal(panel.hidden, false);
    assert.equal(scrolled, 1); assert.equal(focused, 1);
    assert.equal(h.box.data(), h.root);
    h.box.render(); assert.equal(toggle.indeterminate, true);
    await h.confirm('취소');
    assert.equal(toggle.indeterminate, false); assert.equal(toggle.checked, false);
    toggle.checked = true; await toggle.fire('change'); await h.confirm('빈 기억으로 시작');
    assert.equal(toggle.indeterminate, false); assert.equal(toggle.checked, true);
    assert.equal(panel.hidden, true); assert.equal(h.box.data().facts.length, 0);
    assert.equal(h.root.facts.length, 1);
});

test('scope confirmation is placed immediately after the toggle for narrow screens', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(html, /id="hundredlog-separate-memory"[^]*?<\/label>\s*<div id="hundredlog-memory-scope-choice"/);
});

test('automatic collection ignores an empty or greeting-only room, then follows the reply interval', () => {
    const h = storageHarness();
    h.box.positiveInteger = (n, fallback) => Math.max(1, Number(n) || fallback);
    vm.runInContext(index.slice(index.indexOf('function completedAssistantCount('), index.indexOf('function scheduleMemory(')), h.box);
    const root = h.box.data(); h.config.analysisInterval = 1;
    h.ctx.chat = []; assert.equal(h.box.memoryDue(root, h.ctx), false);
    h.ctx.chat = [{ is_user: false, mes: 'greeting' }];
    assert.equal(h.box.memoryDue(root, h.ctx), false);
    h.ctx.chat.unshift({ is_system: true, mes: 'system' }, { is_hidden: true, mes: 'hidden' });
    assert.equal(h.box.memoryDue(root, h.ctx), false);
    h.ctx.chat.push({ is_user: true, mes: 'hello' }, { is_user: false, mes: 'reply' });
    root.chats.a.autoMemory = { cursor: 4, offset: 0, journal: [] };
    assert.equal(h.box.memoryDue(root, h.ctx), true);
    h.config.analysisInterval = 2; assert.equal(h.box.memoryDue(root, h.ctx), false);
    h.ctx.chat.push({ is_user: true, mes: 'next' }, { is_user: false, mes: 'second reply' });
    assert.equal(h.box.memoryDue(root, h.ctx), true);
});

test('reset on shared UI separates first and leaves other shared rooms untouched', async () => {
    const h = uiHarness(); h.root.facts[0].pinned = true;
    await h.get('memory-reset').fire('click'); await h.confirm('이 방만 초기화');
    assert.equal(h.box.data().facts.length, 0); assert.equal(h.root.facts[0].pinned, true);
    h.ctx.chatId = 'other-shared'; assert.equal(h.box.data(), h.root);
});

test('pending confirmation cannot apply after switching rooms', async () => {
    const h = uiHarness(); await h.get('memory-reset').fire('click');
    const before = JSON.stringify(h.root.facts);
    h.ctx.chatId = 'other'; await h.confirm('이 방만 초기화');
    assert.equal(JSON.stringify(h.root.facts), before); assert.equal(h.root.chatMemoryScopes, undefined);
});

test('confirmation refuses mutation during generation or collection', async () => {
    for (const flag of ['normalGenerating', 'extracting', 'translating', 'busy', 'memoryRun']) {
        const h = uiHarness(); await h.get('memory-reset').fire('click');
        h.box[flag] = true; await h.confirm('이 방만 초기화');
        assert.equal(h.root.chatMemoryScopes, undefined);
    }
});

test('chat change during asynchronous prompt clear also cancels reset', async () => {
    const h = uiHarness(); h.box.clearLegacyPrompt = async () => { h.ctx.chatId = 'other'; };
    await h.get('memory-reset').fire('click'); await h.confirm('이 방만 초기화');
    assert.equal(h.root.chatMemoryScopes, undefined);
});
