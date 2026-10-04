import {messageSignature} from '../memory-engine.js';
import * as continuity from '../continuity-tools.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../core.js', import.meta.url), 'utf8').replace(/^export /gm, '').replace(/^import .*;$/gm, '');
const requestCode = source.slice(source.indexOf('function jevRequestError('), source.indexOf('function positiveInteger('));
const cancelCode = source.slice(source.indexOf('function reviewCancelledError('), source.indexOf('const generateUtility ='));
const hiddenCode = source.slice(source.indexOf('async function runHidden('), source.indexOf('globalThis.hundredlogGenerationInterceptor'));
const judgeCode = source.slice(source.indexOf('async function judge('), source.indexOf('async function ensureFactEmbeddings('));
const questions = { q0: { type: 'choice', criteria: { no_conflict: '', contradiction: '' } } };
const answer = (choice = 'no_conflict') => ({ answers: { q0: { type: 'choice', choice, confidence: 0.99 } } });
const reply = (code = 200, body = answer(), retryAfter) => ({
    status: code, ok: code >= 200 && code < 300,
    headers: { get: () => retryAfter ?? null }, json: async () => body,
});

test('report records passed result only after publishing', async () => {
 const h=harness(()=>reply()); await h.run();
 assert.equal(h.sandbox.data().chatState.lastReview.status,'passed');
 assert.equal(h.sandbox.data().chatState.lastReview.published,true);
 assert.equal(h.sandbox.data().chatState.lastReview.checked,1);
});
test('report distinguishes correction, remaining conflicts, and transport failures', async () => {
 const corrected=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));
 await corrected.run(); const report=corrected.sandbox.data().chatState.lastReview;
 assert.equal(report.status,'corrected'); assert.equal(report.issues.length,1); assert.equal(report.rewriteRequested,true);
 assert.equal(report.issues[0].rule,'A plan was made.'); assert.ok(!JSON.stringify(report).includes('A'.repeat(500)));
 const blocked=harness(()=>reply(200,answer('contradiction'))); await blocked.run();
 assert.equal(blocked.sandbox.data().chatState.lastReview.status,'conflicts_remaining'); assert.equal(blocked.published.length,1);
 const failed=harness(()=>reply(401)); await failed.run();
 assert.equal(failed.sandbox.data().chatState.lastReview.status,'review_skipped');
});
test('uncertain JEV result is not reported as an unequivocal pass', async () => {
 const h=harness(()=>reply(200,answer('unclear'))); await h.run();
 assert.equal(h.sandbox.data().chatState.lastReview.uncertain,1);
});
test('publish failure is not mislabeled as an unpublished rejected draft', async () => {
 const h=harness(()=>reply()); h.sandbox.commitReply=async()=>{throw new Error('save failed')};
 await h.run(); assert.equal(h.sandbox.data().chatState.lastReview.status,'publish_error');
});

function harness(handler) {
    const requests = [], timers = new Map(), sleeps = [], notices = [], errors = [], statuses = [], published = [];
    let sequence = 0, generationCount = 0;
    const ctx = { chat: [], chatId: 'chat-a', getRequestHeaders: () => ({ test: 'header' }), name2: 'Speaker',
        generateQuietPrompt: async () => { generationCount++; return 'A'.repeat(25000) + 'END'; }, saveSettingsDebounced() {} };
    const store = { facts: [{ id: 'fact', text: 'A plan was made.', active: true, knowledge: {} }] };
    const sandbox = { ...continuity, messageSignature,
        sourceChatId:()=> 'chat-a', AbortController, activeCollectionJob:null, translationBackgroundSafe:false, activeReviewJob: null, apiKey: () => 'fake-key', context: () => ctx, chatKey: (c) => c.chatId,
        traceGeneration: async (_stage, action) => action(), chatState: (v) => (v.chatState ??= {}), renderReviewReport() {}, diagnostic() {}, diagnosticError() {}, traceDiagnostic: async (_stage, action) => action(),
        diagnosticFetch: (...args) => sandbox.fetch(...args),
        ST_JEV_ROUTE: '/relay', JEV_URL: 'https://example.invalid/jev', ST_STRIP: [], lastJevTransport: '',
        fetch: async (url, options) => {
            requests.push({ url, options });
            return handler(url, options, requests.length);
        },
        setTimeout(fn, ms) { const id = ++sequence; if (ms === 30000 || (ms === 60000 && sandbox.activeReviewJob)) timers.set(id, fn); else { sleeps.push(ms); queueMicrotask(fn); } return id; },
        clearTimeout(id) { timers.delete(id); },
        toastr: { info: (...args) => notices.push(args), error: (...args) => errors.push(args) },
        console: { error() {} },
        stillSameChat: (key) => ctx.chatId === key, data: () => store, isCurrent: () => true,
        recentChat: () => 'recent', memoryInjection: () => 'facts', status: (s) => statuses.push(s),
        correctionPrompt: () => 'fix',
        commitReply: async (text, key) => { assert.equal(ctx.chatId, key); published.push(text); },
        clearLegacyPrompt: async () => {}, render() {}, scheduleMemory() {}, busy: true, normalGenerating: true, memoryPending: false,
    };
    vm.createContext(sandbox);
    vm.runInContext(core + '\n' + cancelCode + '\n' + requestCode + '\n' + judgeCode + '\n' + hiddenCode, sandbox);
    // Use a predictable chat key after the original core declaration.
    sandbox.chatKey = (c) => c.chatId;
    sandbox.memoryInjection = () => 'facts';
    sandbox.correctionPrompt = () => 'fix';
    return { sandbox, requests, timers, sleeps, notices, errors, statuses, published, ctx,
        generationCount: () => generationCount, request: () => sandbox.requestJev({}, questions),
        run: (mode = 'normal') => sandbox.runHidden('chat-a', {}, null, mode) };
}

