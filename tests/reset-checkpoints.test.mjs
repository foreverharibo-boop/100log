import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureCharacterRoomLengths, captureSharedRoomLengths } from '../reset-checkpoints.js';
import { resetCharacterMemory, selectedMemoryStore, separateRoomMemory } from '../memory-scope.js';

function harness() {
    const ctx = { characterId:0,characters:[{avatar:'character.png'}],chatId:'current',
        chat:Array.from({length:10},(_,i)=>({mes:'current '+i})),getRequestHeaders:()=>({'X-CSRF-Token':'test','Content-Type':'application/json'}) };
    const rooms = new Map([['current',3],['shared-old',12],['private-old',8],['empty',0]]);
    const calls=[];let active=0,maxActive=0;
    const request=async(url,options)=>{
        assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-CSRF-Token'],'test');
        assert.ok(options.signal instanceof AbortSignal);
        const body=JSON.parse(options.body);calls.push({url,body});assert.equal(body.avatar_url,'character.png');
        if(url==='/api/characters/chats') {
            assert.equal(body.simple,true);
            return {ok:true,json:async()=>[...rooms.keys()].map(id=>({file_id:id,file_name:id+'.jsonl'}))};
        }
        assert.equal(url,'/api/chats/get');assert.notEqual(body.file_name,'current');
        active++;maxActive=Math.max(active,maxActive);await Promise.resolve();active--;
        return {ok:true,json:async()=>[{chat_metadata:{}},...Array.from({length:rooms.get(body.file_name)},(_,i)=>({mes:'private RP '+i,is_hidden:i%2===0}))]};
    };
    return {ctx,rooms,calls,request,get maxActive(){return maxActive}};
}

test('snapshot includes every stored room, excludes JSONL metadata from indices, and uses live unsaved current chat',async()=>{
    const h=harness();const checkpoints=await captureCharacterRoomLengths(h.ctx,h.request);
    assert.deepEqual(Object.fromEntries(checkpoints),{current:10,'shared-old':12,'private-old':8,empty:0});
    assert.equal(h.calls.filter(x=>x.url==='/api/chats/get').length,3);
    assert.doesNotMatch(JSON.stringify(checkpoints),/private RP|chat_metadata/);
});

test('snapshot checkpoints stay fixed when new messages appear before another room is reopened',async()=>{
    const h=harness();const checkpoints=await captureCharacterRoomLengths(h.ctx,h.request);
    h.rooms.set('shared-old',16);h.rooms.set('private-old',15);
    const root={uuid:'id',facts:[{text:'old'}],chats:{}};
    separateRoomMemory(root,'private-old',0,root);
    resetCharacterMemory(root,'current',h.ctx.chat.length,checkpoints);
    const reload=JSON.parse(JSON.stringify(root));
    assert.equal(reload.chats['shared-old'].autoMemory.cursor,12);
    assert.equal(selectedMemoryStore(reload,'private-old').chats['private-old'].autoMemory.cursor,8);
    assert.equal(reload.chats.empty.autoMemory.cursor,0);
    assert.equal(reload.chats.current.autoMemory.cursor,10);
});

test('many room reads have bounded concurrency',async()=>{
    const h=harness();for(let i=0;i<20;i++)h.rooms.set('room-'+i,i);
    const checkpoints=await captureCharacterRoomLengths(h.ctx,h.request);
    assert.equal(checkpoints.length,h.rooms.size);assert.ok(h.maxActive<=4);
});

for(const [name,result] of [
    ['error instead of list',{error:true}],['invalid room identity',[{file_id:'old',file_name:'different.jsonl'}]],
])test(name+' fails before deletion',async()=>{
    const h=harness();await assert.rejects(captureCharacterRoomLengths(h.ctx,async()=>({ok:true,json:async()=>result})),/削|삭제/);
});

for(const [name,mode] of [['HTTP error','http'],['invalid chat response','object'],['malformed message','message']])
test(name+' from any room rejects the whole snapshot',async()=>{
    const h=harness();const request=async(url,options)=>{
        if(url==='/api/characters/chats')return h.request(url,options);
        if(mode==='http')return {ok:false,status:503};
        return {ok:true,json:async()=>mode==='object'?{error:true}:[{chat_metadata:{}},{mes:null}]};
    };
    await assert.rejects(captureCharacterRoomLengths(h.ctx,request),/삭제/);
});

test('current chat mutation during snapshot rejects the reset instead of silently moving its cutoff',async()=>{
    const h=harness();const request=async(url,options)=>{
        const response=await h.request(url,options);
        if(url==='/api/characters/chats')h.ctx.chat.push({mes:'new incoming reply'});
        return response;
    };
    await assert.rejects(captureCharacterRoomLengths(h.ctx,request),/대화가 바뀌/);
});

test('special filenames are data and cannot change prototypes',async()=>{
    const h=harness();h.rooms.set('__proto__',7);const checkpoints=await captureCharacterRoomLengths(h.ctx,h.request);
    const root={uuid:'id',facts:[],chats:{}};resetCharacterMemory(root,'current',10,checkpoints);
    assert.equal(root.chats.__proto__.autoMemory.cursor,7);assert.equal({}.autoMemory,undefined);
});

test('invalid checkpoint counts fail without modifying any existing memory',()=>{
    const root={uuid:'id',facts:[{text:'keep'}],chats:{}};const before=JSON.stringify(root);
    assert.throws(()=>resetCharacterMemory(root,'current',10,[['old',-1]]));assert.equal(JSON.stringify(root),before);
});

for(const currentPrivate of [false,true])test(`shared checkpoint lookup excludes independent rooms entirely, current independent=${currentPrivate}`,async()=>{
    const h=harness(),root={chatMemoryScopes:{'private-old':{independent:true,store:{facts:[{text:'keep'}]}}}};
    if(currentPrivate)root.chatMemoryScopes.current={independent:true,store:{}};
    const before=JSON.stringify(root);
    const request=async(url,options)=>{
        if(url==='/api/chats/get')assert.notEqual(JSON.parse(options.body).file_name,'private-old');
        return h.request(url,options);
    };
    const checkpoints=await captureSharedRoomLengths(h.ctx,root,request),counts=Object.fromEntries(checkpoints);
    assert.equal(counts['private-old'],undefined);assert.equal(counts.current,currentPrivate?undefined:10);
    assert.equal(counts['shared-old'],12);assert.equal(counts.empty,0);assert.equal(JSON.stringify(root),before);
});
