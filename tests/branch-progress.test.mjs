import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inheritBranchProgress } from '../branch-progress.js';
import { initializeAuto, messageSignature, recordMemoryBatch, reconcileMemory, resetRecentWindow, undoLatestMemoryBatch } from '../memory-engine.js';
import { recentWindowProgress } from '../core.js';
import { compactConfig } from '../retention.js';

const messages = n => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Char' : 'User', is_user: i % 2 === 0, mes: `Original message ${i}.` }));
function fixture(chat = messages(34), cursor = chat.length, offset = 0) {
    const parent = { autoMemory: { cursor: 0, offset: 0, journal: [] } };
    recordMemoryBatch(parent, { rows: chat.slice(0, cursor + (offset ? 1 : 0)).map((message, id) => ({ id, signature: messageSignature(message) })),
        start: 0, offset: 0, nextCursor: cursor, nextOffset: offset,
        changes: [{ id: 'fact', before: null, after: { id: 'fact', text: 'Parent memory' } }] });
    const state = { extractionCursor: 0, extractionOffset: 0 };
    const value = { facts: [{ id: 'fact', text: 'Parent memory', active: true, sourceChatId: 'parent' }], chats: { parent, branch: state } };
    const ctx = { chatId: 'branch', chatMetadata: { main_chat: 'parent' }, chat: structuredClone(chat) };
    return { value, state, ctx, parent, apply: () => inheritBranchProgress(value, state, ctx, { created: true }) };
}

test('a branch inherits 34 completed messages without copying or mutating parent memories and undo data', () => {
    const h = fixture();
    const parentBefore = JSON.stringify(h.parent), factsBefore = JSON.stringify(h.value.facts), chatBefore = JSON.stringify(h.ctx.chat);
    assert.equal(h.apply(), true);
    assert.equal(h.state.autoMemory.cursor, 34);
    assert.equal(h.state.extractionCursor, 34);
    assert.equal(recentWindowProgress(h.ctx.chat, h.state.autoMemory.cursor).completed, 34);
    assert.ok(h.state.autoMemory.journal.every(entry => entry.changes.length === 0));
    assert.equal(undoLatestMemoryBatch(h.value, h.state), 0);
    assert.equal(JSON.stringify(h.parent), parentBefore);
    assert.equal(JSON.stringify(h.value.facts), factsBefore);
    assert.equal(JSON.stringify(h.ctx.chat), chatBefore);
});

test('only the collected 30 out of 34 messages are inherited', () => {
    const h = fixture(messages(34), 30); h.apply();
    assert.equal(h.state.autoMemory.cursor, 30);
    assert.equal(recentWindowProgress(h.ctx.chat, 30).completed, 30);
});

test('branching at an earlier point caps inherited progress and removes future journal sources', () => {
    const h = fixture(messages(80), 70); h.ctx.chat = h.ctx.chat.slice(0, 40); h.apply();
    assert.equal(h.state.autoMemory.cursor, 40);
    assert.equal(h.state.autoMemory.offset, 0);
    assert.ok(h.state.autoMemory.journal.every(entry => entry.sources.every(row => row.id < 40)));
});

test('an alternate swipe or edited message starts collection at the first different message', () => {
    for (const changedId of [0, 12, 33]) {
        const h = fixture(); h.ctx.chat[changedId].mes = 'Different branch reply'; h.apply();
        assert.equal(h.state.autoMemory.cursor, changedId);
        assert.equal(h.state.autoMemory.offset, 0);
    }
});

test('message identity includes speaker and visibility, while unrelated branch metadata is ignored', () => {
    const h = fixture(); h.ctx.chat[12].extra = { branches: ['child'], bookmark_link: 'checkpoint' }; h.apply();
    assert.equal(h.state.autoMemory.cursor, 34);
    const other = fixture(); other.ctx.chat[12].name = 'Different speaker'; other.apply();
    assert.equal(other.state.autoMemory.cursor, 12);
});

test('a partially collected long message retains its offset only if its exact source matches', () => {
    const chat = messages(4); chat[2].mes = 'long '.repeat(6000);
    const h = fixture(chat, 2, 12000); h.apply();
    assert.equal(h.state.autoMemory.cursor, 2); assert.equal(h.state.autoMemory.offset, 12000);
    const edited = fixture(chat, 2, 12000); edited.ctx.chat[2].mes += ' changed'; edited.apply();
    assert.equal(edited.state.autoMemory.cursor, 2); assert.equal(edited.state.autoMemory.offset, 0);
    const before = fixture(chat, 2, 12000); before.ctx.chat = before.ctx.chat.slice(0, 2); before.apply();
    assert.equal(before.state.autoMemory.cursor, 2); assert.equal(before.state.autoMemory.offset, 0);
});

