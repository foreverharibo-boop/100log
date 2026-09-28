import { MAX_FACTS, chatKey, buildChecks, readContradictions, parseFactCandidates, newId } from './core.js';

const NAME = 'memorybean';
const KEY_STORAGE = 'memorybean.typesafeKey';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const ST_JEV_ROUTE = '/api/backends/chat-completions/generate';
const ST_STRIP = ['messages', 'prompt', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'top_p', 'top_k', 'stop', 'logit_bias', 'seed', 'n', 'logprobs', 'top_logprobs', 'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'verbosity'];
let busy = false;
let extracting = false;
let stopExtractionRequested = false;
let statusText = '준비됐어요.';
let settingsHome = null;
let wandMenuObserver = null;
let lastJevTransport = '실리태번 API';

const context = () => SillyTavern.getContext();
const $id = (id) => document.getElementById(`memorybean-${id}`);

function apiKey() {
    try { return localStorage.getItem(KEY_STORAGE)?.trim() ?? ''; } catch { return ''; }
}

async function requestJev(state, questions) {
    const key = apiKey();
    if (!key) throw new Error('확장 설정에 Jev API 키를 먼저 입력해 주세요.');
    const body = JSON.stringify({ model: 'jev-latest', state, questions });
    let response;
    let transport = '실리태번 API';
    // SillyTavern's custom chat-completions endpoint can relay this non-chat JSON request.
    try {
        const headers = context().getRequestHeaders?.();
        if (!headers) throw new Error('실리태번 요청 헤더를 사용할 수 없어요.');
        response = await fetch(ST_JEV_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            credentials: 'same-origin',
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: `${JEV_URL}?via=`,
                model: 'jev-latest',
                messages: [{ role: 'user', content: '.' }],
                stream: false,
                custom_include_body: JSON.stringify({ state, questions }),
                custom_exclude_body: JSON.stringify(ST_STRIP),
                custom_include_headers: JSON.stringify({ Authorization: `Bearer ${key}` })
            }),
            signal: AbortSignal.timeout(25000)
        });
    } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error('실리태번 API를 통한 Jev 연결 시간이 초과됐어요.');
        response = null;
    }
    if (response && ![404, 405].includes(response.status)) {
        if (!response.ok) {
            if (response.status === 401) throw new Error('실리태번 API 경로에서 인증 오류 (401). Jev API 키를 다시 확인해 주세요.');
            if (response.status === 403) throw new Error('실리태번 API 요청이 거부됐어요 (403). 실리태번을 새로고침하고 다시 시도해 주세요.');
            throw new Error(`실리태번 API 경로의 Jev 연결 오류 (${response.status}).`);
        }
        let result;
        try { result = await response.json(); } catch { throw new Error('실리태번 API에서 받은 Jev 응답을 읽지 못했어요.'); }
        if (result?.error) {
            const message = String(result.error?.message ?? result.error).slice(0, 200);
            if (/unauthori|invalid.api.key|forbidden/i.test(message)) throw new Error('Jev가 키 인증을 거절했어요 (실리태번 API 경로). 키를 다시 확인해 주세요.');
            throw new Error(`실리태번 API 경로의 Jev 오류: ${message}`);
        }
        if (!result?.answers || typeof result.answers !== 'object') throw new Error('실리태번 API 경로의 Jev 응답에 판정 결과가 없어요.');
        lastJevTransport = transport;
        return result;
    }
    transport = '직접 연결';
    try {
        response = await fetch(JEV_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: AbortSignal.timeout(25000)
        });
    } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error('Jev API 응답 시간이 초과됐어요.');
        const stHeaders = context().getRequestHeaders?.();
        if (!stHeaders) throw new Error('브라우저 직접 연결이 막혔고, 실리태번의 프록시 요청 헤더를 가져오지 못했어요.');
        try {
            response = await fetch(`/proxy/${encodeURIComponent(JEV_URL)}`, {
                method: 'POST',
                headers: { ...stHeaders, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body,
                credentials: 'same-origin',
                signal: AbortSignal.timeout(25000)
            });
            transport = '실리태번 내장 프록시';
        } catch (proxyError) {
            if (proxyError?.name === 'TimeoutError') throw new Error('실리태번 내장 프록시를 통한 Jev 연결 시간이 초과됐어요.');
            throw new Error('직접 연결과 실리태번 내장 프록시가 모두 실패했어요. 서버 인터넷 연결을 확인해 주세요.');
        }
        if (response.status === 404) throw new Error('브라우저 직접 연결이 막혔고 실리태번 내장 프록시가 꺼져 있어요. SillyTavern/config.yaml에서 enableCorsProxy: true로 바꾸고 서버를 다시 시작해 주세요.');
    }
    if (!response.ok) {
        if (response.status === 401) throw new Error(`Jev 인증 오류 (401, ${transport}). 키를 다시 확인해 주세요.`);
        if (response.status === 422) throw new Error('Jev 요청 형식 오류 (422). 메모리콩을 최신 버전으로 업데이트해 주세요.');
        if (response.status === 429) throw new Error('Jev 요청 한도 초과 (429). 잠시 후 다시 시도해 주세요.');
        throw new Error(`Jev 연결 오류 (${response.status}). 서비스 상태 또는 실리태번 프록시 설정을 확인해 주세요.`);
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('Jev 응답을 읽지 못했어요.'); }
    if (!result?.answers || typeof result.answers !== 'object') throw new Error('Jev 응답에 판정 결과가 없어요.');
    lastJevTransport = transport;
    return result;
}