for (const code of [408, 429, 500, 502, 503, 504]) {
    test(`${code} retries same request then succeeds`, async () => {
        const h = harness((_url, _options, n) => reply(n === 1 ? code : 200));
        await h.request();
        assert.equal(h.requests.length, 2);
        assert.deepEqual(h.sleeps, [2000]);
        assert.equal(h.requests[0].options.body, h.requests[1].options.body);
        assert.equal(h.timers.size, 0);
    });
}

test('429 Retry-After takes precedence', async () => {
    const h = harness((_u, _o, n) => reply(n === 1 ? 429 : 200, answer(), '10'));
    await h.request();
    assert.deepEqual(h.sleeps, [10000]);
});

test('long Retry-After is split without shortening the wait', async () => {
    const h = harness((_u, _o, n) => reply(n === 1 ? 503 : 200, answer(), '125'));
    await h.request();
    assert.deepEqual(h.sleeps, [60000, 60000, 5000]);
});

for (const code of [400, 401, 403, 413, 422]) {
    test(`${code} does not retry or switch transport`, async () => {
        const h = harness(() => reply(code));
        await assert.rejects(h.request(), new RegExp(String(code)));
        assert.equal(h.requests.length, 1);
        assert.equal(h.timers.size, 0);
    });
}

test('HTTP 200 upstream rate-limit error retries without exposing the body', async () => {
    const h = harness((_u, _o, n) => reply(200, n === 1 ? { error: { code: 429, message: 'secret' } } : answer()));
    await h.request();
    assert.equal(h.requests.length, 2);
});

test('HTTP 200 upstream authentication error does not retry', async () => {
    const h = harness(() => reply(200, { error: { message: '401 invalid api key secret' } }));
    await assert.rejects(h.request(), (e) => /인증/.test(e.message) && !e.message.includes('secret'));
    assert.equal(h.requests.length, 1);
});

test('malformed JSON and missing answer are retried', async () => {
    const h = harness((_u, _o, n) => n === 1 ? { ...reply(), json: async () => { throw Error(); } }
        : reply(200, n === 2 ? { answers: {} } : answer()));
    await h.request();
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.sleeps, [2000, 5000]);
});

test('failed JEV stops after initial attempt plus two retries', async () => {
    const h = harness(() => reply(500));
    await assert.rejects(h.request(), /자동 재시도 2회/);
    assert.equal(h.requests.length, 3);
    assert.equal(h.timers.size, 0);
});

test('relay 404 retains direct fallback', async () => {
    const h = harness((url) => reply(url === '/relay' ? 404 : 200));
    await h.request();
    assert.equal(h.requests.length, 2);
    assert.equal(h.sandbox.lastJevTransport, '직접 연결');
});

test('network failure retains proxy fallback and bounded retries', async () => {
    const h = harness(() => { throw new TypeError('network'); });
    await assert.rejects(h.request(), /자동 재시도 2회/);
    assert.equal(h.requests.length, 9); // Three transports per failed logical attempt.
    assert.equal(h.timers.size, 0);
});

