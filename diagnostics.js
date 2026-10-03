// Diagnostics contain fixed labels and allowlisted metadata only. Never serialize payloads/errors.
export const DIAGNOSTIC_VERSION = '1.8.7';
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
    stage: stages,
    route: ['실리태번 JEV 중계', 'JEV 직접', '실리태번 프록시', 'Google 번역', 'Google 임베딩', '설정 파일', '기타'],
    mode: ['normal', 'swipe', 'regenerate', 'regen', 'retry', 'quiet', 'impersonate', 'continue', '기타'],
    event: ['CHAT_CHANGED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'APP_READY'],
    reason: ['비활성', '규칙 없음', '키 없음', '작업 중', '지원하지 않는 생성', '기타'],
    category: ['요청 한도', '서버 오류', '인증·권한', '요청 형식·크기', '시간 초과', '연결 실패', 'JSON·판정 형식', '빈 응답', '저장소', '대화 변경', '설정 충돌', '기타'],
    errorType: ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'TimeoutError', 'AbortError', 'QuotaExceededError', 'SecurityError', '기타'],
};
const numeric = new Set(['http', 'ms', 'attempt', 'waitMs', 'questions', 'rules', 'chars', 'count', 'site', 'line', 'column', 'id']);
const boolean = new Set(['busy', 'extracting', 'translating', 'enabled', 'hasKey', 'retryable', 'dryRun', 'profile', 'pending']);
const files = ['index.js', 'core.js', 'memory-engine.js', 'diagnostics.js'];
let entries = [];
let subscribers = new Set();
let storageAvailable = true;
let sequence = 0;
let notifying = false;
const rootURL = new URL('./', import.meta.url).href;

function metadata(input = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(input)) {
        if (numeric.has(key) && Number.isFinite(value)) safe[key] = Math.max(0, Math.round(value));
        else if (boolean.has(key) && typeof value === 'boolean') safe[key] = value;
        else if (enums[key]) safe[key] = enums[key].includes(value) ? value : '기타';
        else if (key === 'file' && files.includes(value)) safe.file = value;
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
    const http = Number(error?.status ?? error?.statusCode) || Number(message.match(/\b(400|401|403|408|413|422|429|5\d\d)\b/)?.[1]) || 0;
    let category = '기타';
    if (http === 429 || /rate.limit|quota|요청 한도/i.test(message)) category = '요청 한도';
    else if (http >= 500 && http < 600) category = '서버 오류';
    else if ([401, 403].includes(http) || /인증|권한|api.?키|api.?key|unauthori/i.test(message)) category = '인증·권한';
    else if ([400, 413, 422].includes(http)) category = '요청 형식·크기';
    else if (/timeout/i.test(name) || /시간.*초과|timed? ?out/i.test(message)) category = '시간 초과';
    else if (/fetch|network|연결.*실패|연결하지 못/i.test(message)) category = '연결 실패';
    else if (/json|판정.*(?:없|형식|잘못)|응답.*읽지|파싱/i.test(message)) category = 'JSON·판정 형식';
    else if (/빈 응답|비어|empty/i.test(message)) category = '빈 응답';
    else if (/storage|quotaexceeded|security/i.test(name) || /저장/i.test(message)) category = '저장소';
    else if (/대화가|채팅.*바뀌/i.test(message)) category = '대화 변경';
    else if (/충돌/.test(message)) category = '설정 충돌';
    const safe = { category, errorType: enums.errorType.includes(name) ? name : '기타' };
    if (http) safe.http = http;
    const stack = String(error?.stack ?? '');
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
    try { diagnostic('failure', { ...fields, stage, ...classifyDiagnosticError(error) }, 'error'); } catch { /* safe */ }
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
        diagnostic('response', { route, id, http: response.status, ms: Date.now() - started }, response.ok ? 'info' : 'error');
        return response;
    } catch (error) {
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
        `현재 상태 ${JSON.stringify(metadata(snapshot))}`, ...lines].join('\n');
}

export function clearDiagnostics() { entries = []; flush(); for (const fn of subscribers) { try { fn(); } catch {} } }
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
