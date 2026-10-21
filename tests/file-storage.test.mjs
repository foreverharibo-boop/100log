import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFileStorage, FILE_NAME, FILE_URL } from '../file-storage.js';
import { compactConfig, compactMemoryStore, forgetRoomProgress, pruneDeletedRoomProgress, renameRoom } from '../retention.js';
import { removeFact } from '../core.js';
import { initializeAuto, recordMemoryBatch, undoLatestMemoryBatch, pruneToRecentWindow, messageSignature, applyMemoryOperations, evictOldestMemories } from '../memory-engine.js';
const clone = value => JSON.parse(JSON.stringify(value));
const fact = (id, extra = {}) => ({ id, text: `English memory ${id} 한글 中文 🌼`, origin: 'auto', active: true, knowledge: { A: 'known', B: 'unknown' }, sourceText: 'Exact original quote', sourceChatId: 'room', sourceId: 0, ...extra });
const legacy = () => ({ enabled: true, autoMemory: true, reviewEnabled: false, analysisInterval: 3, extractionProfileId: 'profile',
    characterIdentityRegistry: { byAvatar: { 'card.png': 'identity' }, records: { identity: { avatar: 'card.png' } } },
    characterStores: { 'uuid:identity': { uuid: 'identity', facts: [fact('active'), fact('past', { archived: 'merged', active: false }), fact('manual', { origin: 'manual', pinned: true })],
        chats: { room: { extractionCursor: 5, extractionOffset: 12, autoMemory: { cursor: 5, offset: 12, journal: [] } } },
        chatMemoryScopes: { private: { independent: true, store: { facts: [fact('private')], chats: {} } } } } } });
function server() {
    let file = null, getCount = 0, uploads = 0;
    const calls = [], controls = { failGet: false, failUpload: false, corruptVerify: false, failVerifyOnce: false };
    return {
        controls, calls,
        get file() { return file; }, set file(value) { file = clone(value); },
        get uploads() { return uploads; },
        async request(url, options = {}) {
            calls.push({ url, options });
            if (url === '/api/files/upload') {
                assert.equal(options.method, 'POST');
                assert.equal(options.headers['X-CSRF-Token'], 'test');
                const body = JSON.parse(options.body);
                assert.equal(body.name, FILE_NAME);
                if (controls.failUpload) return { ok: false, status: 507 };
                file = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')); uploads++;
                if (controls.corruptVerify) file.data.enabled = !file.data.enabled;
                if (controls.failVerifyOnce) { controls.failVerifyOnce = false; controls.failGet = true; }
                return { ok: true, status: 200, json: async () => ({ path: `user/files/${FILE_NAME}` }) };
            }
            assert.ok(url.startsWith(`${FILE_URL}?`)); getCount++;
            assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'same-origin');
            if (controls.failGet) return { ok: false, status: 503 };
            return { ok: file !== null, status: file ? 200 : 404, json: async () => clone(file) };
        },
    };
}
function client(remote, extra = {}) { return createFileStorage({ request: remote.request, headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }), compact: compactConfig, ...extra }); }

test('automatic migration copies all settings/scopes/cursors, compacts a clone and verifies Unicode file contents', async () => {
    const remote = server(), old = legacy(), original = clone(old), storage = client(remote);
    await storage.init(old);
    assert.deepEqual(old, original); // Never clean the only source in place.
    assert.equal(remote.uploads, 1); assert.equal(storage.value.extractionProfileId, 'profile');
    const value = storage.value.characterStores['uuid:identity'];
    assert.deepEqual(value.facts.map(f => f.id), ['active', 'manual']);
    assert.deepEqual(value.facts[0], original.characterStores['uuid:identity'].facts[0]);
    assert.equal(value.chats.room.autoMemory.cursor, 5); assert.equal(value.chats.room.autoMemory.offset, 12);
    assert.equal(value.chatMemoryScopes.private.independent, true);
    assert.equal(value.chatMemoryScopes.private.store.facts[0].text, fact('private').text);
    assert.deepEqual(remote.file.data, storage.value);
    assert.equal(storage.dirty, false);
    assert.ok(remote.calls.at(-1).url.startsWith(FILE_URL));
});