for (const phase of ['headers', 'body']) {
    test(`30-second notice does not abort pending ${phase}`, async () => {
        let resolve;
        const pending = new Promise((r) => { resolve = r; });
        const h = harness(() => phase === 'headers' ? pending : { ...reply(), json: () => pending });
        const task = h.request();
        await Promise.resolve();
        assert.equal(h.timers.size, 1);
        [...h.timers.values()][0]();
        assert.deepEqual(h.notices, [['JEV 응답이 늦어지고 있습니다.', '100LOG']]);
        assert.ok(h.requests.every(({ options }) => !options.signal));
        assert.equal(h.requests.length, 1);
        resolve(phase === 'headers' ? reply() : answer());
        await task;
        assert.equal(h.timers.size, 0);
    });
}

test('changing chat stops retries', async () => {
    const h = harness(() => { h.ctx.chatId = 'chat-b'; return reply(503); });
    await assert.rejects(h.request(), /대화가 바뀌어/);
    assert.equal(h.requests.length, 1);
});

for (const mode of ['normal', 'swipe', 'regenerate']) {
    test(`${mode}: 25,003-character draft survives JEV retry, generated only once`, async () => {
        const h = harness((_u, _o, n) => reply(n === 1 ? 429 : 200));
        await h.run(mode);
        assert.equal(h.generationCount(), 1);
        assert.equal(h.published.length, 1);
        assert.equal(h.published[0].length, 25003);
        assert.ok(h.published[0].endsWith('END'));
        const payload = JSON.parse(JSON.parse(h.requests[1].options.body).custom_include_body);
        assert.equal(payload.state.unpublished_reply, h.published[0]);
        assert.equal(h.errors.length, 0);
    });
}

test('rewritten answer is rechecked; retry does not generate another rewrite', async () => {
    const h = harness((_u, _o, n) => n === 1 ? reply(200, answer('contradiction')) : reply(n === 2 ? 500 : 200));
    await h.run();
    assert.equal(h.generationCount(), 2);
    assert.equal(h.requests.length, 3);
    assert.equal(h.published.length, 1);
});

test('JEV exhaustion publishes the existing draft and labels incomplete review', async () => {
    const h = harness(() => reply(500));
    await h.run();
    assert.equal(h.generationCount(), 1);
    assert.equal(h.requests.length, 3);
    assert.equal(h.published.length, 1);
    assert.equal(h.errors.length, 0);
    assert.equal(h.sandbox.data().chatState.lastReview.status, 'review_skipped');
    assert.equal(h.sandbox.busy, false);
});

test('empty main response never calls JEV; error identifies main generation', async () => {
    const h = harness(() => reply());
    h.ctx.generateQuietPrompt = async () => '';
    await h.run();
    assert.equal(h.requests.length, 0);
    assert.equal(h.published.length, 0);
    assert.equal(h.errors.length, 0);
    assert.equal(h.sandbox.data().chatState.lastReview.status, 'external_error');
});

