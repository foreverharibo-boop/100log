// Diagnostics contain fixed labels and allowlisted metadata only. Never serialize payloads/errors.
export const DIAGNOSTIC_VERSION = '1.9.14';
const STORAGE = 'hundredlog.diagnostics.v1';
const LIMIT = 1;
const labels = {
    boot: '확장 시작', caught: '처리된 오류', global: '미처리 오류', rejection: '미처리 비동기 오류',
    start: '작업 시작', done: '작업 완료', failure: '작업 실패', request: 'HTTP 요청', response: 'HTTP 응답',
    retry: 'JEV 재시도 대기', delay: 'JEV 30초 지연', attempt: 'JEV 시도', jevDone: 'JEV 판정 수신',
    generation: '생성 진입', event: '실리태번 이벤트', skip: '검수 생략·중단', status: '상태 안내',
};
const stages = ['초기화', '메인 AI 초안 생성', '메인 AI 재작성', 'JEV 초안 검수', 'JEV 재검수', 'JEV 요청',
    '생성 준비', '답변 표시·저장', '규칙 수집', '규칙 청소', '규칙 파싱', '청소 파싱', '보조 AI', '규칙 저장',
    '번역', '화면', '설정 저장', '미처리', '기타'];
const enums = {
    collectionStage: ['수집 준비', '정리 AI 응답 대기', 'JEV 사실·지식 검증', 'JEV 분리 규칙 검증', 'JEV 청소 검증'],
    stage: stages,
    route: ['실리태번 JEV 중계', 'JEV 직접', '실리태번 프록시', 'Google 번역', 'Google 임베딩', '설정 파일', '기타'],
    mode: ['normal', 'swipe', 'regenerate', 'regen', 'retry', 'quiet', 'impersonate', 'continue', '기타'],
    event: ['CHAT_CHANGED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'APP_READY'],
    reason: ['비활성', '규칙 없음', '키 없음', '작업 중', '지원하지 않는 생성', '기타'],
    category: ['요청 한도', '서버 오류', '인증·권한', '요청 형식·크기', '시간 초과', '연결 실패', 'JSON·판정 형식', '빈 응답', '저장소', '대화 변경', '설정 충돌', '생성 중단', '코드 실행', '기타'],
    errorType: ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'TimeoutError', 'AbortError', 'QuotaExceededError', 'SecurityError', '기타'],
};
const numeric = new Set(['http', 'ms', 'attempt', 'waitMs', 'questions', 'rules', 'chars', 'count', 'site', 'line', 'column', 'id', 'requests', 'collectionSeconds', 'stageSeconds']);
const boolean = new Set(['busy', 'extracting', 'translating', 'enabled', 'hasKey', 'retryable', 'dryRun', 'profile', 'pending']);
const files = ['index.js', 'core.js', 'memory-engine.js', 'diagnostics.js'];
let entries = [];
let subscribers = new Set();
let storageAvailable = true;
let sequence = 0;
let notifying = false;
let clearEpoch = 0;
const errorDetails = new WeakMap();
const errorRecordedAt = new WeakMap();
const reasonLabels = {
    no_response: '실리태번에서 응답을 받지 못함', empty: '반환된 답변이 비어 있음',
    aborted: '생성이 취소되거나 중단됨', timeout: '응답 대기 시간 초과',
    network: '네트워크 요청 실패', missing_function: '호출할 함수가 없거나 호환되지 않음',
    undefined_value: '없는 값의 속성에 접근함', invalid_json: '응답을 JSON으로 해석하지 못함',
    http: 'HTTP 오류 코드 확인', context: '입력 또는 컨텍스트 길이 제한',
    blocked: '응답 차단 관련 오류 문구 확인', unknown: '전달된 오류만으로 세부 원인을 확인하지 못함',
    busy: '이미 생성 작업이 진행 중이라는 오류 문구 확인',
    disconnected: 'API에 연결되어 있지 않다는 오류 문구 확인',
};
const rootURL = new URL('./', import.meta.url).href;

function metadata(input = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(input)) {
        if (numeric.has(key) && Number.isFinite(value)) safe[key] = Math.max(0, Math.round(value));
        else if (boolean.has(key) && typeof value === 'boolean') safe[key] = value;
        else if (enums[key]) safe[key] = enums[key].includes(value) ? value : '기타';
        else if (key === 'file' && files.includes(value)) safe.file = value;
        else if (key === 'detail' && Object.hasOwn(reasonLabels, value)) safe.detail = value;
        else if (key === 'frames' && Array.isArray(value)) safe.frames = value.slice(0, 8).filter((v) =>
            /^(?:100LOG\/(?:index|core|memory-engine|diagnostics)\.js|SillyTavern\/(?:script|openai|extensions|utils)\.js|외부 스크립트):\d+:\d+$/.test(v));
        else if (['chain', 'causes', 'network'].includes(key) && Array.isArray(value)) safe[key] = value.slice(0, 6).map((item) => {
            const flat = { ...item }; delete flat.chain; delete flat.causes; delete flat.network;
            return metadata(flat);
        });
    }
    return safe;
}