function settings() {
    const ctx = context();
    ctx.extensionSettings[NAME] ??= { enabled: false };
    return ctx.extensionSettings[NAME];
}

function data(create = true) {
    const ctx = context();
    if (!chatKey(ctx)) return null;
    if (create) ctx.chatMetadata[NAME] ??= { facts: [], candidates: [], extractionCursor: 0 };
    const value = ctx.chatMetadata[NAME];
    if (!value) return null;
    value.facts ??= [];
    value.candidates ??= [];
    value.extractionCursor ??= 0;
    return value;
}

async function save() { await context().saveMetadata(); }
function status(value) {
    statusText = value;
    if ($id('status')) $id('status').textContent = value;
}

function makeButton(text, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = text;
    button.addEventListener('click', action);
    return button;
}

function render() {
    if (!$id('facts')) return;
    const value = data();
    $id('enabled').checked = Boolean(settings().enabled);
    $id('enabled').disabled = busy || extracting;
    $id('key').disabled = busy;
    $id('test').disabled = busy;
    $id('clearkey').disabled = busy;
    $id('extract').disabled = busy || extracting || !value;
    $id('stop').disabled = !extracting;
    $id('add').disabled = busy || !value;
    $id('newfact').disabled = busy || !value;
    $id('facts').replaceChildren();
    $id('candidates').replaceChildren();
    $id('count').textContent = value ? `${value.facts.filter((item) => item.active).length}개 활성` : '채팅을 선택해 주세요';
    $id('candidate-count').textContent = value ? `${value.candidates.length}개` : '';
    $id('progress').textContent = value ? `읽은 대화 ${value.extractionCursor}/${context().chat.length}` : '';
    if (!value) { status('캐릭터 채팅을 선택하면 사용할 수 있어요.'); return; }
    if (!value.facts.length) {
        const empty = document.createElement('p'); empty.className = 'memorybean-empty'; empty.textContent = '아직 승인된 사실이 없어요.'; $id('facts').append(empty);
    }
    for (const fact of value.facts) {
        const item = document.createElement('div'); item.className = 'memorybean-item';
        const title = document.createElement('div'); title.className = 'memorybean-text'; title.textContent = fact.text; item.append(title);
        const meta = document.createElement('div'); meta.className = 'memorybean-meta'; meta.textContent = `${fact.active ? '검수에 사용 중' : '사용 안 함'} · ${fact.scope === 'scene' ? '현재 장면' : '지속 설정'}${Number.isInteger(fact.sourceId) ? ` · 대화 #${fact.sourceId}` : ''}`; item.append(meta);
        const actions = document.createElement('div'); actions.className = 'memorybean-actions';
        actions.append(makeButton(fact.active ? '잠시 끄기' : '다시 켜기', async () => { fact.active = !fact.active; await save(); render(); }));
        actions.append(makeButton(fact.scope === 'scene' ? '지속 설정으로' : '현재 장면만', async () => { fact.scope = fact.scope === 'scene' ? 'always' : 'scene'; await save(); render(); }));
        actions.append(makeButton('삭제', async () => { value.facts = value.facts.filter((entry) => entry.id !== fact.id); await save(); render(); }));
        item.append(actions); $id('facts').append(item);
    }
    if (!value.candidates.length) {
        const empty = document.createElement('p'); empty.className = 'memorybean-empty'; empty.textContent = '검토할 후보가 없어요.'; $id('candidates').append(empty);
    }
    for (const candidate of value.candidates) {
        const item = document.createElement('div'); item.className = 'memorybean-item';
        const title = document.createElement('div'); title.className = 'memorybean-text'; title.textContent = candidate.text; item.append(title);
        const meta = document.createElement('div'); meta.className = 'memorybean-meta'; meta.textContent = `대화 #${candidate.sourceId}: ${candidate.sourceText}`; item.append(meta);
        const actions = document.createElement('div'); actions.className = 'memorybean-actions';
        actions.append(makeButton('승인', async () => {
            if (value.facts.length >= MAX_FACTS) { status('기억할 사실은 최대 80개예요.'); return; }
            value.candidates = value.candidates.filter((entry) => entry.id !== candidate.id);
            value.facts.push({ ...candidate, active: true });
            await save(); render();
        }));
        actions.append(makeButton('제외', async () => { value.candidates = value.candidates.filter((entry) => entry.id !== candidate.id); await save(); render(); }));
        item.append(actions); $id('candidates').append(item);
    }
    $id('status').textContent = statusText;
}