// Exercise the real stop hook and real diagnostics, including empty/partial ST returns.
const hookCode=source.slice(source.indexOf('export function installMemoryHooks('),source.indexOf('function recentChat(')).replace('export ','');
const diagnosticCode=readFileSync(new URL('../diagnostics.js', import.meta.url),'utf8').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify('https://host.invalid/extensions/100log/diagnostics.js'));
function cancellableHarness(handler=()=>reply()) {
 const h=harness(handler); const listeners=new Map(); const storage=new Map();
 Object.assign(h.sandbox,{URL,extracting:false,translating:false,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},memoryHooksInstalled:false,queueSourceMutation(){}});
 h.ctx.eventTypes={GENERATION_STOPPED:'stop'}; h.ctx.eventSource={on:(event,callback)=>listeners.set(event,callback)};
 vm.runInContext(diagnosticCode+'\n'+hookCode,h.sandbox);
 h.sandbox.installMemoryHooks(h.ctx);
 h.stop=()=>listeners.get('stop')();
 h.lastError=()=>h.sandbox.diagnosticReport();
 return h;
}
for(const mode of ['normal','swipe','regenerate']) for(const output of ['empty','partial','throw']) {
 test(`${mode}: stopped ${output} main result is not failed, reviewed or published`,async()=>{
  const h=cancellableHarness();
  h.sandbox.diagnosticError('기타',Object.assign(Error('old'),{status:401})); const before=h.lastError();
  h.ctx.generateQuietPrompt=async()=>{h.stop();if(output==='throw')throw Error('No response');return output==='empty'?'':'PARTIAL';};
  await h.run(mode);
  assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');
  assert.equal(h.errors.length,0);assert.equal(h.requests.length,0);assert.equal(h.published.length,0);
  assert.equal(h.lastError(),before);assert.equal(h.sandbox.activeReviewJob,null);assert.equal(h.sandbox.busy,false);
 });
}
for(const phase of ['headers','body']) test(`stop during JEV ${phase} suppresses retries/fallbacks/late notices and publishing`,async()=>{
 let entered;const ready=new Promise(r=>entered=r);
 const h=cancellableHarness((_url,opts)=>{
  const pending=()=>new Promise((_resolve,reject)=>{opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});entered();});
  return phase==='headers'?pending():{...reply(),json:pending};
 });
 const run=h.run();await ready;h.stop();for(const fn of h.timers.values())fn();await run;
 assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');assert.equal(h.requests.length,1);
 assert.equal(h.errors.length,0);assert.equal(h.notices.length,0);assert.equal(h.published.length,0);
 assert.match(h.lastError(),/기록된 오류가 없어요/);
});
test('stop during JEV retry backoff ends waiting and makes no extra call',async()=>{
 const h=cancellableHarness(()=>reply(429));let entered;const ready=new Promise(r=>entered=r);
 h.sandbox.setTimeout=(fn,ms)=>{if(ms===60000){h.timers.set(3,fn);return 3;}if(ms===30000){h.timers.set(1,fn);return 1;}h.timers.set(2,fn);entered();return 2;};
 const run=h.run();await ready;h.stop();await run;
 assert.equal(h.requests.length,1);assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');assert.equal(h.errors.length,0);
 assert.equal(h.timers.size,0);assert.match(h.lastError(),/429/); // Real earlier HTTP error is retained.
});
test('stop on rewrite prevents re-review and preserves no partial output',async()=>{
 const h=cancellableHarness(()=>reply(200,answer('contradiction')));let n=0;
 h.ctx.generateQuietPrompt=async()=>{if(++n===2){h.stop();return 'partial rewrite';}return 'draft';};
 await h.run();assert.equal(n,2);assert.equal(h.requests.length,1);assert.equal(h.published.length,0);
 assert.equal(h.errors.length,0);assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');
});
test('stop between interceptor and deferred draft cancels before making a request',async()=>{
 const h=cancellableHarness(); const job={controller:new AbortController(),publishing:false};
 h.sandbox.activeReviewJob=job;h.stop();await h.sandbox.runHidden('chat-a',{},null,'normal',null,job);
 assert.equal(h.generationCount(),0);assert.equal(h.requests.length,0);assert.equal(h.errors.length,0);
 assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');
});
test('an unrelated earlier stop does not cancel a future normal generation',async()=>{
 const h=cancellableHarness();h.stop();await h.run();assert.equal(h.published.length,1);
});
test('remaining contradictions and upstream errors do not toast',async()=>{
 const blocked=cancellableHarness(()=>reply(200,answer('contradiction')));await blocked.run();assert.equal(blocked.errors.length,0);
 const failed=cancellableHarness();failed.ctx.generateQuietPrompt=async()=>{throw Object.assign(Error('server'),{status:500});};
 await failed.run();assert.equal(failed.errors.length,0);assert.match(failed.lastError(),/500/);
 assert.equal(failed.sandbox.data().chatState.lastReview.status,'external_error');
});
test('interceptor handoff abort does not cancel its own hidden generation',async()=>{
 const h=cancellableHarness();h.sandbox.busy=false;
 Object.assign(h.sandbox,{settings:()=>({autoMemory:true,developerMemorySelection:false})});
 h.ctx.chat=[{is_user:true,mes:'hello'}];
 const interceptorCode=source.slice(source.indexOf('globalThis.hundredlogGenerationInterceptor'),source.indexOf('function closeWand('));
 vm.runInContext(interceptorCode,h.sandbox);
 let launch;h.sandbox.setTimeout=(fn,ms)=>{if(ms===300){launch=fn;return 10;}h.timers.set(11,fn);return 11;};
 let aborted=0;
 await h.sandbox.hundredlogGenerationInterceptor([],1000,()=>{aborted++;},'normal');
 assert.equal(aborted,1);assert.ok(launch);assert.equal(h.sandbox.activeReviewJob.controller.signal.aborted,false);
 // Invoke the deferred handoff using the job actually created by the interceptor.
 await h.sandbox.runHidden('chat-a',h.ctx.chat.at(-1),null,'normal',null,h.sandbox.activeReviewJob);
 assert.equal(h.published.length,1);assert.equal(h.errors.length,0);
});

