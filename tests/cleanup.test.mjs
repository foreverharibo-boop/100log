import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.js';
import * as memory from '../memory-engine.js';
import * as continuity from '../continuity-tools.js';

const code = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const cleanupCode = code.slice(code.indexOf('function sourceRows('), code.indexOf('function parseJson('));
const syncCode = code.slice(code.indexOf('export function syncMemories('), code.indexOf('export function installMemoryHooks(')).replace('export ', '');
const collectionCode = code.slice(code.indexOf('function collectionStep('), code.indexOf('function refreshCollectionStatus('));
const fact = (id, extra = {}) => ({ id, text: `기억 ${id}`, active: true, kind: 'fact', origin: 'auto', importance: 1, knowledge: {}, ...extra });
const archive = id => ({ action: 'archive', id, resolution: 'low_importance', reason: '중요도가 낮음' });
function harness(count = 40) {
    const ctx = { chatId: 'chat', chat: [{ name: 'A', is_user: false, mes: '새로운 구체적인 사건이 일어났다.' }] };
    const value = { facts: Array.from({ length: count }, (_, i) => fact(`f${i}`)), candidates: [] };
    const state = { autoMemory: { cursor: 0, offset: 0, journal: [] } };
    const config = { autoMemory: true, autoCleanup: true, cleanupThreshold: 30, collectionIntensity: 'detailed' };
    const requests = [], statuses = [], errors = [];
    const sandbox = { ...core, ...memory, ...continuity, AbortController, Date, console,
        context: () => ctx, data: () => value, chatKey: c => c.chatId, sourceChatId: c => c.chatId,
        chatState: () => state, settings: () => config, memoryDue: () => true,
        busy: false, normalGenerating: false, extracting: false, translating: false, memoryRun: null,
        memoryPending: false, memoryForcePending: false, memoryEpoch: 0, memoryTimer: null,
        activeCollectionJob: null, stopExtractionRequested: false,
        supportsBackgroundUtility: () => true, scheduleMemory() {}, render() {}, save: async () => {},
        setInterval: () => 1, clearInterval() {}, clearTimeout() {}, refreshCollectionStatus() {},
        setCollectionStatus: s => statuses.push(s), diagnosticError: (...args) => errors.push(args),
        traceDiagnostic: async (_stage, action) => action(),
        reviewCancelledError: () => Object.assign(Error('cancelled'), { hundredlogCancelled: true, name: 'AbortError' }),
        checkReviewJob(job) { if (job.controller.signal.aborted) throw sandbox.reviewCancelledError(); },
        rawGenerateUtility: async (_ctx, prompt) => {
            requests.push(prompt);
            return prompt.startsWith('Clean a rolling') ? '{"actions":[]}' : '{"operations":[]}';
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(collectionCode + '\n' + cleanupCode + '\n' + syncCode, sandbox);
    const run = (force = false, job = { controller: new AbortController() }) => sandbox.runAutomaticCleanup(value, ctx, '', () => !job.controller.signal.aborted, job, { force });
    return { ctx, value, state, config, requests, statuses, errors, sandbox, run };
}

test('automatic cleanup reruns on new or edited source, but skips identical input', async () => {
    const h = harness();
    await h.run(); await h.run();
    assert.equal(h.requests.length, 1);
    h.ctx.chat.push({ is_user: false, mes: '약속한 일을 끝냈다.' });
    await h.run(); assert.equal(h.requests.length, 2);
    h.ctx.chat[1].mes = '그 일은 취소되었다.';
    await h.run(); assert.equal(h.requests.length, 3);
    h.value.facts[0].pinned = true;
    await h.run(); assert.equal(h.requests.length, 4);
});

test('manual cleanup ignores threshold, disabled automation and unchanged input; no collection', async () => {
    const h = harness(2); h.config.autoMemory = false; h.config.autoCleanup = false;
    await h.run(); assert.equal(h.requests.length, 0);
    await h.sandbox.syncMemories({ cleanupOnly: true, force: true });
    await h.sandbox.syncMemories({ cleanupOnly: true, force: true });
    assert.equal(h.errors.length, 0);
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(prompt => prompt.startsWith('Clean a rolling')));
    assert.equal(h.value.lastCleanupReview.manual, true);
    assert.equal(h.state.autoMemory.cursor, 0);
    assert.equal(h.sandbox.extracting, false);
});

test('manual cleanup blocks concurrent generation and empty lists need no request', async () => {
    const h = harness(); h.sandbox.normalGenerating = true;
    await h.sandbox.syncMemories({ cleanupOnly: true, force: true });
    assert.equal(h.requests.length, 0);
    const empty = harness(0); await empty.sandbox.syncMemories({ cleanupOnly: true, force: true });
    assert.equal(empty.requests.length, 0); assert.equal(empty.errors.length, 0);
});

test('cleanup report distinguishes AI zero proposals from all proposals rejected', () => {
    const value = { facts: [fact('locked', { pinned: true }), fact('manual', { origin: 'manual' })] };
    const empty = {}, rejected = {};
    memory.parseCleanupActions('{"actions":[]}', value, [], empty);
    memory.parseCleanupActions(JSON.stringify({ actions: [archive('locked'), archive('manual')] }), value, [], rejected);
    assert.equal(empty.proposed, 0); assert.equal(empty.excluded, 0);
    assert.equal(rejected.proposed, 2); assert.equal(rejected.accepted, 0); assert.equal(rejected.excluded, 2);
    assert.equal(rejected.reasons['보관 대상·보호 조건'], 2);
});

test('cleanup preserves protected/knowledge/commitment facts and reports actual changes', async () => {
    const h = harness();
    h.value.facts[0].pinned = true;
    h.value.facts[1].origin = 'manual';
    h.value.facts[2].knowledge = { A: 'unknown' };
    h.value.facts[3].kind = 'commitment';
    h.sandbox.rawGenerateUtility = async () => JSON.stringify({ actions: [0,1,2,3,4].map(i => archive(`f${i}`)) });
    await h.run(true);
    assert.equal(h.value.facts.filter(f => f.active).length, 39);
    assert.equal(h.value.lastCleanupReview.proposed, 5);
    assert.equal(h.value.lastCleanupReview.excluded, 4);
    assert.equal(h.value.lastCleanupReview.archived, 1);
    assert.equal(memory.undoLatestMemoryBatch(h.value, h.state), 1);
    assert.equal(h.value.facts.filter(f => f.active).length, 40);
});

test('manual cancellation releases a hung request and ignores late response', async () => {
    const h = harness(); let resolve;
    h.sandbox.rawGenerateUtility = () => new Promise(r => { resolve = r; });
    const task = h.sandbox.syncMemories({ cleanupOnly: true, force: true });
    while (!resolve) await Promise.resolve();
    h.sandbox.stopCollection(); await task;
    assert.equal(h.sandbox.extracting, false);
    resolve(JSON.stringify({ actions: [archive('f0')] }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.value.facts.filter(f => f.active).length, 40);
    assert.equal(h.value.lastCleanupReview, undefined);
});

test('edited source, changed rules or chat switch invalidate an in-flight cleanup', async () => {
    for (const mutate of [h => { h.ctx.chat[0].mes = '바뀐 원문'; }, h => { h.value.facts[0].pinned = true; }, h => { h.ctx.chatId = 'other'; }]) {
        const h = harness(); let resolve;
        h.sandbox.rawGenerateUtility = () => new Promise(r => { resolve = r; });
        const task = h.sandbox.syncMemories({ cleanupOnly: true, force: true });
        while (!resolve) await Promise.resolve();
        mutate(h); resolve(JSON.stringify({ actions: [archive('f0')] })); await task;
        assert.equal(h.value.facts.filter(f => f.active).length, 40);
        assert.equal(h.value.lastCleanupReview, undefined);
        assert.equal(h.sandbox.extracting, false);
    }
});

test('collection at capacity cleans then saves the validated addition and removes its exclusion', async () => {
    const h = harness();
    h.sandbox.rawGenerateUtility = async (_ctx, prompt) => {
        h.requests.push(prompt);
        if (prompt.startsWith('Clean a rolling')) return JSON.stringify({ actions: [archive('f0')] });
        return JSON.stringify({ operations: [{ action: 'add', kind: 'temporary', text: '새로운 사건이 발생했다.',
            sourceId: 0, evidence: h.ctx.chat[0].mes, evidenceType: 'occurred', importance: 2, knowledge: {} }] });
    };
    await h.sandbox.syncMemories({ force: true });
    assert.equal(h.errors.length, 0, JSON.stringify(h.errors));
    assert.equal(h.requests.length, 2);
    assert.equal(h.value.facts.filter(f => f.active).length, 40);
    assert.ok(h.value.facts.some(f => f.active && f.text === '새로운 사건이 발생했다.'));
    assert.equal(h.state.collectionExclusions.total, 0);
    assert.equal(h.state.collectionExclusions.items.length, 0);
    assert.equal(h.value.lastCleanupReview.recovered, 1);
    assert.equal(h.value.lastCleanupReview.capacityRemaining, 0);
    // Retry additions retain source rollback support.
    h.ctx.chat[0].mes = '수정된 전혀 다른 사건이다.';
    memory.reconcileMemory(h.value, h.state, h.ctx.chat);
    assert.equal(h.value.facts.filter(f => f.active).length, 40);
    assert.ok(!h.value.facts.some(f => f.text === '새로운 사건이 발생했다.'));
});

test('no safe cleanup retains all memories and reports the capacity-blocked addition', async () => {
    const h = harness();
    h.sandbox.rawGenerateUtility = async (_ctx, prompt) => prompt.startsWith('Clean a rolling') ? '{"actions":[]}'
        : JSON.stringify({ operations: [{ action: 'add', kind: 'temporary', text: '새 사건', sourceId: 0,
            evidence: h.ctx.chat[0].mes, evidenceType: 'occurred', knowledge: {} }] });
    await h.sandbox.syncMemories({ force: true });
    assert.equal(h.errors.length, 0);
    assert.equal(h.value.facts.filter(f => f.active).length, 40);
    assert.equal(h.state.collectionExclusions.total, 1);
    assert.equal(h.value.lastCleanupReview.capacityRemaining, 1);
    assert.match(h.statuses.at(-1), /새 기억 1개를 저장하지 못/);
});

test('invalid cleanup response preserves the rules and can be retried manually', async () => {
    const h = harness(); h.sandbox.rawGenerateUtility = async () => 'invalid JSON';
    await h.sandbox.syncMemories({ cleanupOnly: true, force: true });
    assert.equal(h.errors.length, 1);
    assert.equal(h.value.facts.filter(f => f.active).length, 40);
    assert.equal(h.value.lastCleanupSignature, undefined);
    assert.match(h.statuses.at(-1), /지금 청소/);
});

test('deferred additions are never replayed against edited or missing sources', () => {
    const h = harness();
    const op = { action: 'add', kind: 'fact', text: '검증된 새 기억', sourceId: 0,
        sourceSignature: memory.messageSignature(h.ctx.chat[0]), knowledge: {} };
    const deferred = memory.applyMemoryOperations(h.value, [op], 'chat').capacityDeferred;
    h.value.facts[0].active = false; h.ctx.chat[0].mes = '변경됨';
    assert.equal(memory.retryCapacityOperations(h.value, deferred, h.ctx.chat, 'chat').recovered, 0);
    h.ctx.chat = [];
    assert.equal(memory.retryCapacityOperations(h.value, deferred, h.ctx.chat, 'chat').recovered, 0);
});