test('2005 hidden messages plus 34 visible messages inherit without making hidden messages collectible', () => {
    const hidden = Array.from({ length: 2005 }, () => ({ mes: 'Hidden history', is_hidden: true }));
    const h = fixture([...hidden, ...messages(34)]); h.apply();
    assert.equal(h.state.autoMemory.cursor, 2039);
    assert.equal(h.state.autoMemory.journal.length, 34);
    assert.equal(recentWindowProgress(h.ctx.chat, 2039).total, 34);
    assert.equal(recentWindowProgress(h.ctx.chat, 2039).completed, 34);
    assert.ok(h.ctx.chat.slice(0, 2005).every(message => message.is_hidden));
});

test('inheritance is bounded to the current rolling window', () => {
    const h = fixture(messages(250)); h.apply();
    assert.equal(h.state.autoMemory.cursor, 250);
    assert.equal(h.state.autoMemory.journal.length, 100);
    assert.equal(h.state.autoMemory.journal[0].start, 150);
});

test('missing collection signatures never certify visible messages as collected', () => {
    const h = fixture(); h.parent.autoMemory.journal[0].sources = h.parent.autoMemory.journal[0].sources.filter(row => row.id !== 8);
    h.apply(); assert.equal(h.state.autoMemory.cursor, 8);
    const none = fixture(); none.parent.autoMemory.journal = []; none.apply();
    assert.equal(none.state.autoMemory.cursor, 0);
});

test('a second generation branch inherits the first branch checkpoint', () => {
    const h = fixture(); h.apply();
    const child = { extractionCursor: 0, extractionOffset: 0 }; h.value.chats.child = child;
    assert.equal(inheritBranchProgress(h.value, child, { ...h.ctx, chatId: 'child', chatMetadata: { main_chat: 'branch' } }, { created: true }), true);
    assert.equal(child.autoMemory.cursor, 34);
    child.autoMemory.journal[0].sources[0].signature = 'child-only';
    assert.notEqual(h.state.autoMemory.journal[0].sources[0].signature, 'child-only');
});

test('later parent progress cannot advance a branch after its one-time inheritance', () => {
    const h = fixture(messages(34), 30); h.apply();
    const before = JSON.stringify(h.state);
    h.parent.autoMemory.cursor = 34;
    assert.equal(h.apply(), false); assert.equal(JSON.stringify(h.state), before);
});

test('untouched old zero-progress branches can inherit, but started, partial, reset and collected branches cannot', () => {
    const h = fixture(); initializeAuto(h.state, h.ctx.chat);
    assert.equal(inheritBranchProgress(h.value, h.state, h.ctx), true);
    for (const auto of [
        { cursor: 5, offset: 0, journal: [] }, { cursor: 0, offset: 12, journal: [] },
        { cursor: 0, offset: 0, journal: [], undoGroup: 'manual-run' },
        { cursor: 0, offset: 0, journal: [{ sources: [], changes: [] }] },
    ]) {
        const x = fixture(); x.state.autoMemory = auto; const before = JSON.stringify(x.state);
        assert.equal(x.apply(), false); assert.equal(JSON.stringify(x.state), before);
    }
    for (const version of [undefined, 2]) {
        const x = fixture(); x.value.memoryResetAt = 123; x.value.memoryResetVersion = version;
        assert.equal(inheritBranchProgress(x.value, x.state, x.ctx), false);
    }
});

test('manual recollection after inheritance is not undone by another data read', () => {
    const h = fixture(); h.apply(); resetRecentWindow(h.value, h.state, h.ctx.chat, 'branch');
    assert.equal(h.apply(), false); assert.equal(h.state.autoMemory.cursor, 0);
});

test('independent/shared stores never cross-inherit progress or change their settings', () => {
    for (const room of ['parent', 'branch']) {
        const h = fixture(); h.value.chatMemoryScopes = { [room]: { independent: true, store: { facts: [], chats: {} } } };
        const before = JSON.stringify(h.value); assert.equal(h.apply(), false); assert.equal(JSON.stringify(h.value), before);
    }
});

test('unknown parents, ordinary new chats, self-links, invalid cursors and prototype names do not inherit', () => {
    for (const parentId of [undefined, '', 'missing', 'branch', '__proto__', 'constructor']) {
        const h = fixture(); h.ctx.chatMetadata.main_chat = parentId;
        assert.equal(h.apply(), false); assert.equal(h.state.autoMemory, undefined);
    }
    for (const cursor of [-1, NaN, '34']) {
        const h = fixture(); h.parent.autoMemory.cursor = cursor; assert.equal(h.apply(), false);
    }
});

test('checkpoint survives compaction/reload and a later edit rewinds only its affected prefix', () => {
    const h = fixture(); h.apply();
    compactConfig({ characterStores: { c: h.value } });
    const value = JSON.parse(JSON.stringify(h.value)), state = value.chats.branch;
    h.ctx.chat[20].mes = 'Edited after inheritance';
    const parentBefore = JSON.stringify(value.chats.parent), factsBefore = JSON.stringify(value.facts);
    assert.equal(reconcileMemory(value, state, h.ctx.chat, 'branch'), true);
    assert.equal(state.autoMemory.cursor, 20);
    assert.equal(JSON.stringify(value.chats.parent), parentBefore);
    assert.equal(JSON.stringify(value.facts), factsBefore);
});