for (const mode of ['normal','swipe','regenerate']) test(`${mode}: original context stays out of both draft and rewrite JEV requests`,async()=>{
 const h=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));
 h.ctx.chat=[{mes:'RAW_HISTORY_SENTINEL',name:'Speaker',is_user:false},{mes:'RAW_USER_SENTINEL',is_user:true}];
 const f=h.sandbox.data().facts[0];
 Object.assign(f,{sourceText:'RAW_QUOTE_SENTINEL',supportingEvidence:[{sourceId:0,sourceChatId:'other',evidence:'RAW_SUPPORT_SENTINEL',sourceChecked:true}],knowledge:{Speaker:'unknown'},knowledgeEvidence:{Speaker:{status:'unknown',evidence:'RAW_KNOWLEDGE_SENTINEL',reason:'RAW_REASON_SENTINEL'}}});
 await h.run(mode);assert.equal(h.requests.length,2);assert.equal(h.published.length,1);
 for(const r of h.requests){
  assert.doesNotMatch(r.options.body,/RAW_\w+_SENTINEL|source_messages|recent_chat|knowledge_evidence|supporting_evidence/);
  const state=JSON.parse(JSON.parse(r.options.body).custom_include_body).state;
  assert.equal(state.established_facts[0].text,'A plan was made.');
  assert.equal(state.established_facts[0].knowledge.Speaker,'unknown');
  assert.equal(state.unpublished_reply.length,25003);
 }
});

for (const mode of ['normal', 'swipe', 'regenerate']) {
 test(`${mode}: remaining conflicts publish only the rewrite and retain honest report`, async()=>{
  const h=cancellableHarness(()=>reply(200,answer('contradiction')));let n=0;
  h.ctx.generateQuietPrompt=async()=>++n===1?'original draft':'rewritten reply';
  await h.run(mode);
  assert.deepEqual(h.published,['rewritten reply']);assert.equal(n,2);assert.equal(h.requests.length,2);
  const report=h.sandbox.data().chatState.lastReview;
  assert.equal(report.status,'conflicts_remaining');assert.equal(report.published,true);assert.equal(report.remaining,1);
  assert.equal(report.remainingRules[0],'A plan was made.');assert.equal(h.errors.length,0);
  assert.match(h.sandbox.data().lastActivity.text,/충돌 1개 남음/);
  assert.match(h.lastError(),/기록된 오류가 없어요/);
 });
 for (const stop of [true,false]) test(`${mode}: ${stop?'cancel':'changed chat'} during final conflicting review prevents publishing`, async()=>{
  const h=cancellableHarness((_u,_o,n)=>{if(n===2){if(stop)h.stop();else h.ctx.chatId='chat-b';}return reply(200,answer('contradiction'));});
  await h.run(mode);assert.equal(h.published.length,0);assert.equal(h.errors.length,0);
  assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');
 });
}
test('second review transport failure shows the rewrite as incomplete, not passed',async()=>{
 const h=harness((_u,_o,n)=>reply(n===1?200:500,answer('contradiction')));await h.run();
 assert.equal(h.published.length,1);assert.equal(h.errors.length,0);
 assert.equal(h.sandbox.data().chatState.lastReview.status,'review_skipped');
});

