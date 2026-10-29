import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as scope from '../memory-scope.js';
import * as memory from '../memory-engine.js';
import * as core from '../core.js';
import { createFileStorage } from '../file-storage.js';
import { compactConfig } from '../retention.js';

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

test('source list shows shared storage once and only lists other independent rooms', () => {
    const root = fixture(); scope.separateRoomMemory(root, 'private', 0);
    scope.separateRoomMemory(root, 'b', 0);
    const before = JSON.stringify(root);
    const sources = scope.memoryCopySources(root, 'b');
    assert.equal(sources.some(s => s.key === 'room:b'), false);
    assert.equal(sources.some(s => s.key === 'room:a'), false);
    assert.equal(sources.filter(s => s.store === root).length, 1);
    assert.equal(sources.find(s => s.key === 'shared').store, root);
    assert.equal(sources.find(s => s.key === 'room:private').shared, false);
    assert.equal(JSON.stringify(root), before);
});

test('character reset clears every memory store and history but keeps identity, preferences and independent routing', () => {
    const root = fixture();
    root.facts.push({ ...fact('manual'), pinned: true, origin: 'manual' });
    root.embeddingIndex = { entries: { shared: { vector: [1] } } };
    root.lastReview = { text: 'old report' }; root.collectionExclusions = { items: [{ text: 'old quote' }] };
    const privateStore = scope.separateRoomMemory(root, 'private', 20, root);
    privateStore.collectionPreferences.custom = 'private setting';
    const other = fixture(), otherBefore = JSON.stringify(other);
    const config = { extractionProfileId: 'unchanged', collectionExcludedRanges: [{ start:'<info>',end:'</info>' }], characterStores: { current: root, other } };
    const configBefore = JSON.stringify({ ...config, characterStores: undefined });
    const selected = scope.resetCharacterMemory(root, 'a', 55);
    assert.equal(config.characterStores.current, root); assert.equal(selected, root);
    assert.deepEqual(root.facts, []); assert.deepEqual(root.candidates, []);
    for (const key of ['nameAliases','rejectedMemories','embeddingIndex','lastReview','collectionExclusions']) assert.equal(root[key], undefined);
    assert.equal(root.uuid, 'character-unique'); assert.ok(root.memoryResetAt);
    assert.equal(root.chats.a.autoMemory.cursor, 55); assert.equal(root.chats.b, undefined);
    assert.deepEqual(root.chats.a.autoMemory.journal, []);
    assert.deepEqual(root.collectionPreferences, { focus:['secrets'],custom:'' });
    const cleared = scope.selectedMemoryStore(root, 'private');
    assert.notEqual(cleared, root); assert.deepEqual(cleared.facts, []); assert.deepEqual(cleared.chats, {});
    assert.equal(cleared.collectionPreferences.custom, 'private setting'); assert.ok(cleared.memoryResetAt);
    assert.equal(cleared.nameAliases, undefined); assert.equal(memory.undoLatestMemoryBatch(root,root.chats.a),0);
    assert.equal(JSON.stringify(other),otherBefore);
    assert.equal(JSON.stringify({ ...config, characterStores: undefined }),configBefore);
});

