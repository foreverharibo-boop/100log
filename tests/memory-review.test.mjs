import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildChecks, readContradictions, normalizeKnowledge } from '../core.js';
import { memoryInjection, memoryRequest } from '../memory-engine.js';

const fact = (knowledge = { A: 'unknown' }) => ({ id: 'f', active: true,
    kind: 'commitment', text: 'A와 B는 전시를 관람 중이다.', knowledge,
    commitment: { status: 'underway' }, nameAliases: [{ alias: 'Alpha', canonical: 'A' }],
    sourceText: 'PRIVATE_SOURCE', supportingEvidence: [{ evidence: 'PRIVATE_SUPPORT', sourceId: 4, sourceChatId: 'chat' }],
    knowledgeEvidence: { A: { status: 'unknown', evidence: 'PRIVATE_KNOWLEDGE', reason: 'PRIVATE_REASON' } } });
const answer = (choice, confidence = .99) => ({ q0: { type: 'choice', choice, confidence } });

test('review sends saved state and an unabridged reply, without historical excerpts', () => {
    const reply = 'new reply '.repeat(10000);
    const batch = buildChecks(reply, [fact()], 'PRIVATE_RECENT', 'A', [{ text: 'PRIVATE_HISTORY' }])[0];
    assert.equal(batch.state.unpublished_reply, reply.trim());
    assert.deepEqual(batch.state.established_facts[0], { q: 'q0', id: 'f', text: fact().text,
        scope: undefined, knowledge: { A: 'unknown' }, progress: 'underway', name_aliases: fact().nameAliases });
    assert.doesNotMatch(JSON.stringify({ state: batch.state, questions: batch.questions }), /PRIVATE_|source_messages|recent_chat|knowledge_evidence|supporting_evidence/);
});

test('stored unknown is enforceable without independent source proof', () => {
    const f = fact(); delete f.sourceText; delete f.knowledgeEvidence;
    const batch = buildChecks('A reveals the secret.', [f], '', 'Alpha')[0];
    assert.equal(readContradictions(batch, answer('knowledge_leak')).length, 1);
});

test('unverified, missing, known and another person unknown do not enforce speaker ignorance', () => {
    for (const knowledge of [{ A: 'unverified' }, {}, { A: 'known' }, { B: 'unknown' }]) {
        const batch = buildChecks('new reply', [fact(knowledge)], '', 'A')[0];
        assert.equal(readContradictions(batch, answer('knowledge_leak')).length, 0);
    }
});

test('compatible, uncertain and low confidence decisions do not trigger rewriting', () => {
    const batch = buildChecks('new reply', [fact()])[0];
    for (const decision of [answer('no_conflict'), answer('unclear'), answer('contradiction', .5)]) {
        assert.equal(readContradictions(batch, decision).length, 0);
    }
    assert.equal(readContradictions(batch, answer('contradiction')).length, 1);
});

test('draft context and rewrite instructions use saved memories without source quotes', () => {
    const context = memoryInjection([fact()], '', 40, true);
    assert.match(context, /underway/);
    assert.doesNotMatch(context, /PRIVATE_|Prefer the original conversation/);
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('function correctionPrompt('), source.indexOf('function stillSameChat('));
    const sandbox = { normalizeKnowledge }; vm.createContext(sandbox); vm.runInContext(code, sandbox);
    const prompt = sandbox.correctionPrompt('REPLY', [{ fact: fact(), kind: 'contradiction' }], context);
    assert.match(prompt, /Fix only those conflicts/);
    assert.match(prompt, /full revised character reply/);
    assert.doesNotMatch(prompt, /PRIVATE_/);
});

test('collector still receives original text and preserved evidence', () => {
    const prompt = memoryRequest([fact()], [{ id: 7, text: 'COLLECTOR_ORIGINAL' }], []);
    assert.match(prompt, /COLLECTOR_ORIGINAL/);
    assert.match(prompt, /PRIVATE_SUPPORT/);
});

test('review excludes archived, superseded and paused memories', () => {
    assert.deepEqual(buildChecks('new reply', [{ ...fact(), active: false }, { ...fact(), archived: 'completed' }, { ...fact(), supersededBy: 'other' }]), []);
});
