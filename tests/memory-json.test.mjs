import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryOperations, parseCleanupActions } from '../memory-engine.js';
import { classifyDiagnosticError, clearDiagnostics, diagnosticError, diagnosticReport } from '../diagnostics.js';

const source = 'Dana said "Meet me at {library} [north]" and left.';
const rows = [{ id: 3, text: source }];
const operation = { action: 'add', kind: 'fact', text: source, sourceId: 3, evidence: source,
    evidenceType: 'explicit_statement', confidence: 1, knowledge: {}, reason: 'A direct statement.' };
const valid = JSON.stringify({ operations: [operation] });
const parse = raw => parseMemoryOperations(raw, rows, [], 'chat', [], { collectorOnly: true });

for (const [name, wrap] of [
    ['plain', text => text], ['BOM', text => '\uFEFF' + text],
    ['JSON fence', text => '```JSON\r\n' + text + '\r\n```'],
    ['prose', text => 'Here is the result:\n' + text + '\nThat is all.'],
    ['prose and fence', text => '수집 결과입니다.\n```json\n' + text + '\n```\n완료했습니다.'],
]) test(`${name} preserves exact source text and parses every operation`, () => {
    const result = parse(wrap(valid));
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].text, source);
    assert.equal(result.operations[0].sourceText, source);
});

test('cleanup accepts prose-wrapped JSON without changing the actions', () => {
    const value = { facts: ['a', 'b'].map(id => ({ id, text: 'Same fact.', kind: 'fact', active: true, knowledge: {} })) };
    const before = JSON.stringify(value);
    const result = parseCleanupActions('Result:\n```json\n' + JSON.stringify({ actions: [{ action: 'merge', keepId: 'a', removeIds: ['b'], text: 'Same fact.' }] }) + '\n```', value, []);
    assert.equal(result.length, 1); assert.equal(result[0].text, 'Same fact.');
    assert.equal(JSON.stringify(value), before);
});

for (const [name, raw, issue] of [
    ['truncated outer object', valid.slice(0, -1), 'json_incomplete'],
    ['truncated string', '{"operations":[{"text":"PRIVATE_UNFINISHED', 'json_incomplete'],
    ['valid prefix plus truncated second object', valid + '\n{"operations":[', 'json_incomplete'],
    ['multiple results', valid + '\n' + valid, 'json_ambiguous'],
    ['two results inside separate fences', '```json\n' + valid + '\n```\n```json\n' + valid + '\n```', 'json_ambiguous'],
    ['trailing comma', '{"operations":[],}', 'json_malformed'],
    ['unescaped quote', '{"operations":[{"text":"PRIVATE_"BROKEN""}]}', 'json_malformed'],
    ['odd quotes leaving an open string', '{"operations":[{"text":"PRIVATE_"BROKEN"}]}', 'json_incomplete'],
    ['malformed outer object with valid nested object', '{"outer":' + valid + ',}', 'json_malformed'],
    ['nested schema', '{"outer":' + valid + '}', 'json_schema'],
    ['array wrapper', '[' + valid + ']', 'json_schema'],
    ['wrong field', '{"actions":[]}', 'json_schema'],
    ['wrong list type', '{"operations":{}}', 'json_schema'],
    ['plain text', 'PRIVATE_UNEXPECTED_TEXT', 'json_malformed'],
    ['null', 'null', 'json_schema'],
]) test(`${name} is rejected without inventing or salvaging memories`, () => {
    assert.throws(() => parse(raw), error => {
        assert.equal(error.hundredlogJsonIssue, issue);
        assert.equal(classifyDiagnosticError(error).detail, issue);
        assert.doesNotMatch(error.message, /PRIVATE_|Dana/);
        return true;
    });
});

test('valid empty collection still means no changes, not an error', () => {
    assert.equal(parse('{"operations":[]}').operations.length, 0);
});

test('format recovery does not bypass evidence validation', () => {
    const result = parse('Result: ' + JSON.stringify({ operations: [{ ...operation, evidence: 'not in the source' }] }));
    assert.equal(result.operations.length, 0);
    assert.equal(result.rejected, 1);
});

test('diagnostics distinguish incomplete JSON without retaining response contents', () => {
    clearDiagnostics();
    try { parse('{"operations":[{"text":"PRIVATE_RESPONSE_SECRET'); }
    catch (error) { diagnosticError('규칙 파싱', error); }
    const report = diagnosticReport();
    assert.match(report, /json_incomplete/);
    assert.doesNotMatch(report, /PRIVATE_RESPONSE_SECRET/);
    clearDiagnostics();
});