for (const mode of ['failGet', 'failUpload', 'corruptVerify']) test(`migration ${mode} never mutates source or marks storage ready`, async () => {
    const remote = server(), old = legacy(), original = clone(old), storage = client(remote);
    remote.controls[mode] = true;
    await assert.rejects(storage.init(old));
    assert.deepEqual(old, original); assert.equal(storage.ready, false); assert.ok(storage.error);
});

test('invalid existing file is not replaced by legacy settings or blank data', async () => {
    const remote = server(); remote.file = { format: '100LOG', schema: 999, data: {} };
    await assert.rejects(client(remote).init(legacy()), e => e.storageCode === 'invalid_file');
    assert.equal(remote.uploads, 0);
});

test('reload after migration uses the file even if settings deletion was interrupted; does not resurrect old memories', async () => {
    const remote = server(), old = legacy(), first = client(remote);
    await first.init(old); first.value.characterStores['uuid:identity'].facts = []; await first.save();
    const second = client(remote); await second.init(old);
    assert.equal(second.value.characterStores['uuid:identity'].facts.length, 0);
    assert.equal(remote.uploads, 2);
});

test('upgrade removes only unused legacy private stores and keeps active independent rooms and shared data', async () => {
    const remote = server(), initial = client(remote);
    await initial.init(legacy());
    const saved = remote.file;
    const root = saved.data.characterStores['uuid:identity'];
    root.chatMemoryScopes.dormant = { independent: false, store: { facts: [fact('unused')], chats: { dormant: { extractionCursor: 30 } } } };
    const activeBefore = clone(root.chatMemoryScopes.private);
    const sharedBefore = clone(root.facts), progressBefore = clone(root.chats);
    remote.file = saved;
    const upgraded = client(remote); await upgraded.init();
    const after = upgraded.value.characterStores['uuid:identity'];
    assert.equal(after.chatMemoryScopes.dormant, undefined);
    assert.deepEqual(after.chatMemoryScopes.private, activeBefore);
    assert.deepEqual(after.facts, sharedBefore); assert.deepEqual(after.chats, progressBefore);
    await upgraded.save();
    assert.equal(remote.file.data.characterStores['uuid:identity'].chatMemoryScopes.dormant, undefined);
    const reopened = client(remote); await reopened.init();
    assert.deepEqual(reopened.value.characterStores['uuid:identity'].chatMemoryScopes.private, activeBefore);
});

test('save queue preserves edits made while upload is in flight and final queued save persists them', async () => {
    const remote = server(), storage = client(remote); await storage.init(legacy());
    storage.value.analysisInterval = 4;
    const first = storage.save(); storage.value.extractionProfileId = 'later'; const second = storage.save();
    await Promise.all([first, second]);
    assert.equal(remote.file.data.analysisInterval, 4); assert.equal(remote.file.data.extractionProfileId, 'later');
    assert.equal(storage.dirty, false);
});

test('save verification interrupted after successful upload can retry its exact own write', async () => {
    const remote = server(), storage = client(remote); await storage.init(legacy());
    storage.value.analysisInterval = 9; remote.controls.failVerifyOnce = true;
    await assert.rejects(storage.save()); assert.equal(storage.dirty, true);
    remote.controls.failGet = false;
    await storage.save(); assert.equal(storage.dirty, false); assert.equal(storage.error, null);
    assert.equal(remote.file.data.analysisInterval, 9);
});

test('stale browser cannot overwrite a later revision; clean browser refreshes same-server data', async () => {
    const remote = server(), a = client(remote), b = client(remote), clean = client(remote);
    await a.init(legacy()); await b.init(); await clean.init();
    const identity = clean.value.characterStores['uuid:identity'];
    a.value.analysisInterval = 7; await a.save();
    b.value.analysisInterval = 2;
    await assert.rejects(b.save(), e => e.storageCode === 'conflict');
    assert.equal(remote.file.data.analysisInterval, 7); assert.equal(b.dirty, true);
    await clean.refresh(); assert.equal(clean.value.analysisInterval, 7);
    assert.equal(clean.value.characterStores['uuid:identity'], identity);
});

test('missing or unreadable file after load never becomes an empty successful refresh', async () => {
    const remote = server(), storage = client(remote); await storage.init(legacy());
    remote.controls.failGet = true;
    await assert.rejects(storage.refresh()); assert.equal(storage.value.analysisInterval, 3);
});

