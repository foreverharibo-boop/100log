import assert from 'node:assert/strict';
import test from 'node:test';
import { generateUtility } from '../core.js';

function fixture({ source = 'vertexai', preset, profile = {}, current = {} } = {}) {
    const saved = Object.freeze({ id: 'collector', api: 'vertexai', model: 'gemini-test',
        preset: 'collector-preset', 'secret-id': 'collector-key', 'api-url': 'global', ...profile });
    const ctx = {
        chatCompletionSettings: Object.freeze({ chat_completion_source: 'openai',
            vertexai_auth_mode: 'full', vertexai_express_project_id: 'main-project', ...current }),
        extensionSettings: { connectionManager: { selectedProfile: 'main' } },
        getPresetManager: type => { assert.equal(type, 'openai'); return {
            getCompletionPresetByName: name => { assert.equal(name, saved.preset); return preset; },
        }; },
    };
    const calls = [];
    ctx.ConnectionManagerRequestService = {
        getSupportedProfiles: () => [saved],
        validateProfile: value => { assert.equal(value, saved); return { selected: 'openai', source }; },
        sendRequest: async (id, messages, maxTokens, options, overrides) => {
            assert.equal(id, saved.id);
            // ST's lean connection service supplies the saved route and key,
            // but no Vertex authentication mode/project unless overridden.
            const payload = { model: saved.model, secret_id: saved['secret-id'],
                chat_completion_source: source, vertexai_region: saved['api-url'],
                messages, max_tokens: maxTokens, ...overrides };
            calls.push({ payload, options });
            if (source === 'vertexai' && !payload.vertexai_auth_mode) throw Error('Vertex authentication mode missing');
            return { content: 'facts' };
        },
    };
    return { ctx, saved, calls };
}

for (const mode of ['express', 'full']) test(`separate Vertex ${mode} profile preserves saved auth and key while main differs`, async () => {
    const preset = Object.freeze({ vertexai_auth_mode: mode, vertexai_express_project_id: 'collector-project',
        vertexai_region: 'us-central1', temperature: 1.7, max_tokens: 30000 });
    const { ctx, calls, saved } = fixture({ preset });
    const before = JSON.stringify({ current: ctx.chatCompletionSettings, saved, preset });
    const signal = new AbortController().signal;
    assert.equal(await generateUtility(ctx, 'Extract facts', saved.id, 6000, signal), 'facts');
    assert.equal(calls.length, 1);
    const { payload, options } = calls[0];
    assert.equal(payload.vertexai_auth_mode, mode);
    assert.equal(payload.vertexai_express_project_id, 'collector-project');
    assert.equal(payload.vertexai_region, 'global');
    assert.equal(payload.secret_id, 'collector-key');
    assert.equal(payload.model, 'gemini-test');
    assert.equal(payload.max_tokens, 6000);
    assert.equal('temperature' in payload, false);
    assert.equal(options.includePreset, false);
    assert.equal(options.signal, signal);
    assert.equal(ctx.extensionSettings.connectionManager.selectedProfile, 'main');
    assert.equal(JSON.stringify({ current: ctx.chatCompletionSettings, saved, preset }), before);
});

test('saved empty project does not inherit the main project and blank profile region uses preset', async () => {
    const { ctx, calls } = fixture({ profile: { 'api-url': '' }, preset: {
        vertexai_auth_mode: 'express', vertexai_express_project_id: '', vertexai_region: 'europe-west4',
    } });
    await generateUtility(ctx, 'facts', 'collector');
    assert.equal(calls[0].payload.vertexai_express_project_id, '');
    assert.equal(calls[0].payload.vertexai_region, 'europe-west4');
});

test('profile without a preset uses configured Vertex settings but keeps its own key', async () => {
    const { ctx, calls } = fixture({ profile: { preset: '', 'api-url': '' }, current: {
        vertexai_auth_mode: 'express', vertexai_region: 'global', vertexai_express_project_id: 'configured-project',
    } });
    await generateUtility(ctx, 'facts', 'collector');
    assert.equal(calls[0].payload.vertexai_auth_mode, 'express');
    assert.equal(calls[0].payload.vertexai_region, 'global');
    assert.equal(calls[0].payload.vertexai_express_project_id, 'configured-project');
    assert.equal(calls[0].payload.secret_id, 'collector-key');
});

test('missing saved preset fails before sending instead of silently using main authentication', async () => {
    const { ctx, calls } = fixture();
    await assert.rejects(generateUtility(ctx, 'facts', 'collector'), /프리셋을 찾을 수 없어요/);
    assert.equal(calls.length, 0);
});

test('other providers keep lean requests and do not read Vertex presets', async () => {
    for (const source of ['openai', 'makersuite', 'custom']) {
        const { ctx, calls } = fixture({ source });
        ctx.getPresetManager = () => { throw Error('must not read other provider presets'); };
        await generateUtility(ctx, 'facts', 'collector');
        assert.equal('vertexai_auth_mode' in calls[0].payload, false);
        assert.equal(calls[0].options.includePreset, false);
    }
});
