import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as memory from '../memory-engine.js';
import * as core from '../core.js';

const code = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const english = 'Dana promised to meet Chris at the library tomorrow.';
const korean = '다나는 내일 도서관에서 크리스를 만나기로 약속했다.';
const fact = (id, text = english) => ({ id, text, kind: 'fact', active: true, origin: 'auto', importance: 5, knowledge: {}, sourceId: 0, sourceChatId: 'chat', sourceText: english });
const rows = [{ id: 0, role: 'character', name: 'Chris', text: english }, { id: 1, role: 'user', name: 'Dana', text: '응, 내일 봐.' }];

for (const [name, build] of [
    ['collection', (facts) => memory.memoryRequest(facts, rows)],
    ['omission review', (facts) => memory.omissionReviewRequest(facts, rows)],
    ['compound split', (facts) => memory.compoundSplitRequest([], facts, rows)],
]) test(`${name} uses RP narration language even with Korean user input and legacy memories`, () => {
    const prompt = build([fact('old', korean)]);
    assert.match(prompt, /English narration produces English memories; Korean narration produces Korean memories/);
    assert.match(prompt, /user reply in another language must not override the character narration language/);
    assert.match(prompt, /previously saved memories \(which may be legacy Korean summaries\)/);
    assert.match(prompt, /evidence quote verbatim in its original language/);
    assert.doesNotMatch(prompt, /concise Korean memory|atomic Korean memory|natural Korean|short Korean reason|Korean information-flow/);
    assert.ok(prompt.includes(english)); assert.ok(prompt.includes('응, 내일 봐.'));
});

test('cleanup preserves the retained rule language and does not use display translations', () => {
    const record = fact('en'); record.translatedKo = { text: 'DISPLAY_TRANSLATION_ONLY' };
    const prompt = memory.cleanupRequest([record, fact('ko', korean)], rows);
    assert.match(prompt, /Preserve the language of the retained rule \(keepId\)/);
    assert.match(prompt, /Cleanup is not a translation or language-migration task/);
    assert.doesNotMatch(prompt, /concise Korean merged rule|short Korean reason|DISPLAY_TRANSLATION_ONLY/);
});

test('collection reads original messages instead of translated display text', () => {
    const box = {}; vm.createContext(box);
    vm.runInContext(code.slice(code.indexOf('function sourceRows('), code.indexOf('function recentCleanupRows(')), box);
    const ctx = { chat: [{ mes: english, is_user: false, extra: { display_text: korean } }] };
    assert.equal(box.sourceRows(ctx, 0).rows[0].text, english);
});

for (const text of [english, korean]) test(`parsed ${text === english ? 'English' : 'Korean'} memories keep their language through storage, merge and injection`, () => {
    const sources = [{ id: 0, role: 'character', text }];
    const raw = JSON.stringify({ operations: [{ action: 'add', kind: 'fact', text, sourceId: 0, evidence: text, evidenceType: 'explicit_statement', importance: 5, confidence: 1, knowledge: {} }] });
    const parsed = memory.parseMemoryOperations(raw, sources, [], 'chat', [], { collectorOnly: true });
    assert.equal(parsed.operations.length, 1);
    const value = { facts: [] }; memory.applyMemoryOperations(value, parsed.operations, 'chat');
    assert.equal(value.facts[0].text, text);
    value.facts.push(fact('duplicate', text));
    const actions = memory.parseCleanupActions(JSON.stringify({ actions: [{ action: 'merge', keepId: value.facts[0].id, removeIds: ['duplicate'], text, reason: 'Same event' }] }), value, sources);
    assert.equal(actions.length, 1);
    memory.applyCleanupActions(value, actions, 'chat');
    assert.equal(value.facts[0].text, text);
    assert.ok(memory.memoryInjection(value.facts, '', 40, true).includes(text));
});

for (const provider of ['google', 'profile']) test(`${provider} display translation cannot change stored or injected English`, async () => {
    const record = fact('en'); const value = { facts: [record], candidates: [] };
    const ctx = { chatId: 'chat' }; const errors = [];
    const result = JSON.stringify({ items: [{ id: '0', text: korean, sourceText: korean }] });
    const box = { ...core, busy: false, extracting: false, translating: false, memoryPending: false,
        translationBackgroundSafe: false, stopTranslationRequested: false,
        context: () => ctx, chatKey: c => c.chatId, data: () => value,
        settings: () => ({ translationProfileId: 'translator' }), translationProvider: () => provider,
        supportsBackgroundUtility: () => true, render() {}, status() {}, save: async () => {},
        diagnosticError: (...args) => errors.push(args), traceDiagnostic: async (_label, action) => action(),
        generateUtility: async () => result,
        googleTranslateInputs: async inputs => core.parseTranslations(result, inputs),
    };
    vm.createContext(box);
    vm.runInContext(code.slice(code.indexOf('function displayText('), code.indexOf('function appendOriginal(')), box);
    const start = code.indexOf('export async function translateRecords(');
    const end = code.indexOf('\n}', start) + 2;
    vm.runInContext(code.slice(start, end).replace('export ', ''), box);
    await box.translateRecords('all');
    assert.deepEqual(errors, []);
    assert.equal(box.displayText(record), korean);
    assert.equal(record.text, english); assert.equal(record.sourceText, english);
    const injection = memory.memoryInjection([record], '', 40, true);
    assert.ok(injection.includes(english)); assert.ok(!injection.includes(korean));
    const check = core.buildChecks('A new English reply.', [record], '', 'Chris')[0];
    assert.equal(check.state.established_facts[0].text, english);
    // The local batch keeps fact references; only state/questions are sent to JEV.
    assert.ok(!JSON.stringify({ state: check.state, questions: check.questions }).includes(korean));
});

test('explicit recollection only replaces automatic memories from this room', () => {
    const value = { facts: [fact('old', korean), { ...fact('locked', korean), pinned: true }, { ...fact('manual', korean), origin: 'manual' }, { ...fact('other', korean), sourceChatId: 'other-room' }], candidates: [] };
    memory.resetRecentWindow(value, {}, [{ mes: english, is_user: false }], 'chat');
    assert.deepEqual(value.facts.map(item => item.id), ['locked', 'manual', 'other']);
});
