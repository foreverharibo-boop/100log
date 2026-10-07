import { createNativeReview } from '../native-review.js';
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
const hiddenCode = source.slice(source.indexOf('async function applyReviewedReply('), source.indexOf('globalThis.hundredlogGenerationInterceptor'));
const judgeCode = source.slice(source.indexOf('async function judge('), source.indexOf('async function ensureFactEmbeddings('));
const questions = { q0: { type: 'choice', criteria: { no_conflict: '', contradiction: '' } } };
const answer = (choice = 'no_conflict') => ({ answers: { q0: { type: 'choice', choice, confidence: 0.99 } } });
const reply = (code = 200, body = answer(), retryAfter) => ({
    status: code, ok: code >= 200 && code < 300,
    headers: { get: () => retryAfter ?? null }, json: async () => body,
});

// Set DIE429_TEST_MODULE to an absolute managed-retry.js path to additionally
// exercise the real companion extension. The default stub tests the API contract.
const companion = process.env.DIE429_TEST_MODULE ? await import(process.env.DIE429_TEST_MODULE) : null;
function installRetryBridge(h, { maxRetries = 2, setTimer } = {}) {
    const calls = [], config = { enabled: true, catchMode: 'safe', maxRetries };
    const classify = companion?.classifyManagedError ?? (e => ({ retryable: e.name === 'TimeoutError' || e.retryable || /429|500/.test(e.message) }));
    const api = companion ? companion.createManagedRetry({ getSettings: () => config, classify,
        setTimer: setTimer ?? ((fn) => { queueMicrotask(fn); return 1; }), clearTimer() {} }) : {
        apiVersion: 1, isEnabled: () => config.enabled,
        async run({ action, validate, signal }) {
            for (let count = 0; ; count++) {
                validate(); if (signal.aborted) throw Object.assign(Error(), { name: 'AbortError' });
                try { const result = await action(); validate(); return result; }
                catch (e) { if (e.name === 'AbortError' || !classify(e).retryable || count >= maxRetries) throw e; }
            }
        },
    };
    h.sandbox.die429Retry = { apiVersion: 1, isEnabled: api.isEnabled,
        run(options) { calls.push(options.stage); return api.run(options); } };
    return { api, calls, config };
}