for (const mode of ['normal','swipe','regenerate']) {
 test(`${mode}: token rejection publishes draft without another main generation`,async()=>{
  const h=harness(()=>reply(400,{detail:{error_type:'max_tokens_exceeded'}}));await h.run(mode);
  assert.equal(h.requests.length,1);assert.equal(h.generationCount(),1);assert.equal(h.published.length,1);
  assert.equal(h.sandbox.data().chatState.lastReview.status,'review_skipped');assert.equal(h.errors.length,0);
 });
 for (const empty of [false,true]) test(`${mode}: failed/empty rewrite preserves original draft (${empty})`,async()=>{
  const h=harness(()=>reply(200,answer('contradiction')));let n=0;
  h.ctx.generateQuietPrompt=async()=>{if(++n===1)return 'ORIGINAL';if(empty)return '';throw Error('rewrite error');};
  await h.run(mode);assert.deepEqual(h.published,['ORIGINAL']);assert.equal(n,2);assert.equal(h.requests.length,1);
  assert.equal(h.sandbox.data().chatState.lastReview.status,'review_skipped');assert.equal(h.errors.length,0);
 });
 for (const phase of [1,2]) test(`${mode}: hanging JEV phase ${phase} times out and late result cannot publish twice`,async()=>{
  let enter,finish;const ready=new Promise(r=>enter=r);const pending=new Promise(r=>finish=r);
  const h=cancellableHarness((_u,_o,n)=>{if(n===phase){enter();return pending;}return reply(200,answer('contradiction'));});
  let n=0;h.ctx.generateQuietPrompt=async()=>++n===1?'DRAFT':'REWRITE';
  const task=h.run(mode);await ready;
  // The per-review deadline is scheduled before the 30-second slow notice.
  const deadline=[...h.timers.values()][0];deadline();await task;
  assert.deepEqual(h.published,[phase===1?'DRAFT':'REWRITE']);assert.equal(h.sandbox.busy,false);
  assert.equal(h.sandbox.data().chatState.lastReview.status,'review_skipped');assert.equal(h.errors.length,0);
  finish(reply(200,answer('contradiction')));await new Promise(r=>setImmediate(r));
  assert.equal(h.published.length,1);assert.equal(h.requests.length,phase);assert.equal(h.timers.size,0);
 });
}
for(const payload of [{detail:{error_type:'max_tokens_exceeded'}},{error:{error_type:'max_tokens_exceeded'}}])test('HTTP 200 token error does not retry',async()=>{
 const h=harness(()=>reply(200,payload));await h.run();assert.equal(h.requests.length,1);assert.equal(h.published.length,1);
});
for(const kind of ['extracting','translating'])test(`${kind}: interceptor does not abort user send`,async()=>{
 const h=cancellableHarness();h.sandbox.busy=false;h.sandbox[kind]=true;
 Object.assign(h.sandbox,{settings:()=>({autoMemory:true,developerMemorySelection:false})});h.ctx.chat=[{is_user:true,mes:'hello'}];
 vm.runInContext(source.slice(source.indexOf('globalThis.hundredlogGenerationInterceptor'),source.indexOf('function closeWand(')),h.sandbox);
 let aborted=0;await h.sandbox.hundredlogGenerationInterceptor([],1000,()=>{aborted++;},'normal');
 assert.equal(aborted,0);assert.equal(h.requests.length,0);assert.equal(h.sandbox.busy,false);
 assert.equal(h.sandbox.data().chatState.lastReview.status,'background_skipped');
});


for (const running of [false, true]) test(`pre-send hook does not await pending collection (running=${running})`, async () => {
 const h=harness(()=>reply()); const listeners=new Map(); let collectionCalls=0;
 Object.assign(h.sandbox, {memoryHooksInstalled:false, extracting:false,translating:false, settings:()=>({autoMemory:true}),
  activeCollectionJob:running?{}:null, memoryRun:new Promise(()=>{}), normalGenerating:false,
  memoryPending:true,memoryForcePending:false,sourceMutationTimer:null,queueSourceMutation(){},
  processSourceMutation:async()=>({changed:true,compacted:false}),syncMemories:()=>{collectionCalls++;return new Promise(()=>{});}});
 h.ctx.eventTypes={GENERATION_AFTER_COMMANDS:'beforeSend'};
 h.ctx.eventSource={on:(event,callback)=>listeners.set(event,callback)};
 vm.runInContext(hookCode,h.sandbox);h.sandbox.installMemoryHooks(h.ctx);
 let timer;
 try { await Promise.race([listeners.get('beforeSend')('normal',{},false),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('User input blocked by collection')),100);})]); }
 finally {clearTimeout(timer);}
 assert.equal(collectionCalls,0);assert.equal(h.sandbox.normalGenerating,true);assert.equal(h.sandbox.memoryPending,true);
});