function sourceRows(ctx, start) {
    const rows = [];
    for (let i = start; i < Math.min(ctx.chat.length, start + 40); i++) {
        const msg = ctx.chat[i];
        if (!msg || msg.is_system || typeof msg.mes !== 'string' || !msg.mes.trim()) continue;
        rows.push({ id: i, name: msg.name ?? (msg.is_user ? ctx.name1 : ctx.name2), text: msg.mes.trim().slice(0, 700) });
    }
    return rows;
}

function parseJson(raw) {
    const clean = String(raw ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(clean);
}

export async function collectHistory() {
    const ctx = context();
    const key = chatKey(ctx);
    const value = data();
    if (!key || !value || extracting || busy) return;
    const total = ctx.chat.length;
    if (value.extractionCursor >= total) { status('현재 대화를 끝까지 읽었어요. 이후 메시지가 생기면 다시 수집할 수 있어요.'); return; }
    extracting = true;
    stopExtractionRequested = false;
    render();
    let collected = 0;
    try {
        while (value.extractionCursor < total && !stopExtractionRequested) {
            const start = value.extractionCursor;
            const rows = sourceRows(ctx, start);
            status(`이전 대화 수집 중: ${start}/${total}개 읽음 · 후보 ${collected}개`);
            let candidates = [];
            if (rows.length) {
                const prompt = [
                    'Extract up to 12 durable, concrete RP continuity facts explicitly supported by these chat messages. Return JSON only: {"facts":[{"text":"...","sourceId":0,"scope":"always"}]}. Use scope "scene" for temporary scene details. Keep the language used in the chat. Do not infer hidden intentions; dialogue claims may be untrue, so label candidates for human review. Cite the actual numbered sourceId of each fact. No commentary.',
                    JSON.stringify(rows)
                ].join('\n\n');
                const raw = await ctx.generateRaw({ prompt });
                candidates = parseFactCandidates(raw, rows);
            }
            if (chatKey(context()) !== key || data(false) !== value) { status('채팅이 바뀌어 수집을 멈췄어요.'); return; }
            const existing = new Set([...value.facts, ...value.candidates].map((entry) => entry.text.trim().toLocaleLowerCase()));
            const fresh = candidates.filter((entry) => {
                const text = entry.text.trim().toLocaleLowerCase();
                if (existing.has(text)) return false;
                existing.add(text);
                return true;
            });
            value.candidates.push(...fresh);
            collected += fresh.length;
            value.extractionCursor = Math.min(start + 40, total);
            await save();
            render();
        }
        status(stopExtractionRequested
            ? `${value.extractionCursor}/${total}개까지 읽고 멈췄어요. 후보 ${collected}개를 추가했어요.`
            : `현재 채팅의 이전 대화 ${total}개를 끝까지 읽었어요. 새 후보 ${collected}개를 확인하고 승인해 주세요.`);
    } catch (error) { console.error('[메모리콩] 후보 추출 실패', error); status(`수집을 멈췄어요 (${value.extractionCursor}/${total}개까지 저장됨): ${error.message}`); }
    finally { extracting = false; render(); }
}

function recentChat(ctx) {
    return ctx.chat.slice(-6).map((message) => `${message.name ?? (message.is_user ? ctx.name1 : ctx.name2)}: ${String(message.mes ?? '').slice(0, 500)}`).join('\n');
}

async function judge(draft, facts, recent) {
    const batches = buildChecks(draft, facts, recent);
    const found = [];
    for (const batch of batches) {
        const body = await requestJev(batch.state, batch.questions);
        found.push(...readContradictions(batch, body.answers));
    }
    return found;
}

function correctionPrompt(draft, flagged) {
    const issues = flagged.map((item) => ({
        segment: item.segmentIndex + 1,
        established_fact: item.fact.text,
        source: item.fact.sourceText ?? '',
        conflicting_passage: item.segment.slice(0, 1250)
    }));
    return `Revise the following unpublished character reply. The listed passages contradict approved story facts. Fix only the specific contradictions; preserve the rest of the reply, its language, voice, pacing, POV, and formatting. Do not quote these instructions or explain the edit. Output only the full revised character reply.\n\nApproved issues: ${JSON.stringify(issues)}\n\nUnpublished reply:\n${draft}`;
}

function stillSameChat(key, lastMessage) {
    const ctx = context();
    return chatKey(ctx) === key && ctx.chat.at(-1) === lastMessage && Boolean(lastMessage?.is_user);
}

async function commitReply(text, key, lastMessage) {
    if (!stillSameChat(key, lastMessage)) throw new Error('대화가 바뀌어 답변을 게시하지 않았어요.');
    const ctx = context();
    if (typeof ctx.addOneMessage !== 'function' || typeof ctx.saveChat !== 'function') throw new Error('이 SillyTavern 버전에서 답변 저장 기능을 찾지 못했어요.');
    const message = {
        name: ctx.name2, is_user: false, is_system: false, send_date: new Date().toISOString(),
        mes: text, extra: { gen_id: Date.now(), memorybean: true }, swipes: [text], swipe_id: 0
    };
    ctx.chat.push(message);
    try {
        const index = ctx.chat.length - 1;
        await ctx.eventSource.emit((ctx.eventTypes ?? ctx.event_types).MESSAGE_RECEIVED, index, 'normal');
        ctx.addOneMessage(message);
        await ctx.eventSource.emit((ctx.eventTypes ?? ctx.event_types).CHARACTER_MESSAGE_RENDERED, index);
        await ctx.saveChat();
    } catch (error) {
        // Never remove a message after rendering or after another extension has observed it.
        console.error('[메모리콩] 답변 게시 중 오류:', error);
        throw new Error('답변 표시 또는 저장 중 오류가 났어요. 채팅에 답변이 보이는지 확인해 주세요.');
    }
}

async function runHidden(key, lastMessage) {
    try {
        const ctx = context();
        if (!stillSameChat(key, lastMessage)) throw new Error('대화가 바뀌어 생성을 중단했어요.');
        const facts = data(false)?.facts.filter((item) => item.active).map((item) => ({ ...item })) ?? [];
        if (!apiKey()) throw new Error('확장 설정에 Jev API 키를 먼저 입력해 주세요.');
        const recent = recentChat(ctx);
        status('메인 AI가 숨은 초안을 작성 중이에요…');
        const draft = String(await ctx.generateQuietPrompt({ quietPrompt: 'Write the next in-character roleplay reply to the latest user message. Output only the reply, with no preface or explanation.' }) ?? '').trim();
        if (!stillSameChat(key, lastMessage)) throw new Error('대화가 바뀌어 생성을 중단했어요.');
        status('Jev가 승인된 사실과 초안을 비교 중이에요…');
        const flagged = await judge(draft, facts, recent);
        let final = draft;
        if (flagged.length) {
            status(`설정 충돌 ${flagged.length}곳을 발견했어요. 메인 AI에게 수정 요청 중이에요…`);
            final = String(await ctx.generateQuietPrompt({ quietPrompt: correctionPrompt(draft, flagged) }) ?? '').trim();
            if (!final) throw new Error('수정 답변이 비어 있어 게시하지 않았어요.');
            status('수정 답변을 한 번 더 확인하고 있어요…');
            const again = await judge(final, facts, recent);
            if (again.length) throw new Error(`재검수 후에도 설정 충돌 ${again.length}곳이 남아 있어 답변을 표시하지 않았어요.`);
        }
        if (!final || final.length > 18000) throw new Error('최종 답변의 길이를 확인할 수 없어 게시하지 않았어요.');
        await commitReply(final, key, lastMessage);
        status(flagged.length ? `충돌 ${flagged.length}곳을 고쳐 게시했어요.` : '설정 충돌 없이 답변을 게시했어요.');
    } catch (error) { console.error('[메모리콩] 생성/검수 실패:', error); status(`답변을 표시하지 않았어요: ${error.message}`); }
    finally { busy = false; render(); }
}

globalThis.memorybeanGenerationInterceptor = async function (_promptChat, _size, abort, type) {
    const ctx = context();
    if (!settings().enabled || ![undefined, 'normal'].includes(type) || !chatKey(ctx)) return;
    const confirmed = data(false)?.facts.filter((fact) => fact.active) ?? [];
    if (!confirmed.length) return;
    abort(true);
    if (extracting) { status('이전 대화를 수집하는 동안에는 답변 생성을 보류했어요.'); return; }
    if (busy) { status('이미 답변을 검수하고 있어요. 잠시 기다려 주세요.'); return; }
    const last = ctx.chat.at(-1);
    if (!last?.is_user) { status('마지막 메시지가 사용자 메시지가 아니라 생성 요청을 멈췄어요.'); return; }
    const key = chatKey(ctx);
    busy = true;
    status('답변을 잠시 보류하고 있어요…'); render();
    // Let SillyTavern finish unwinding the aborted normal generation first.
    setTimeout(() => { void runHidden(key, last); }, 300);
};

function closeWand() {
    const overlay = document.getElementById('memorybean-wand-overlay');
    const panel = document.getElementById('memorybean');
    if (panel && settingsHome && panel.parentElement !== settingsHome) settingsHome.append(panel);
    if (overlay) overlay.hidden = true;
}

function openWand() {
    const panel = document.getElementById('memorybean');
    if (!panel) return;
    let overlay = document.getElementById('memorybean-wand-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'memorybean-wand-overlay';
        overlay.hidden = true;
        const popup = document.createElement('div');
        popup.id = 'memorybean-wand-popup';
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', '메모리콩 설정');
        const header = document.createElement('div');
        header.id = 'memorybean-wand-header';
        const title = document.createElement('strong');
        title.textContent = '🌱 메모리콩';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'menu_button';
        close.textContent = '닫기';
        close.addEventListener('click', closeWand);
        header.append(title, close);
        const body = document.createElement('div');
        body.id = 'memorybean-wand-body';
        popup.append(header, body);
        overlay.append(popup);
        overlay.addEventListener('click', (event) => { if (event.target === overlay) closeWand(); });
        document.documentElement.append(overlay);
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !overlay.hidden) closeWand(); });
    }
    if (!settingsHome) settingsHome = panel.parentElement;
    document.getElementById('memorybean-wand-body').append(panel);
    overlay.hidden = false;
    const menu = document.getElementById('extensionsMenu');
    if (menu) menu.style.display = 'none';
    render();
}