const hookCode=source.slice(source.indexOf('export function installMemoryHooks('),source.indexOf('function recentChat(')).replace('export ','');
const interceptorCode=source.slice(source.indexOf('globalThis.hundredlogGenerationInterceptor'),source.indexOf('function closeWand('));
function harness(handler) {
    const requests=[], timers=new Map(), sleeps=[], notices=[], errors=[], statuses=[], published=[], masks=new Set(), injections=[];
    let sequence=0, generationCount=0, aborted=0;
    const listeners=new Map();
    const events={MESSAGE_RECEIVED:'received',GENERATION_ENDED:'ended',GENERATION_STOPPED:'stop',CHARACTER_MESSAGE_RENDERED:'rendered'};
    const eventSource={on(e,fn){const list=listeners.get(e)??[];list.push(fn);listeners.set(e,list);},
        makeFirst(e,fn){const list=listeners.get(e);list.splice(list.indexOf(fn),1);list.unshift(fn);},
        async emit(e,...args){for(const fn of [...(listeners.get(e)??[])])await fn(...args);}};
    const ctx={chat:[{is_user:true,mes:'hello'}],chatId:'chat-a',getRequestHeaders:()=>({test:'header'}),name2:'Speaker',
        eventTypes:events,eventSource,updateMessageBlock(){},getTokenCountAsync:async()=>42,
        setExtensionPrompt:(...args)=>injections.push(args),
        generateQuietPrompt:async()=>{generationCount++;return 'CORRECTED';},saveSettingsDebounced(){}};
    const store={facts:[{id:'fact',text:'A plan was made.',active:true,knowledge:{}}]};
    const sandbox={...continuity,messageSignature,AbortController,structuredClone,URL,
        sourceChatId:()=> 'chat-a',activeCollectionJob:null,translationBackgroundSafe:false,activeReviewJob:null,nativeReview:null,
        memoryHooksInstalled:false,extracting:false,translating:false,apiKey:()=> 'fake-key',context:()=>ctx,chatKey:c=>c.chatId,
        settings:()=>({autoMemory:true}),queueSourceMutation(){},
        traceGeneration:async(_stage,action)=>{const result=await action();if(!result?.trim())throw Error('빈 응답');return result;},
        chatState:v=>(v.chatState??={}),renderReviewReport(){},diagnostic(){},diagnosticError(){},traceDiagnostic:async(_s,a)=>a(),
        diagnosticFetch:(...args)=>sandbox.fetch(...args),ST_JEV_ROUTE:'/relay',JEV_URL:'https://example.invalid/jev',ST_STRIP:[],lastJevTransport:'',
        fetch:async(url,options)=>{requests.push({url,options});return handler(url,options,requests.length);},
        setTimeout(fn,ms){const id=++sequence;if(ms===0||ms===30000||(ms===60000&&sandbox.activeReviewJob))timers.set(id,fn);else{sleeps.push(ms);queueMicrotask(fn);}return id;},
        clearTimeout(id){timers.delete(id);},toastr:{info:(...a)=>notices.push(a),error:(...a)=>errors.push(a)},console:{error(){}},
        data:()=>store,isCurrent:()=>true,recentChat:()=> 'recent',memoryInjection:()=> 'facts',status:s=>statuses.push(s),
        correctionPrompt:(draft)=>`fix ${draft}`,clearLegacyPrompt:async()=>ctx.setExtensionPrompt('100log-context','',1,0,false,0),
        render(){},scheduleMemory(){},busy:false,normalGenerating:false,memoryPending:false,
    };
    sandbox.createNativeReview=options=>createNativeReview({...options,setTimer:sandbox.setTimeout,
        mask:index=>{masks.add(index);return ()=>masks.delete(index);}});
    vm.createContext(sandbox);
    vm.runInContext(core+'\n'+cancelCode+'\n'+requestCode+'\n'+judgeCode+'\n'+hiddenCode+'\n'+hookCode+'\n'+interceptorCode,sandbox);
    sandbox.chatKey=c=>c.chatId;sandbox.memoryInjection=()=> 'facts';sandbox.correctionPrompt=draft=>`fix ${draft}`;
    sandbox.installMemoryHooks(ctx);
    const prepare=async(mode='normal')=>{
        if(mode==='swipe'&&ctx.chat.at(-1)?.is_user)ctx.chat.push({is_user:false,mes:'OLD',swipes:['OLD'],swipe_id:0,swipe_info:[{extra:{}}]});
        await sandbox.hundredlogGenerationInterceptor([],1000,()=>aborted++,mode);
    };
    const deliver=async(text='A'.repeat(25000)+'END',mode='normal',streaming=false)=>{
        let message;
        if(mode==='swipe'){
            message=ctx.chat.at(-1);message.swipe_id=message.swipes.length;message.swipes.push(text);message.swipe_info.push({extra:{}});message.mes=text;
        }else{message={is_user:false,name:'Speaker',mes:text,extra:{api:'native',model:'user-model',token_count:123},gen_started:'start',gen_finished:'end',send_date:'date'};ctx.chat.push(message);}
        const index=ctx.chat.length-1;
        if(streaming){message.swipe_id??=0;message.swipes??=[text];message.swipe_info??=[{extra:{...message.extra}}];ctx.streamingProcessor={isFinished:true,abortController:new AbortController()};void eventSource.emit(events.GENERATION_ENDED,index);}
        await eventSource.emit(events.MESSAGE_RECEIVED,index,mode);
        // Native saveReply/render resumes after the awaited hook.
        message.swipe_id??=0;message.swipes??=[];message.swipes[message.swipe_id]=message.mes;
        published.push(message.mes);await eventSource.emit(events.CHARACTER_MESSAGE_RENDERED,index,mode);
        return message;
    };
    return {sandbox,requests,timers,sleeps,notices,errors,statuses,published,ctx,masks,injections,
        generationCount:()=>generationCount,aborted:()=>aborted,request:()=>sandbox.requestJev({},questions),prepare,deliver,
        run:async(mode='normal')=>{await prepare(mode);return deliver(undefined,mode);},stop:()=>eventSource.emit(events.GENERATION_STOPPED)};
}
function cancellableHarness(handler=()=>reply()){return harness(handler);}