function flush() {
    try { globalThis.localStorage?.setItem(STORAGE, JSON.stringify(entries)); storageAvailable = Boolean(globalThis.localStorage); }
    catch { storageAvailable = false; }
}

try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(STORAGE) ?? '[]');
    if (Array.isArray(stored)) entries = stored.filter((e) => e && e.level === 'error' && Object.hasOwn(labels, e.event)
        && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.at) && /^\d+\.\d+\.\d+$/.test(e.version))
        .slice(-LIMIT)
        .map((e) => ({ at: e.at, version: e.version, event: e.event,
            level: 'error', meta: metadata(e.meta) }));
} catch { storageAvailable = false; }
// Replace older multi-entry storage immediately, even if no new error occurs.
flush();

export function diagnostic(event, fields = {}, level = 'info') {
    try {
        if (level !== 'error' || !Object.hasOwn(labels, event)) return;
        entries = [{ at: new Date().toISOString(), version: DIAGNOSTIC_VERSION, event,
            level: 'error', meta: metadata(fields) }];
        flush();
        if (!notifying) {
            notifying = true;
            try { for (const fn of subscribers) { try { fn(); } catch { /* safe */ } } }
            finally { notifying = false; }
        }
    } catch { /* Best effort only. */ }
}

export function classifyDiagnosticError(error) {
    // Read only to classify; do not retain the original message or stack.
    const message = String(error?.message ?? error ?? '');
    const name = String(error?.name ?? 'Error');
    const rawHttp = Number(error?.status ?? error?.statusCode ?? error?.response?.status) || Number(message.match(/\b(400|401|403|408|413|422|429|5\d\d)\b/)?.[1]) || 0;
    const http = rawHttp >= 400 && rawHttp <= 599 ? rawHttp : 0;
    let category = '기타';
    if (http === 429 || /rate.limit|quota|요청 한도/i.test(message)) category = '요청 한도';
    else if (http >= 500 && http < 600) category = '서버 오류';
    else if ([401, 403].includes(http) || /인증|권한|api.?키|api.?key|unauthori/i.test(message)) category = '인증·권한';
    else if ([400, 413, 422].includes(http)) category = '요청 형식·크기';
    else if (http === 408 || /timeout/i.test(name) || /시간.*초과|timed? ?out/i.test(message)) category = '시간 초과';
    else if (name === 'AbortError' || /aborted|cancelled|canceled|generation.*stopped|생성.*(?:중단|취소)/i.test(message)) category = '생성 중단';
    else if (/fetch|network|연결.*실패|연결하지 못|not connected|no connection/i.test(message)) category = '연결 실패';
    else if (/json|판정.*(?:없|형식|잘못)|응답.*읽지|파싱/i.test(message)) category = 'JSON·판정 형식';
    else if (/빈 응답|비어|empty|no (?:response|reply)|응답을? 받지 못/i.test(message)) category = '빈 응답';
    else if (/storage|quotaexceeded|security/i.test(name) || /저장/i.test(message)) category = '저장소';
    else if (/대화가|채팅.*바뀌/i.test(message)) category = '대화 변경';
    else if (/충돌/.test(message)) category = '설정 충돌';
    else if (['TypeError', 'ReferenceError', 'RangeError'].includes(name)) category = '코드 실행';
    const safe = { category, errorType: enums.errorType.includes(name) ? name : '기타' };
    safe.detail = http ? 'http'
        : /no (?:response|reply)|응답을? 받지 못/i.test(message) ? 'no_response'
        : /빈 응답|비어|empty/i.test(message) ? 'empty'
        : category === '생성 중단' ? 'aborted'
        : category === '시간 초과' ? 'timeout'
        : /not connected|no connection/i.test(message) ? 'disconnected'
        : /already.*generat|generat.*in progress/i.test(message) ? 'busy'
        : category === '연결 실패' ? 'network'
        : /is not a function/i.test(message) ? 'missing_function'
        : /cannot read (?:properties|property)|is not defined/i.test(message) ? 'undefined_value'
        : /context.*(?:length|limit)|maximum.*tokens|too many tokens/i.test(message) ? 'context'
        : /safety|blocked|content.?filter/i.test(message) ? 'blocked'
        : category === 'JSON·판정 형식' ? 'invalid_json' : 'unknown';
    if (http) safe.http = http;
    const stack = String(error?.stack ?? '');
    // Keep only frame locations, never the message, URL, query, or function name.
    safe.frames = stack.split('\n').slice(1).map((line) => {
        const match = line.match(/((?:https?:\/\/|file:\/\/)[^\s)]+):(\d+):(\d+)\)?\s*$/);
        if (!match) return null;
        let url; try { url = new URL(match[1]); } catch { return null; }
        const own = files.find((file) => url.href.split('?')[0] === rootURL + file);
        const st = ({ '/script.js': 'script.js', '/scripts/openai.js': 'openai.js', '/scripts/extensions.js': 'extensions.js', '/scripts/utils.js': 'utils.js' })[url.pathname];
        const sameOrigin = url.origin === new URL(rootURL).origin;
        return `${own ? `100LOG/${own}` : st && sameOrigin ? `SillyTavern/${st}` : '외부 스크립트'}:${match[2]}:${match[3]}`;
    }).filter(Boolean).slice(0, 8);
    for (const file of files) {
        const prefix = rootURL + file + ':';
        const offset = stack.indexOf(prefix);
        if (offset < 0) continue;
        const location = stack.slice(offset + prefix.length).match(/^(\d+):(\d+)/);
        if (location) { safe.file = file; safe.line = Number(location[1]); safe.column = Number(location[2]); break; }
    }
    return safe;
}