test('memory maintenance failure cannot reject pre-send event', async () => {
 const h=harness(()=>reply());const listeners=new Map();
 Object.assign(h.sandbox,{memoryHooksInstalled:false,extracting:false,translating:false,settings:()=>({autoMemory:true}),activeCollectionJob:null,
  sourceMutationTimer:null,queueSourceMutation(){},processSourceMutation:async()=>{throw Error('maintenance failure');}});
 h.ctx.eventTypes={GENERATION_AFTER_COMMANDS:'beforeSend'};h.ctx.eventSource={on:(e,fn)=>listeners.set(e,fn)};
 vm.runInContext(hookCode,h.sandbox);h.sandbox.installMemoryHooks(h.ctx);
 await listeners.get('beforeSend')('normal',{},false);
 assert.equal(h.sandbox.normalGenerating,true);
});

test('main API utility request never overrides response length',async()=>{
 const h=harness(()=>reply());let options;
 h.ctx.generateRaw=async(args)=>{options=args;return 'collected';};
 assert.equal(await h.sandbox.generateUtility(h.ctx,'facts','',6000),'collected');
 assert.equal(options.prompt,'facts');assert.equal(Object.hasOwn(options,'responseLength'),false);
});

test('separate profile keeps its own request budget',async()=>{
 const h=harness(()=>reply());let args;
 h.ctx.ConnectionManagerRequestService={getSupportedProfiles:()=>[{id:'collector'}],sendRequest:async(...a)=>{args=a;return 'collected';}};
 await h.sandbox.generateUtility(h.ctx,'facts','collector',6000);
 assert.equal(args[2],6000);
});

for(const kind of ['extracting','translating']) test(`${kind}: isolated background work still permits hidden draft and JEV`,async()=>{
 const h=cancellableHarness();h.sandbox.busy=false;h.sandbox[kind]=true;
 Object.assign(h.sandbox,{settings:()=>({autoMemory:true,developerMemorySelection:false}),
  activeCollectionJob:{backgroundSafe:true},translationBackgroundSafe:true});
 h.ctx.chat=[{is_user:true,mes:'hello'}];
 vm.runInContext(source.slice(source.indexOf('globalThis.hundredlogGenerationInterceptor'),source.indexOf('function closeWand(')),h.sandbox);
 let handoff;
 h.sandbox.setTimeout=(fn,ms)=>{if(ms===300){handoff=fn;return 1000;} return 1001;};
 let aborted=0;await h.sandbox.hundredlogGenerationInterceptor([],1000,()=>aborted++,'normal');
 assert.equal(aborted,1);assert.equal(typeof handoff,'function'); // replaces normal generation, does not abandon it
 await h.sandbox.runHidden('chat-a',h.ctx.chat[0],null,'normal',null,h.sandbox.activeReviewJob);
 assert.equal(h.generationCount(),1);assert.equal(h.requests.length,1);assert.equal(h.published.length,1);
 assert.equal(h.sandbox.data().chatState.lastReview.status,'passed');
});

test('collection changing nested stored knowledge during draft cannot change this reply baseline',async()=>{
 const h=harness(()=>reply()); const f=h.sandbox.data().facts[0];f.kind='commitment';f.knowledge={Speaker:'unknown'};f.commitment={status:'planned'};
 h.ctx.generateQuietPrompt=async()=>{f.text='Changed during background collection';f.knowledge.Speaker='known';f.commitment.status='resolved';return 'reply';};
 await h.run();const payload=JSON.parse(h.requests[0].options.body).custom_include_body;
 const remembered=JSON.parse(payload).state.established_facts[0];
 assert.equal(remembered.text,'A plan was made.');assert.equal(remembered.knowledge.Speaker,'unknown');assert.equal(remembered.progress,'planned');
});

test('main background utility uses isolated payload/service and dedicated abort signal',async()=>{
 const h=harness(()=>reply()); const signal=new AbortController().signal;let payloadOptions,request;
 h.ctx.mainApi='openai';h.ctx.getChatCompletionModel=()=> 'user-model';
 h.ctx.chatCompletionSettings=Object.freeze({openai_max_tokens:12345});
 h.ctx.generateRaw=()=>{throw Error('must not use shared generation lifecycle');};
 h.ctx.ChatCompletionService={presetToGeneratePayload:async(preset,overrides,opts)=>{
  payloadOptions=opts;return {...opts,max_tokens:h.ctx.chatCompletionSettings.openai_max_tokens};
 },sendRequest:async(...args)=>{request=args;return {content:'facts'};}};
 assert.equal(await h.sandbox.generateUtility(h.ctx,'collect','',6000,signal),'facts');
 assert.equal(payloadOptions.model,'user-model');assert.equal(Object.hasOwn(payloadOptions,'max_tokens'),false);
 assert.equal(request[0].max_tokens,12345);assert.equal(request[0].stream,false);assert.equal(request[2],signal);
 assert.equal(h.ctx.chatCompletionSettings.openai_max_tokens,12345);
});