for (const mode of ['normal', 'swipe', 'regenerate']) for (const streaming of [false, true]) {
    test(`${mode}, streaming=${streaming}: inject facts, inspect native reply, preserve passed text/metadata`, async () => {
        const h=harness(()=>reply()); await h.prepare(mode);
        assert.equal(h.aborted(),0); assert.equal(h.generationCount(),0); assert.equal(h.requests.length,0);
        const injection=h.injections.find(args=>args[1]==='facts'); assert.deepEqual(injection.slice(2),[1,0,false,0]);
        assert.equal(h.masks.size,1);
        const text='  NATIVE reply\nexact formatting  ';
        const message=await h.deliver(text,mode,streaming);
        assert.equal(h.generationCount(),0); assert.equal(h.requests.length,1); assert.equal(message.mes,text);
        assert.equal(h.ctx.chat.length,2); assert.equal(message.swipes[message.swipe_id],text); assert.equal(h.masks.size,0);
        if(mode!=='swipe'){assert.equal(message.extra.token_count,123);assert.equal(message.gen_started,'start');assert.equal(message.extra.model,'user-model');}
        assert.equal(h.sandbox.data().chatState.lastReview.status,'passed');
    });
    test(`${mode}, streaming=${streaming}: only a detected conflict requests a rewrite`, async () => {
        const h=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));
        await h.prepare(mode); const message=await h.deliver('NATIVE',mode,streaming);
        assert.equal(h.generationCount(),1); assert.equal(h.requests.length,2); assert.equal(message.mes,'CORRECTED');
        assert.equal(h.ctx.chat.length,2); assert.equal(message.swipes[message.swipe_id],'CORRECTED');
        if(mode==='swipe'){assert.equal(message.swipes.length,2);assert.equal(message.swipes[0],'OLD');}
        else {assert.equal(message.extra.model,'user-model');assert.equal(message.extra.token_count,42);assert.equal(message.gen_started,'start');}
        assert.equal(h.sandbox.data().chatState.lastReview.status,'corrected'); assert.equal(h.masks.size,0);
    });
}
test('100LOG never calls generateQuietPrompt before receiving a native reply', async () => {
    const h=harness(()=>reply()); h.ctx.generateQuietPrompt=()=>{throw Error('must not generate');};
    await h.prepare(); assert.equal(h.aborted(),0); assert.equal(h.requests.length,0);
    await h.deliver(); assert.equal(h.requests.length,1);
});
test('stop while selecting facts aborts the pending native request instead of resuming it',async()=>{
    const h=harness(()=>reply());h.sandbox.settings=()=>({autoMemory:true,developerMemorySelection:true});
    h.sandbox.embeddingKey=()=> 'key';h.sandbox.selectInjectionFactsByEmbedding=async()=>{await h.stop();return {selected:[],candidateCount:0};};
    await h.prepare();assert.equal(h.aborted(),1);assert.equal(h.requests.length,0);assert.equal(h.generationCount(),0);assert.equal(h.masks.size,0);
});
test('stop releases a hung rewrite without accepting its late result',async()=>{
    let finish,entered;const ready=new Promise(r=>entered=r);const h=harness(()=>reply(200,answer('contradiction')));
    h.ctx.generateQuietPrompt=()=>new Promise(resolve=>{finish=resolve;entered();});
    const task=h.run();await ready;await h.stop();const message=await task;
    assert.equal(message.mes.length,25003);finish('LATE');await Promise.resolve();assert.equal(message.mes.length,25003);assert.equal(h.masks.size,0);
});
test('native generation failure has no fabricated reply or JEV request', async () => {
    const h=harness(()=>reply()); await h.prepare(); await h.ctx.eventSource.emit('ended',h.ctx.chat.length);
    for(const fn of [...h.timers.values()])fn();
    assert.equal(h.requests.length,0);assert.equal(h.generationCount(),0);assert.equal(h.ctx.chat.length,1);assert.equal(h.masks.size,0);
    assert.equal(h.sandbox.nativeReview.current(),null);assert.equal(h.sandbox.busy,false);
});
test('native receive listener runs before downstream translation/other observers', async () => {
    const h=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));let seen;
    h.ctx.eventSource.on('received',i=>seen=h.ctx.chat[i].mes);
    await h.run();assert.equal(seen,'CORRECTED');
});
test('stream remains masked through JEV wait and redraws correction before unmask', async () => {
    let resolve,entered;const ready=new Promise(r=>entered=r);
    const h=harness((_u,_o,n)=>n===1?new Promise(r=>{resolve=r;entered();}):reply());
    h.ctx.updateMessageBlock=(_index,message)=>{assert.equal(h.masks.size,1);assert.equal(message.mes,'CORRECTED');};
    await h.prepare();const task=h.deliver('native','normal',true);await ready;
    assert.equal(h.masks.size,1);for(const fn of [...h.timers.values()].slice(0,1))fn();assert.equal(h.masks.size,1);
    resolve(reply(200,answer('contradiction')));await task;assert.equal(h.masks.size,0);
});
test('429die JEV retries the same received answer with no extra main generation', async () => {
    const h=harness((_u,_o,n)=>reply(n===1?429:200));const bridge=installRetryBridge(h);
    const message=await h.run();assert.equal(h.requests.length,2);assert.equal(h.generationCount(),0);
    assert.deepEqual(bridge.calls,['JEV 초안 검수']);assert.deepEqual(h.sleeps,[]);
    assert.equal(h.requests[0].options.body,h.requests[1].options.body);assert.equal(message.mes.length,25003);
});
test('429die retries only a failed rewrite, then checks that rewrite', async () => {
    const h=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));const bridge=installRetryBridge(h);
    let attempts=0;h.ctx.generateQuietPrompt=async()=>{if(++attempts===1)throw Error('Got response status 500');return 'fixed';};
    const message=await h.run();assert.equal(attempts,2);assert.equal(h.requests.length,2);assert.equal(message.mes,'fixed');
    assert.deepEqual(bridge.calls,['JEV 초안 검수','메인 AI 재작성','JEV 재검수']);
});
test('429die exhausted review keeps the native reply and reports incomplete', async () => {
    const h=harness(()=>reply(429));installRetryBridge(h,{maxRetries:1});const message=await h.run();
    assert.equal(h.requests.length,2);assert.equal(h.generationCount(),0);assert.equal(message.mes.length,25003);
    assert.equal(h.sandbox.data().chatState.lastReview.reviewIncomplete,true);assert.equal(h.masks.size,0);
});
for(const result of ['throw','empty'])test(`failed rewrite (${result}) preserves native answer`,async()=>{
    const h=harness(()=>reply(200,answer('contradiction')));
    h.ctx.generateQuietPrompt=async()=>{if(result==='throw')throw Error('401');return '';};
    const message=await h.run();assert.equal(message.mes.length,25003);assert.equal(h.requests.length,1);
    assert.equal(h.sandbox.data().chatState.lastReview.reviewIncomplete,true);
});
test('remaining conflicts show the rewrite with an honest report',async()=>{
    const h=harness(()=>reply(200,answer('contradiction')));const message=await h.run();
    assert.equal(message.mes,'CORRECTED');assert.equal(h.generationCount(),1);assert.equal(h.requests.length,2);
    assert.equal(h.sandbox.data().chatState.lastReview.status,'conflicts_remaining');
});
for(const phase of ['headers','body'])test(`stop during JEV ${phase} preserves native reply and suppresses late changes`,async()=>{
    let entered;const ready=new Promise(r=>entered=r);
    const h=harness((_u,opts)=>{const pending=()=>new Promise((_r,reject)=>{opts.signal.addEventListener('abort',()=>reject(opts.signal.reason));entered();});return phase==='headers'?pending():{...reply(),json:pending};});
    await h.prepare();const task=h.deliver('NATIVE');await ready;await h.stop();const message=await task;
    assert.equal(message.mes,'NATIVE');assert.equal(h.requests.length,1);assert.equal(h.generationCount(),0);assert.equal(h.masks.size,0);
    assert.equal(h.sandbox.data().chatState.lastReview.status,'cancelled');
});
test('stop during rewrite cannot replace the received answer with a partial rewrite',async()=>{
    const h=harness(()=>reply(200,answer('contradiction')));h.ctx.generateQuietPrompt=async()=>{await h.stop();return 'PARTIAL';};
    const message=await h.run();assert.equal(message.mes.length,25003);assert.equal(h.requests.length,1);assert.equal(h.masks.size,0);
});
test('chat change or editing the target while reviewing prevents replacement',async()=>{
    for(const action of ['chat','edit','swipe']){
        const h=harness(()=>reply(200,answer('contradiction')));
        h.ctx.generateQuietPrompt=async()=>{if(action==='chat')h.ctx.chatId='chat-b';if(action==='edit')h.ctx.chat.at(-1).mes='USER EDIT';if(action==='swipe')h.ctx.chat.at(-1).swipe_id=7;return 'late';};
        const message=await h.run();assert.notEqual(message.mes,'late');assert.equal(h.masks.size,0);assert.equal(h.requests.length,1);
    }
});
test('independent collection cannot change the frozen verification baseline',async()=>{
    const h=harness(()=>reply());const fact=h.sandbox.data().facts[0];fact.kind='commitment';fact.knowledge={Speaker:'unknown'};fact.commitment={status:'planned'};
    await h.prepare();fact.text='NEW';fact.knowledge.Speaker='known';fact.commitment.status='resolved';await h.deliver();
    const payload=JSON.parse(JSON.parse(h.requests[0].options.body).custom_include_body);
    assert.equal(payload.state.established_facts[0].text,'A plan was made.');assert.equal(payload.state.established_facts[0].knowledge.Speaker,'unknown');
});
test('quiet/first-message events do not consume the pending native reply',async()=>{
    const h=harness(()=>reply());await h.prepare();
    await h.sandbox.hundredlogGenerationInterceptor([],1000,()=>{throw Error('abort');},'quiet');
    await h.ctx.eventSource.emit('received',1,'quiet');await h.ctx.eventSource.emit('received',1,'first_message');
    assert.equal(h.requests.length,0);assert.equal(h.masks.size,1);await h.deliver();assert.equal(h.requests.length,1);
});
test('aborted stream partial output is not reviewed or rewritten',async()=>{
    const h=harness(()=>reply());await h.prepare();h.ctx.streamingProcessor={isStopped:true};
    const message=await h.deliver('PARTIAL');assert.equal(message.mes,'PARTIAL');assert.equal(h.requests.length,0);assert.equal(h.masks.size,0);
});
test('rewrite clears stale display/reasoning cache without losing native model metadata',async()=>{
    const h=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));
    await h.prepare();h.ctx.chat.push({is_user:false,mes:'native',extra:{display_text:'stale translation',reasoning_signature:'stale',api:'native',model:'model'}});
    await h.ctx.eventSource.emit('received',1,'normal');const message=h.ctx.chat[1];
    assert.equal(message.mes,'CORRECTED');assert.equal(message.extra.display_text,undefined);assert.equal(message.extra.reasoning_signature,undefined);assert.equal(message.extra.model,'model');
});
test('429die: per-attempt JEV deadline retries without regenerating native text',async()=>{
    const h=harness((_u,_o,n)=>n===1?new Promise(()=>{}):reply());installRetryBridge(h);const task=h.run();
    for(let i=0;i<80&&!h.requests.length;i++)await Promise.resolve();
    [...h.timers.values()].at(-1)();const message=await task;
    assert.equal(h.requests.length,2);assert.equal(h.generationCount(),0);assert.equal(message.mes.length,25003);
});
test('429die badge stop during backoff keeps native reply and cancels retries',{skip:!companion},async()=>{
    let waiting;const h=harness(()=>reply(429));const bridge=installRetryBridge(h,{setTimer:fn=>{waiting=fn;return 1;}});const task=h.run();
    for(let i=0;i<100&&!waiting;i++)await Promise.resolve();assert.ok(waiting);bridge.api.cancelAll();const message=await task;
    assert.equal(h.requests.length,1);assert.equal(message.mes.length,25003);assert.equal(h.masks.size,0);
});