export function diagnosticError(stage, error, fields = {}) {
    // An explicitly stopped 100LOG job is not a failure and must not replace the last error.
    if (error?.hundredlogCancelled === true) return;
    try {
        const object = error && (typeof error === 'object' || typeof error === 'function');
        const previous = object ? errorDetails.get(error) : null;
        const chain = [...(previous?.chain ?? []), metadata({ stage, ...fields })].slice(-6);
        const causes = []; let cause = error?.cause; const visited = new Set([error]);
        while (cause && !visited.has(cause) && causes.length < 4) {
            visited.add(cause); causes.push(classifyDiagnosticError(cause)); cause = cause?.cause;
        }
        const meta = { ...previous, ...fields, ...(previous?.ms !== undefined ? { ms: previous.ms } : {}), stage: previous?.stage ?? stage,
            ...classifyDiagnosticError(error), chain, causes };
        if (object) errorDetails.set(error, meta);
        // Enrich repeated catches of the same error without reviving an older error.
        const priorStamp = object ? errorRecordedAt.get(error) : null;
        if (priorStamp && (priorStamp.epoch !== clearEpoch || entries[0] !== priorStamp.entry)) return;
        diagnostic('failure', meta, 'error');
        if (object) errorRecordedAt.set(error, { entry: entries[0], epoch: clearEpoch });
    } catch { /* safe */ }
}

// Observe metadata only during our main-generation call. Do not read or clone bodies,
// change requests, retry calls, or consume response streams. Concurrent requests are
// explicitly labelled as temporal observations, not attributed to the main AI.
export async function traceGeneration(stage, action, fields = {}) {
    const original = globalThis.fetch;
    const network = []; let active = true, requests = 0;
    const epoch = clearEpoch;
    function observedFetch(...args) {
        let relevant = false;
        try {
            const url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url, globalThis.location?.href);
            relevant = active && url.origin === new URL(rootURL).origin && /^\/api\/(?:backends\/[^/]+\/generate|novelai\/generate|kobold\/generate)$/.test(url.pathname);
        } catch { /* not a recognised generation endpoint */ }
        if (!relevant) return Reflect.apply(original, this, args);
        const item = { id: ++requests }; const started = Date.now();
        network.push(item); if (network.length > 6) network.shift();
        try {
            const result = Reflect.apply(original, this, args);
            Promise.resolve(result).then((response) => { if (active) Object.assign(item, { http: response?.status, ms: Date.now() - started }); },
                (error) => { if (active) Object.assign(item, classifyDiagnosticError(error), { ms: Date.now() - started }); }).catch(() => {});
            return result;
        } catch (error) { Object.assign(item, classifyDiagnosticError(error), { ms: Date.now() - started }); throw error; }
    }
    let installed = false;
    try { if (typeof original === 'function') { globalThis.fetch = observedFetch; installed = globalThis.fetch === observedFetch; } } catch {}
    try {
        return await traceDiagnostic(stage, async () => {
            const result = await action();
            const text = String(result ?? '').trim();
            if (!text) throw new Error('메인 AI가 빈 응답을 반환했어요.');
            return text;
        }, fields);
    } catch (error) {
        if (epoch === clearEpoch) diagnosticError(stage, error, { requests, network });
        throw error;
    } finally {
        active = false;
        if (installed && globalThis.fetch === observedFetch) globalThis.fetch = original;
    }
}

export async function traceDiagnostic(stage, action, fields = {}) {
    const id = ++sequence, started = Date.now();
    diagnostic('start', { ...fields, stage, id });
    try {
        const result = await action();
        diagnostic('done', { ...fields, stage, id, ms: Date.now() - started,
            ...(typeof result === 'string' ? { chars: result.length } : {}) });
        return result;
    } catch (error) {
        diagnosticError(stage, error, { ...fields, id, ms: Date.now() - started });
        throw error;
    }
}