test('settings migration integration removes only 100LOG keys after success and preserves everything on failure', async () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('function initializeFileStorage()'), source.indexOf('function scheduleStorageSave()'));
    for (const fail of [true, false]) {
        let saves = 0;
        const extensionSettings = { hundredlog: legacy(), memorybean: { obsolete: true }, other: { untouched: true } };
        const ctx = { extensionSettings, saveSettingsDebounced() { saves++; } };
        const box = { storageInit: null, NAME: 'hundredlog', LEGACY_NAME: 'memorybean', context: () => ctx,
            storageNotice() {}, fileStorage: { init: async () => { if (fail) throw Error('failed'); } } };
        vm.createContext(box); vm.runInContext(code, box);
        if (fail) { await assert.rejects(box.initializeFileStorage()); assert.ok(extensionSettings.hundredlog); assert.ok(extensionSettings.memorybean); }
        else { await box.initializeFileStorage(); assert.equal(Object.hasOwn(extensionSettings, 'hundredlog'), false); assert.equal(Object.hasOwn(extensionSettings, 'memorybean'), false); }
        assert.equal(saves, fail ? 0 : 1); assert.deepEqual(extensionSettings.other, { untouched: true });
    }
});

test('many updates keep one undo snapshot and small edit-detection signatures, not old memory copies', () => {
    const state = { autoMemory: { cursor: 0, offset: 0, journal: [] } };
    for (let i = 0; i < 500; i++) recordMemoryBatch(state, { rows: [{ id: i, signature: `s${i}` }], start: i, offset: 0, nextCursor: i + 1, nextOffset: 0,
        changes: [{ id: 'f', before: fact('f', { text: `old${i}` }), after: fact('f', { text: `new${i}` }) }] });
    assert.equal(state.autoMemory.journal.length, 100);
    assert.equal(state.autoMemory.journal.filter(e => e.changes.length).length, 1);
    assert.ok(!JSON.stringify(state).includes('old0"')); assert.ok(JSON.stringify(state).includes('old499'));
});

test('archive compaction still lets last FIFO update undo and protects manual/locked and paused memories', () => {
    const value = { facts: [fact('one'), fact('two'), fact('manual', { origin: 'manual' }), fact('pinned', { pinned: true }), fact('paused', { active: false })], chats: { room: {} } };
    const state = value.chats.room; initializeAuto(state, []);
    const result = evictOldestMemories(value, 3, 'room');
    recordMemoryBatch(state, { rows: [], start: 0, offset: 0, nextCursor: 0, nextOffset: 0, changes: result.changes });
    compactMemoryStore(value);
    assert.ok(!value.facts.some(f => f.id === 'one')); assert.ok(value.facts.some(f => f.id === 'paused'));
    assert.equal(undoLatestMemoryBatch(value, state), 1); assert.ok(value.facts.some(f => f.id === 'one' && f.active));
});

test('compacted update can be undone without orphan previousId preventing comparison', () => {
    const before = fact('old'); const after = fact('new', { previousId: 'old' });
    const value = { facts: [{ ...before, archived: 'updated', supersededBy: 'new', active: false }, after], chats: { room: { autoMemory: { cursor: 1, offset: 0, journal: [
        { sources: [], start: 0, offset: 0, changes: [{ id: 'old', before: clone(before), after: { ...before, archived: 'updated', supersededBy: 'new', active: false } }, { id: 'new', before: null, after: clone(after) }] },
    ] } } } };
    compactMemoryStore(value);
    assert.equal(undoLatestMemoryBatch(value, value.chats.room), 2);
    assert.deepEqual(value.facts.map(f => f.id), ['old']);
});

test('explicit deletion purges translations, every undo copy, embeddings, review and exclusion references', () => {
    const record = fact('gone', { translatedKo: { text: '번역문' } });
    const state = { autoMemory: { journal: [{ changes: [{ id: 'gone', before: record, after: record }] }] },
        lastReview: { issues: [{ text: record.text }] }, collectionExclusions: { items: [{ existingId: 'gone', text: 'variant' }] } };
    const value = { facts: [record], chats: { a: clone(state), b: clone(state) }, lastCleanupSignature: record.text, embeddingIndex: { entries: { gone: [1, 2] } } };
    removeFact(value, 'gone'); compactMemoryStore(value);
    assert.ok(!JSON.stringify(value).includes('English memory')); assert.ok(!JSON.stringify(value).includes('번역문'));
    assert.deepEqual(value.embeddingIndex.entries, {});
    assert.equal(undoLatestMemoryBatch(value, value.chats.a), 0);
});