// Optional integration fixture extracted verbatim from SillyTavern's release
// script.js: saveReply and StreamingProcessor.finalizeIntermediaryMessage.
for(const mode of ['normal','swipe','regenerate'])for(const streaming of [false,true])test(
    `upstream native lifecycle: ${mode}, streaming=${streaming}`,
    {skip:!process.env.ST_NATIVE_REPLY_FIXTURE},async()=>{
        const native=JSON.parse(readFileSync(process.env.ST_NATIVE_REPLY_FIXTURE,'utf8'));
        const h=harness((_u,_o,n)=>reply(200,answer(n===1?'contradiction':'no_conflict')));
        await h.prepare(mode);let rendered;
        const box={chat:h.ctx.chat,eventSource:h.ctx.eventSource,event_types:h.ctx.eventTypes,name2:'Speaker',selected_group:false,
            console:{debug(){}},generation_started:new Date(),power_user:{message_token_count_enabled:true},
            getMessageTimeStamp:()=> 'native time',getGeneratingApi:()=> 'native',getGeneratingModel:()=> 'native model',
            processImageAttachment:async()=>{},getTokenCountAsync:async()=>123,structuredClone,
            addOneMessage:message=>{rendered=message.mes;},statMesProcess(){},characters:[],this_chid:0,
            chatElement:{find:()=>({})},addCopyToCodeBlocks(){},saveLogprobsForActiveMessage(){},updateSwipeCounter(){},
            syncMesToSwipe:i=>{const message=h.ctx.chat[i];message.swipes[message.swipe_id]=message.mes;},
        };
        vm.createContext(box);
        vm.runInContext(native.saveReply.replace('export ','')+'\n'+native.finalize.replace('async finalizeIntermediaryMessage(', 'async function finalizeIntermediaryMessage('),box);
        if(mode==='swipe')h.ctx.chat.at(-1).swipe_id=h.ctx.chat.at(-1).swipes.length;
        if(!streaming)await box.saveReply({type:mode,getMessage:'NATIVE'});
        else{
            await box.saveReply({type:mode,getMessage:'...',fromStreaming:true});
            assert.equal(h.masks.size,1);assert.equal(h.requests.length,0);
            const index=h.ctx.chat.length-1,processor={type:mode,messageId:index,swipes:[],messageLogprobs:[],continueMessage:'',isFinished:true,
                abortController:new AbortController(),reasoningHandler:{finish:async()=>{}},
                onProgressStreaming:async(_i,text)=>{h.ctx.chat[index].mes=text;rendered=text;},
                markUIGenStopped:()=>{void h.ctx.eventSource.emit('ended',index);}};
            h.ctx.streamingProcessor=processor;
            h.ctx.updateMessageBlock=(_i,message)=>{assert.equal(h.masks.size,1);rendered=message.mes;};
            await box.finalizeIntermediaryMessage.call(processor,index,'NATIVE',{unlockUI:true});
        }
        const message=h.ctx.chat.at(-1);
        assert.equal(h.ctx.chat.length,2);assert.equal(message.mes,'CORRECTED');assert.equal(rendered,'CORRECTED');
        assert.equal(message.swipes[message.swipe_id],'CORRECTED');assert.equal(h.generationCount(),1);assert.equal(h.masks.size,0);
        assert.equal(message.extra.model,'native model');assert.equal(message.send_date,'native time');
    });
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