function routeName(input) {
    try {
        const url = new URL(String(input), globalThis.location?.href ?? rootURL);
        if (url.pathname === '/api/backends/chat-completions/generate') return '실리태번 JEV 중계';
        if (url.pathname.startsWith('/proxy/')) return '실리태번 프록시';
        if (url.hostname === 'api.typesafe.ai') return 'JEV 직접';
        if (url.hostname === 'translate.googleapis.com') return 'Google 번역';
        if (['aiplatform.googleapis.com', 'generativelanguage.googleapis.com'].includes(url.hostname)) return 'Google 임베딩';
        if (url.href.startsWith(rootURL) && url.pathname.endsWith('/settings.html')) return '설정 파일';
    } catch { /* no URL content is recorded */ }
    return '기타';
}

export async function diagnosticFetch(input, options) {
    const route = routeName(input), id = ++sequence, started = Date.now();
    diagnostic('request', { route, id });
    try {
        const response = await globalThis.fetch(input, options);
        if (options?.signal?.reason?.hundredlogCancelled === true) throw Object.assign(new Error('Stopped'), { hundredlogCancelled: true });
        diagnostic('response', { route, id, http: response.status, ms: Date.now() - started }, response.ok ? 'info' : 'error');
        return response;
    } catch (error) {
        if (options?.signal?.reason?.hundredlogCancelled === true) throw Object.assign(new Error('Stopped'), { hundredlogCancelled: true });
        diagnosticError('기타', error, { route, id, ms: Date.now() - started });
        throw error;
    }
}

export function diagnosticReport(snapshot = {}) {
    const lines = entries.map((e) => `${e.at} v${e.version} [오류] ${labels[e.event]} ${JSON.stringify(e.meta)}`);
    return [`100LOG v${DIAGNOSTIC_VERSION} 마지막 오류`, '시각: UTC · 본문/규칙 내용/인물명/키/원본 오류 메시지 미포함',
        '100LOG에서 관찰한 기록입니다. 서버 내부·다른 확장 오류 전체를 보장하지 않습니다.',
        `마지막 오류 ${entries.length}건 · 새로고침 후 보관 ${storageAvailable ? '가능' : '불가'}`,
        ...(entries.length ? [] : ['기록된 오류가 없어요.']),
        `현재 상태 ${JSON.stringify(metadata(snapshot))}`, ...lines,
        ...entries.flatMap((e) => {
            const m = e.meta;
            return [
                `실패 단계: ${m.stage ?? '확인되지 않음'}`,
                `원인 분류: ${m.category ?? '확인되지 않음'} · ${reasonLabels[m.detail] ?? '이전 버전 기록이라 세부 정보가 없습니다.'}`,
                `소요 시간: ${Number.isFinite(m.ms) ? `${m.ms}ms` : '확인되지 않음'} · 오류 HTTP 코드: ${m.http ?? '확인되지 않음'}`,
                ...(m.frames?.length ? ['호출 위치:', ...m.frames.map((f) => `  ${f}`)] : []),
                ...(m.chain?.length ? ['오류 전달 경로:', ...m.chain.map((c) => `  ${c.stage ?? '기타'}${c.site ? ` · index.js:${c.site}` : ''}${c.ms !== undefined ? ` · ${c.ms}ms` : ''}`)] : []),
                ...(m.network ? [`생성 중 관찰한 요청: ${m.requests ?? m.network.length}건 (최근 최대 6건 · 동시 실행된 다른 요청이 포함될 수 있음)`,
                    ...m.network.map((n) => `  요청 ${n.id} · HTTP ${n.http ?? '응답 코드 없음'} · ${n.ms ?? '?'}ms${n.category ? ` · ${n.category}` : ''}`),
                    'HTTP 200이어도 정상 답변을 보장하지 않습니다. 요청·응답 본문은 읽거나 기록하지 않습니다.'] : []),
            ];
        })].join('\n');
}

export function clearDiagnostics() { clearEpoch++; entries = []; flush(); for (const fn of subscribers) { try { fn(); } catch {} } }
export function subscribeDiagnostics(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

function isOwnError(error, filename = '') {
    return String(filename).startsWith(rootURL) || String(error?.stack ?? '').includes(rootURL);
}
if (globalThis.addEventListener) {
    globalThis.addEventListener('error', (event) => {
        if (isOwnError(event.error, event.filename)) diagnosticError('미처리', event.error ?? new Error('Script error'), {
            line: Number(event.lineno), column: Number(event.colno) });
    });
    globalThis.addEventListener('unhandledrejection', (event) => {
        if (isOwnError(event.reason)) diagnosticError('미처리', event.reason);
    });
    globalThis.addEventListener('pagehide', flush);
}