test('aborted background utility cannot send after payload preparation',async()=>{
 const h=harness(()=>reply());const control=new AbortController();let sent=0;
 h.ctx.mainApi='openai';h.ctx.getChatCompletionModel=()=> 'model';
 h.ctx.ChatCompletionService={presetToGeneratePayload:async()=>{control.abort(Error('stopped'));return {};},sendRequest:async()=>{sent++;}};
 await assert.rejects(h.sandbox.generateUtility(h.ctx,'facts','',6000,control.signal),/stopped/);assert.equal(sent,0);
});

const schedulingCode=source.slice(source.indexOf('function scheduleMemory('),source.indexOf('function applyDetectedSummaryCompaction(')).replace('export ', '');
function backgroundScheduler(){
 const timers=[];const box={memoryPending:false,memoryForcePending:false,memoryRun:null,memoryTimer:null,extracting:false,translating:false,busy:true,normalGenerating:true,
  settings:()=>({autoMemory:true,extractionProfileId:'collector'}),context:()=>({}),chatKey:()=> 'chat',memoryDue:()=>true,render(){},supportsBackgroundUtility:()=>true,
  setTimeout:(fn)=>{timers.push(fn);return timers.length;},clearTimeout(){}};
 vm.createContext(box);vm.runInContext(schedulingCode,box);return {box,timers};
}
test('background scheduler starts during reply generation, and prevents duplicate collectors',async()=>{
 const {box,timers}=backgroundScheduler();let finish,calls=0;
 box.performMemorySync=()=>{calls++;box.extracting=true;return new Promise(r=>finish=r);};
 box.scheduleMemory();timers.shift()();assert.equal(calls,1);
 const run=box.memoryRun;box.scheduleMemory();assert.equal(timers.length,0);assert.equal(box.memoryPending,true);
 assert.equal(box.syncMemories(),run);assert.equal(calls,1);
 box.extracting=false;finish();await run;await Promise.resolve();assert.equal(timers.length,1);
});
test('legacy nonisolated utility does not start alongside reply generation',()=>{
 const {box,timers}=backgroundScheduler();box.supportsBackgroundUtility=()=>false;
 let called=0;box.performMemorySync=()=>{called++;return Promise.resolve();};
 box.scheduleMemory();timers.shift()();assert.equal(called,0);assert.equal(box.memoryPending,true);
});

test('collection stop aborts only its own request, not the reply review',()=>{
 const h=harness(()=>reply());h.sandbox.activeCollectionJob={controller:new AbortController()};h.sandbox.activeReviewJob={controller:new AbortController()};
 Object.assign(h.sandbox,{stopExtractionRequested:false,memoryTimer:null,memoryForcePending:true});
 vm.runInContext(source.slice(source.indexOf('function stopCollection('),source.indexOf('function refreshDiagnosticPanel(')),h.sandbox);
 h.sandbox.stopCollection();assert.equal(h.sandbox.activeCollectionJob.controller.signal.aborted,true);assert.equal(h.sandbox.activeReviewJob.controller.signal.aborted,false);
});

test('reply stop leaves independent collection running',()=>{
 const h=cancellableHarness();h.sandbox.activeCollectionJob={controller:new AbortController()};h.sandbox.activeReviewJob={controller:new AbortController()};
 h.stop();assert.equal(h.sandbox.activeReviewJob.controller.signal.aborted,true);assert.equal(h.sandbox.activeCollectionJob.controller.signal.aborted,false);
});

test('review status never overwrites collection progress',()=>{
 const box={busy:true,statusText:'',collectionStatusText:'',refreshCollectionStatus(){},$id:()=>null};vm.createContext(box);
 vm.runInContext(source.slice(source.indexOf('function status('),source.indexOf('function setDeveloperUnlocked(')),box);
 box.setCollectionStatus('collection 3/6');box.status('reviewing reply');assert.equal(box.collectionStatusText,'collection 3/6');
 box.setCollectionStatus('collection 6/6');assert.equal(box.statusText,'reviewing reply');
});