function addWandButton() {
    if (document.getElementById('memorybean-wand-button')) {
        wandMenuObserver?.disconnect();
        wandMenuObserver = null;
        return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        if (!wandMenuObserver && document.body && typeof MutationObserver !== 'undefined') {
            wandMenuObserver = new MutationObserver(addWandButton);
            wandMenuObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
    }
    wandMenuObserver?.disconnect();
    wandMenuObserver = null;
    const button = document.createElement('div');
    button.id = 'memorybean-wand-button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.innerHTML = '<span class="extensionsMenuExtensionButton" aria-hidden="true">🌱</span><span>메모리콩</span>';
    button.addEventListener('click', openWand);
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openWand(); }
    });
    menu.append(button);
}

async function main() {
    const ctx = context();
    if ($id('enabled')) { addWandButton(); return; }
    const response = await fetch(new URL('./settings.html', import.meta.url), { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`설정 화면 파일을 읽지 못했어요 (${response.status}).`);
    const html = await response.text();
    const container = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!container) throw new Error('확장 설정 패널을 찾지 못했어요.');
    container.insertAdjacentHTML('beforeend', html);
    if ($id('key')) $id('key').value = apiKey();
    if ($id('server')) $id('server').textContent = apiKey() ? '키 저장됨 · 연결 확인 필요' : 'API 키를 입력해 주세요';
    function connectionError(message = '') {
        const element = $id('connection-error');
        if (!element) return;
        element.textContent = message;
        element.hidden = !message;
    }
    $id('key')?.addEventListener('input', () => {
        $id('server').textContent = '키 입력 중';
        connectionError();
    });
    $id('key')?.addEventListener('change', () => {
        try {
            const value = $id('key').value.trim();
            if (value) localStorage.setItem(KEY_STORAGE, value);
            else localStorage.removeItem(KEY_STORAGE);
            $id('server').textContent = value ? '키 저장됨 · 연결 확인 필요' : 'API 키를 입력해 주세요';
        } catch { status('이 브라우저에 키를 저장하지 못했어요.'); }
    });
    $id('test')?.addEventListener('click', async () => {
        try {
            const value = $id('key').value.trim();
            if (!value) throw new Error('API 키를 입력해 주세요.');
            localStorage.setItem(KEY_STORAGE, value);
            $id('server').textContent = 'Jev 연결 확인 중…';
            const result = await requestJev('The sky is blue.', { test: { type: 'noul', instructions: 'Does the sentence state a color of the sky?' } });
            if (result.answers.test?.type !== 'noul') throw new Error('Jev 테스트 응답 형식이 맞지 않아요.');
            $id('server').textContent = 'Jev 연결됨';
            connectionError();
            status(`Jev에 연결됐어요 (${lastJevTransport}).`);
        } catch (error) {
            $id('server').textContent = '연결 실패';
            connectionError(error.message);
            status(error.message);
        }
    });
    $id('clearkey')?.addEventListener('click', () => {
        localStorage.removeItem(KEY_STORAGE);
        $id('key').value = '';
        $id('server').textContent = 'API 키를 입력해 주세요';
        connectionError();
        settings().enabled = false;
        ctx.saveSettingsDebounced();
        status('브라우저에 저장된 키를 삭제했어요.');
        render();
    });
    $id('enabled')?.addEventListener('change', (event) => {
        if (event.target.checked && !apiKey()) { status('Jev API 키를 먼저 입력해 주세요.'); render(); return; }
        settings().enabled = event.target.checked; ctx.saveSettingsDebounced(); render();
    });
    $id('add')?.addEventListener('click', async () => {
        const value = data();
        const text = $id('newfact').value.trim();
        if (!value || !text) return;
        if (value.facts.length >= MAX_FACTS) { status('기억할 사실은 최대 80개예요.'); return; }
        value.facts.push({ id: newId(), text: text.slice(0, 300), active: true, scope: 'always' });
        $id('newfact').value = ''; await save(); render();
    });
    $id('extract')?.addEventListener('click', () => { void collectHistory(); });
    $id('stop')?.addEventListener('click', () => { stopExtractionRequested = true; status('진행 중인 묶음을 마치고 수집을 멈출게요.'); });
    ctx.eventSource.on((ctx.eventTypes ?? ctx.event_types).CHAT_CHANGED, () => { status('준비됐어요.'); render(); });
    render();
    addWandButton();
}

const initialContext = context();
const appReady = (initialContext.eventTypes ?? initialContext.event_types)?.APP_READY;
if (appReady) {
    initialContext.eventSource.on(appReady, () => {
        void main().catch((error) => console.error('[메모리콩] 설정 화면 시작 실패:', error));
    });
} else {
    void main().catch((error) => console.error('[메모리콩] 설정 화면 시작 실패:', error));
}