test('reset from an independent room keeps that room independent and checkpoints it at the end', () => {
    const root=fixture();scope.separateRoomMemory(root,'a',4,root);
    const selected=scope.resetCharacterMemory(root,'a',99);
    assert.notEqual(selected,root);assert.equal(scope.selectedMemoryStore(root,'a'),selected);
    assert.deepEqual(selected.facts,[]);assert.equal(selected.chats.a.autoMemory.cursor,99);
    assert.deepEqual(root.chats,{});assert.deepEqual(root.facts,[]);
    assert.throws(()=>scope.resetCharacterMemory(root,'',0));
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
    const box = { scheduleStorageSave(){}, fileStorage:{save:async()=>{}},storageNotice(){}, ...scope, ...memory, ...core, context: () => ctx, settings: () => config,
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

test('character reset survives reload; opening old shared/private rooms does not auto-recollect or reimport metadata', () => {
    const h=storageHarness(); const root=h.box.data();root.facts.push(fact('old'));
    scope.separateRoomMemory(root,'private',1,root);
    scope.resetCharacterMemory(root,'a',h.ctx.chat.length);
    const reloaded=JSON.parse(JSON.stringify(h.config));
    h.config.characterStores=reloaded.characterStores;
    h.ctx.chatId='old-shared';h.ctx.chat=Array.from({length:30},()=>({is_user:false,mes:'old reply'}));
    h.ctx.chatMetadata={hundredlog:{facts:[fact('legacy')]}};
    const shared=h.box.data();
    assert.equal(shared.facts.length,0);assert.equal(shared.chats['old-shared'].autoMemory.cursor,30);
    h.ctx.chatId='private';h.ctx.chatMetadata={memorybean:{facts:[fact('legacy2')]}};
    const isolated=h.box.data();assert.notEqual(isolated,shared);
    assert.equal(isolated.facts.length,0);assert.equal(isolated.chats.private.autoMemory.cursor,30);
    assert.equal(isolated.chats.private.autoMemory.offset,0);
    h.box.positiveInteger=(v,n)=>Number(v)||n;
    vm.runInContext(index.slice(index.indexOf('function completedAssistantCount('),index.indexOf('function scheduleMemory(')),h.box);
    assert.equal(h.box.memoryDue(isolated,h.ctx),false);
    h.ctx.chat.push({is_user:true,mes:'new input'},{is_user:false,mes:'new reply'});
    assert.equal(h.box.memoryDue(isolated,h.ctx),true);
    memory.resetRecentWindow(isolated,isolated.chats.private,h.ctx.chat,'private');
    assert.ok(memory.initializeAuto(isolated.chats.private,h.ctx.chat).cursor<32);
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

test('actual UI: empty separation stays independent through reset and import', async () => {
    const h = uiHarness(), button = h.get('separate-memory');
    await button.fire('click'); await h.confirm('빈 기억으로 시작');
    assert.equal(h.box.data().facts.length, 0); assert.equal(h.root.facts.length, 1);
    h.box.data().facts.push(fact('private'));
    assert.equal(button.hidden, true); assert.equal(button.disabled, true);
    await button.fire('click'); // Even a synthetic click cannot overwrite a separated room.
    assert.equal(h.get('memory-scope-choice').hidden, true);
    assert.equal(h.box.data().facts[0].id, 'private');
    await h.get('memory-reset').fire('click'); await h.confirm('이 방만 초기화');
    assert.equal(h.box.data().facts.length, 0); assert.equal(h.root.facts.length, 1);
    assert.equal(scope.roomScope(h.root, 'a').independent, true);
    const other = scope.separateRoomMemory(h.root, 'other', 1); other.facts.push(fact('other','other'));
    h.box.render(); h.get('memory-source').value = 'room:other';
    await h.get('memory-import').fire('click'); await h.confirm('복사해서 가져오기');
    assert.equal(h.box.data().facts[0].id, 'other');
    h.box.data().facts[0].text = 'edited copy'; assert.notEqual(other.facts[0].text, 'edited copy');
});

test('separation offers only two starting modes and cancel leaves shared memories untouched', async () => {
    const h = uiHarness(), button = h.get('separate-memory'), panel = h.get('memory-scope-choice');
    let scrolled = 0, focused = 0;
    panel.scrollIntoView = () => scrolled++;
    panel.focus = () => focused++;
    const before = JSON.stringify(h.root);
    await button.fire('click');
    assert.equal(button.disabled, true); assert.equal(panel.hidden, false);
    assert.deepEqual(panel.children[1].children.map(b => b.textContent), ['기존 기억 이어받기', '빈 기억으로 시작', '취소']);
    assert.equal(scrolled, 1); assert.equal(focused, 1);
    assert.equal(h.box.data(), h.root);
    h.box.render(); assert.equal(button.disabled, true);
    await h.confirm('취소');
    assert.equal(button.disabled, false); assert.equal(button.hidden, false);
    assert.equal(JSON.stringify(h.root), before);
    await button.fire('click'); await h.confirm('기존 기억 이어받기');
    const privateStore = h.box.data();
    assert.notEqual(privateStore, h.root);
    assert.equal(privateStore.facts[0].id, 'shared');
    privateStore.facts[0].text = 'new branch';
    assert.notEqual(h.root.facts[0].text, 'new branch');
    assert.equal(privateStore.chats.a.autoMemory.cursor, h.ctx.chat.length);
    assert.equal(button.hidden, true); assert.equal(panel.hidden, true);
    assert.match(h.get('memory-scope-status').textContent, /이 방만의 기억을 사용 중/);
});

test('existing separated rooms retain their memory and do not offer a switch to shared mode', () => {
    const h = uiHarness();
    const privateStore = scope.separateRoomMemory(h.root, 'a', h.ctx.chat.length);
    privateStore.facts.push(fact('keep'));
    h.box.render();
    assert.equal(h.box.data(), privateStore);
    assert.equal(h.get('separate-memory').hidden, true);
    assert.equal(h.get('separate-memory').listeners.change, undefined);
    assert.equal(scope.shareRoomMemory, undefined); assert.equal(scope.resumeRoomMemory, undefined);
});

test('separation confirmation is next to a button, not a toggle, on narrow screens', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(html, /<button[^>]*id="hundredlog-separate-memory"[^]*?<\/button>\s*<div id="hundredlog-memory-scope-choice"/);
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

test('character delete requires explicit confirmation; cancel and merely opening the panel leave memories intact', async () => {
    const h=uiHarness();h.ctx.name2='Test character';
    const original=JSON.stringify(h.root);
    await h.get('character-memory-reset').fire('click');
    assert.equal(JSON.stringify(h.root),original);
    assert.match(h.get('memory-scope-choice').children[0].textContent,/Test character/);
    assert.match(h.get('memory-scope-choice').children[0].textContent,/公用|공용/);
    assert.match(h.get('memory-scope-choice').children[0].textContent,/잠금/);
    assert.match(h.get('memory-scope-choice').children[0].textContent,/되돌릴 수 없/);
    await h.confirm('취소');assert.equal(JSON.stringify(h.root),original);
});

test('actual UI deletes the current character shared and independent memories, preserves RP/settings/other characters', async () => {
    const h=uiHarness();h.root.facts[0].pinned=true;
    const privateStore=scope.separateRoomMemory(h.root,'private',1,h.root);
    privateStore.collectionPreferences={focus:['promises'],custom:'keep'};
    h.ctx.characterId=1;const other=h.box.data();other.facts.push(fact('other-character'));
    h.ctx.characterId=0;
    const otherBefore=JSON.stringify(other),chatBefore=JSON.stringify(h.ctx.chat);
    h.config.collectionExcludedRanges=[{start:'<info>',end:'</info>'}];
    let saves=0;h.box.save=async()=>{saves++};
    await h.get('character-memory-reset').fire('click');await h.confirm('이 캐릭터 전체 기억 삭제');
    assert.equal(saves,1);assert.equal(h.root.facts.length,0);
    assert.equal(scope.selectedMemoryStore(h.root,'private').facts.length,0);
    assert.equal(scope.selectedMemoryStore(h.root,'private').collectionPreferences.custom,'keep');
    assert.equal(JSON.stringify(other),otherBefore);assert.equal(JSON.stringify(h.ctx.chat),chatBefore);
    assert.equal(h.config.collectionExcludedRanges[0].start,'<info>');
    assert.equal(h.root.chats.a.autoMemory.cursor,h.ctx.chat.length);
    assert.match(h.status,/모두 삭제했어요/);
});

test('failed persistence restores current-character memories and independent stores instead of showing success', async () => {
    const h=uiHarness();scope.separateRoomMemory(h.root,'private',1,h.root);
    h.root.facts[0].pinned=true;
    const before=JSON.stringify(h.root);
    h.box.save=async()=>{throw Error('network failed')};
    await h.get('character-memory-reset').fire('click');await h.confirm('이 캐릭터 전체 기억 삭제');
    assert.equal(JSON.stringify(h.root),before);assert.match(h.status,/저장하지 못/);
    assert.equal(h.get('character-memory-reset').disabled,false);
});

test('character delete confirmation cannot affect a different room or character', async () => {
    for(const change of [h=>{h.ctx.chatId='other'},h=>{h.ctx.characterId=1}]) {
        const h=uiHarness();const before=JSON.stringify(h.root);
        await h.get('character-memory-reset').fire('click');change(h);
        await h.confirm('이 캐릭터 전체 기억 삭제');assert.equal(JSON.stringify(h.root),before);
    }
});

test('character delete is blocked while generation, collection, translation or review is running', async () => {
    for(const flag of ['normalGenerating','extracting','translating','busy','memoryRun']) {
        const h=uiHarness();const before=JSON.stringify(h.root);
        await h.get('character-memory-reset').fire('click');h.box[flag]=true;
        await h.confirm('이 캐릭터 전체 기억 삭제');assert.equal(JSON.stringify(h.root),before);
    }
});

test('character switch or a generation starting during prompt clear aborts whole-character deletion', async () => {
    for(const change of [h=>{h.ctx.characterId=1},h=>{h.box.normalGenerating=true}]) {
        const h=uiHarness();const before=JSON.stringify(h.root);
        h.box.clearLegacyPrompt=async()=>change(h);
        await h.get('character-memory-reset').fire('click');await h.confirm('이 캐릭터 전체 기억 삭제');
        assert.equal(JSON.stringify(h.root),before);
    }
});

test('whole-character reset with special independent room names cannot change prototypes', () => {
    const root=fixture();scope.separateRoomMemory(root,'__proto__',5,root);
    scope.resetCharacterMemory(root,'__proto__',10);
    assert.equal(scope.selectedMemoryStore(root,'__proto__').chats.__proto__.autoMemory.cursor,10);
    assert.equal({}.independent,undefined);
});

test('verified file save and reload keep deletion durable across every scope without altering another character', async () => {
    let disk=null;
    const request=async(url,options)=>{
        if(url==='/api/files/upload') {
            const body=JSON.parse(options.body);
            disk=JSON.parse(Buffer.from(body.data,'base64').toString('utf8'));
            return {ok:true,status:200};
        }
        return {ok:disk!==null,status:disk?200:404,json:async()=>JSON.parse(JSON.stringify(disk))};
    };
    const client=()=>createFileStorage({request,compact:compactConfig});
    const storage=client(),root=fixture();scope.separateRoomMemory(root,'private',1,root);
    await storage.init({characterStores:{current:root,other:fixture()},extractionProfileId:'profile',collectionExcludedRanges:[{start:'x',end:'y'}]});
    const otherBefore=JSON.stringify(storage.value.characterStores.other);
    scope.resetCharacterMemory(storage.value.characterStores.current,'a',8);
    await storage.save();assert.equal(storage.dirty,false);
    const reload=client();await reload.init();
    const cleared=reload.value.characterStores.current;
    assert.equal(cleared.facts.length,0);assert.equal(scope.selectedMemoryStore(cleared,'private').facts.length,0);
    assert.equal(cleared.chats.a.autoMemory.cursor,8);assert.ok(cleared.memoryResetAt);
    assert.equal(JSON.stringify(reload.value.characterStores.other),otherBefore);
    assert.equal(reload.value.extractionProfileId,'profile');assert.equal(reload.value.collectionExcludedRanges.length,1);
});