test('recollection rejection expires beyond last 100 visible messages, without relying on raw message count', () => {
    const chat = Array.from({ length: 105 }, (_, id) => ({ mes: `message${id}`, is_user: false }));
    const value = { facts: [], candidates: [], rejectedMemories: [0, 104].map(sourceId => ({ text: 'bad claim', sourceChatId: 'room', sourceId, sourceSignature: messageSignature(chat[sourceId]) })) };
    pruneToRecentWindow(value, {}, chat, 'room'); assert.deepEqual(value.rejectedMemories.map(r => r.sourceId), [104]);
    chat[104].mes = 'edited'; pruneToRecentWindow(value, {}, chat, 'room'); assert.equal(value.rejectedMemories.length, 0);
});

test('only successful raw room enumeration prunes deleted progress; shared facts and active independent worlds survive', async () => {
    for (const listing of [null, { error: true }, [{ file_name: 'live.jsonl' }]]) {
        const config = legacy(); await pruneDeletedRoomProgress(config, async () => listing);
        assert.ok(config.characterStores['uuid:identity'].chats.room);
    }
    const config = legacy(); await pruneDeletedRoomProgress(config, async () => []);
    const root = config.characterStores['uuid:identity'];
    assert.equal(root.chats.room, undefined); assert.equal(root.facts.length, 3);
    assert.ok(root.chatMemoryScopes.private.store.facts.length);
    const open = legacy(); await pruneDeletedRoomProgress(open, async () => [], 'room'); assert.ok(open.characterStores['uuid:identity'].chats.room);
});

test('room rename preserves private scope, shared references, source evidence and collection progress', () => {
    const root = legacy().characterStores['uuid:identity'];
    root.chatMemoryScopes.room = { independent: true, store: { facts: [fact('private')], chats: { room: { extractionCursor: 45 } } } };
    renameRoom(root, 'room', 'renamed');
    assert.equal(root.chats.renamed.autoMemory.cursor, 5); assert.equal(root.chats.room, undefined);
    assert.equal(root.chatMemoryScopes.renamed.store.chats.renamed.extractionCursor, 45);
    assert.equal(root.facts[0].sourceChatId, 'renamed');
});

test('known migrated account with missing file cannot silently create an empty replacement on reload', async () => {
    const remote = server();
    await assert.rejects(client(remote, { wasMigrated: () => true }).init(), e => e.storageCode === 'missing_file');
    assert.equal(remote.uploads, 0);
});

test('migration guard is set only after successful verification', async () => {
    const remote = server(); let marked = 0;
    const storage = client(remote, { markMigrated: () => marked++ });
    remote.controls.failUpload = true; await assert.rejects(storage.init(legacy())); assert.equal(marked, 0);
    remote.controls.failUpload = false; await storage.init(legacy()); assert.equal(marked, 1);
});

test('source edit after older undo copies were dropped removes stale automatic claim but protects manual and another room', async () => {
    const { reconcileMemory } = await import('../memory-engine.js');
    const chat = [{ mes: 'Old event', is_user: false }, { mes: 'Later event', is_user: false }];
    const state = {}; initializeAuto(state, chat);
    const old = fact('old', { sourceSignature: messageSignature(chat[0]) });
    const newer = fact('newer', { sourceId: 1, sourceSignature: messageSignature(chat[1]) });
    const value = { facts: [old, newer, { ...old, id: 'manual', pinned: true }, { ...old, id: 'other', sourceChatId: 'another' }], chats: { room: state } };
    for (const [i, f] of [old, newer].entries()) recordMemoryBatch(state, { rows: [{ id: i, signature: messageSignature(chat[i]) }], start: i, offset: 0, nextCursor: i + 1, nextOffset: 0, changes: [{ id: f.id, before: null, after: clone(f) }] });
    chat[0].mes = 'Replacement event'; reconcileMemory(value, state, chat, 'room');
    assert.ok(!value.facts.some(f => f.id === 'old')); assert.ok(value.facts.some(f => f.id === 'manual')); assert.ok(value.facts.some(f => f.id === 'other'));
    assert.equal(state.autoMemory.cursor, 0);
});

test('refresh cannot replace a UI edit made while its remote read is in flight', async () => {
    const remote = server(), a = client(remote); await a.init(legacy());
    let intercept = false, release, reading;
    const readStarted = new Promise(resolve => { reading = resolve; });
    const b = client(remote, { request: async (url, options) => {
        const response = await remote.request(url, options);
        if (intercept && url.startsWith(FILE_URL)) { reading(); await new Promise(resolve => { release = resolve; }); }
        return response;
    } });
    await b.init(); a.value.analysisInterval = 8; await a.save();
    intercept = true; const refreshing = b.refresh(); await readStarted;
    b.value.extractionProfileId = 'unsaved UI edit'; release();
    await assert.rejects(refreshing, e => e.storageCode === 'conflict');
    assert.equal(b.value.extractionProfileId, 'unsaved UI edit'); assert.equal(remote.file.data.analysisInterval, 8);
});

test('unchanged save cannot clear a read failure without checking the file again', async () => {
    const remote = server(), storage = client(remote); await storage.init(legacy());
    remote.controls.failGet = true; await assert.rejects(storage.refresh());
    await assert.rejects(storage.save()); assert.ok(storage.error);
    remote.controls.failGet = false; await storage.save(); assert.equal(storage.error, null);
});

test('existing files discard protected past facts in shared/private scopes while keeping current locks and one undo', async () => {
    const remote = server(), old = legacy();
    const root = old.characterStores['uuid:identity'];
    root.facts.push(fact('old-manual', { origin: 'manual', archived: 'updated', pinned: true }), fact('old-locked', { pinned: true, supersededBy: 'active' }));
    root.chatMemoryScopes.private.store.facts.push(fact('private-past', { origin: 'manual', archived: 'completed', pinned: true }));
    root.chats.room.autoMemory.journal = [{ sources: [], start: 0, offset: 0, changes: [{ id: 'active', before: fact('active'), after: fact('active') }] }];
    remote.file = { format: '100LOG', schema: 1, revision: 'old-release', data: old };
    const storage = client(remote); await storage.init();
    const saved = remote.file.data.characterStores['uuid:identity'];
    assert.deepEqual(saved.facts.map(f => f.id), ['active', 'manual']);
    assert.equal(saved.facts[1].pinned, true);
    assert.deepEqual(saved.chatMemoryScopes.private.store.facts.map(f => f.id), ['private']);
    assert.equal(saved.chats.room.autoMemory.journal[0].changes.length, 1);
    assert.equal(saved.chats.room.autoMemory.cursor, 5);
    assert.equal(remote.uploads, 1);
});


test('retired pause and scene modes migrate across scopes and undo without reviving past memories', () => {
    const before = fact('kept', { active: false, scope: 'scene', text: 'before' });
    const after = { ...before, text: 'after' };
    const ended = fact('ended', { active: false, scope: 'scene', archived: 'completed' });
    const store = { facts: [clone(after), clone(ended), fact('locked', { pinned: true, scope: 'scene' })],
        chats: { room: { autoMemory: { journal: [{ sources: [], changes: [{ id: 'kept', before: clone(before), after: clone(after) }] }] } } },
        chatMemoryScopes: { private: { independent: true, store: { facts: [fact('private', { active: false, scope: 'scene' })] } } } };
    compactMemoryStore(store);
    assert.deepEqual(store.facts.map(f => f.id), ['kept', 'locked']);
    assert.ok(store.facts.every(f => f.active && f.scope === 'always'));
    assert.equal(store.facts[1].pinned, true);
    assert.equal(store.chatMemoryScopes.private.store.facts[0].active, true);
    const once = structuredClone(store); compactMemoryStore(store); assert.deepEqual(store, once);
    assert.equal(undoLatestMemoryBatch(store, store.chats.room), 1);
    assert.equal(store.facts[0].text, 'before');
    assert.equal(store.facts[0].active, true);
    assert.equal(store.facts[0].scope, 'always');
    assert.ok(!store.facts.some(f => f.id === 'ended'));
});
