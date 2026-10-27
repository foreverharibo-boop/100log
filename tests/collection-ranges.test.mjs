import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeCollectionRanges, stripCollectionRanges } from '../collection-ranges.js';
import { memoryRequest, omissionReviewRequest, cleanupRequest, parseMemoryOperations } from '../memory-engine.js';

const rules = [{ start: '<info>', end: '</info>' }, { start: '[TMI]', end: '[/TMI]' }];
const code = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const sourceCode = code.slice(code.indexOf('function sourceRows('), code.indexOf('function cleanupSignature('));
function sources() {
    const box = { stripCollectionRanges, recentWindowStart: () => 0,
        isVisibleChatMessage: m => m && !m.is_system && !m.is_hidden && !m.hidden && typeof m.mes === 'string' };
    vm.createContext(box); vm.runInContext(sourceCode, box); return box;
}

test('no presets, invalid/duplicate pairs ignored, whitespace retained literally', () => {
    assert.deepEqual(normalizeCollectionRanges(), []);
    assert.deepEqual(normalizeCollectionRanges([{}, { start:' ',end:'x' }, ...rules, rules[0], { start:' begin ',end:' end ' }]),
        [...rules,{ start:' begin ',end:' end ' }]);
});
test('multiline, repeated and multiple literal patterns exclude markers and content', () => {
    const input = '공개 사건<info>속마음\n💗</info>다음 사건[TMI]비밀[/TMI]<info>독백</info>끝';
    assert.equal(stripCollectionRanges(input,rules), '공개 사건\n\n다음 사건\n\n끝');
    assert.equal(input.includes('속마음'),true);
    assert.equal(stripCollectionRanges('a.*[secret]b', [{start:'.*[',end:']'}]), 'a\n\nb');
});
test('nested and overlapping pairs remove the full union, independent of rule order', () => {
    assert.equal(stripCollectionRanges('A<info>outer<info>inner</info>outer</info>B',rules),'A\n\nB');
    const overlap = 'A<info>x[TMI]y</info>z[/TMI]B';
    assert.equal(stripCollectionRanges(overlap,rules),'A\n\nB');
    assert.equal(stripCollectionRanges(overlap,[...rules].reverse()),'A\n\nB');
});
test('unclosed opening excludes the tail, unmatched closing and case mismatch remain literal', () => {
    assert.equal(stripCollectionRanges('A<info>secret',rules),'A\n\n');
    assert.equal(stripCollectionRanges('A</info>B<INFO>C</INFO>',rules),'A</info>B<INFO>C</INFO>');
});
test('identical delimiters support repeated code fences and unclosed final fences', () => {
    assert.equal(stripCollectionRanges('A```secret```B```secret2', [{start:'```',end:'```'}]),'A\n\nB\n\n');
});
test('masking preserves exact UTF-16 length and line endings for saved offsets', () => {
    const text='A<info>💗\r\n가나</info>B';
    const masked=stripCollectionRanges(text,rules,true);
    assert.equal(masked.length,text.length);assert.equal(masked.indexOf('B'),text.indexOf('B'));
    assert.equal(masked.indexOf('\r\n'),text.indexOf('\r\n'));assert.doesNotMatch(masked,/💗|가나|info/);
});
test('collection resumes across large excluded blocks without leaking content or skipping public text', () => {
    const {sourceRows}=sources();
    const text='Before public. <info>'+('PRIVATE_SECRET '.repeat(2000))+'</info> After public.';
    const ctx={chat:[{name:'Char',mes:text}]};let cursor=0,offset=0,all=[],turns=0;
    while(cursor<ctx.chat.length) {
        const batch=sourceRows(ctx,cursor,offset,ctx.chat.length,'detailed',rules);
        all.push(...batch.rows);cursor=batch.nextCursor;offset=batch.nextOffset;
        assert.ok(++turns<10);
    }
    const sent=all.map(x=>x.text).join('');
    assert.match(sent,/Before public/);assert.match(sent,/After public/);assert.doesNotMatch(sent,/PRIVATE_SECRET|<info>/);
    assert.equal(ctx.chat[0].mes,text);
});
test('fully excluded messages advance without an AI row; both user and character messages are filtered', () => {
    const {sourceRows}=sources();
    const ctx={chat:[{mes:'<info>SECRET</info>'},{is_user:true,mes:'Said yes. [TMI]SECRET[/TMI]'}]};
    const batch=sourceRows(ctx,0,0,2,'balanced',rules);
    assert.equal(batch.nextCursor,2);assert.equal(batch.rows.length,1);assert.equal(batch.rows[0].id,1);
    assert.doesNotMatch(batch.rows[0].text,/SECRET/);
});
test('cleanup strips before truncating a long message tail', () => {
    const {recentCleanupRows}=sources();
    const ctx={chat:[{mes:'Public promise. <info>'+('PRIVATE_SECRET '.repeat(2000))+'</info>'}]};
    const rows=recentCleanupRows(ctx,rules);
    assert.equal(rows.length,1);assert.match(rows[0].text,/Public promise/);assert.doesNotMatch(rows[0].text,/PRIVATE_SECRET/);
});
test('new collection, omission review, context and cleanup prompts contain only remaining source text', () => {
    const box=sources();
    const ctx={chat:[{mes:'Dana said hello. <info>PRIVATE_SECRET</info>',name:'Dana'}]};
    const rows=box.sourceRows(ctx,0,0,1,'balanced',rules).rows;
    const context=stripCollectionRanges('Context said hello. [TMI]CONTEXT_SECRET[/TMI]',rules);
    for(const build of [memoryRequest,omissionReviewRequest]) {
        const prompt=build([],rows,[{id:1,text:context}]);
        assert.doesNotMatch(prompt,/PRIVATE_SECRET|CONTEXT_SECRET/);assert.match(prompt,/Dana said hello/);
    }
    assert.doesNotMatch(cleanupRequest([],box.recentCleanupRows(ctx,rules)),/PRIVATE_SECRET/);
    // Execute the actual collection context-builder used before each AI request.
    const begin=code.indexOf('const contextRows = ctx.chat.map',code.indexOf('async function performMemorySync'));
    const end=code.indexOf('\n            for (const row of contextRows)',begin);
    const env={ctx:{chat:[{mes:'Context said hello. [TMI]CONTEXT_SECRET[/TMI]',name:'Dana'}]},start:1,
        recentWindowStart:()=>0,isVisibleChatMessage:()=>true,messageSignature:()=> 'sig',
        settings:()=>({collectionExcludedRanges:rules}),stripCollectionRanges};
    vm.createContext(env);vm.runInContext(code.slice(begin,end)+'\nglobalThis.result = contextRows;',env);
    assert.doesNotMatch(env.result[0].text,/CONTEXT_SECRET/);assert.equal(env.result[0].signature,'sig');
});
test('fabricated evidence quoting only excluded content is rejected by source checks', () => {
    const rows=sources().sourceRows({chat:[{mes:'Dana said hello. <info>Dana secretly bought a ring.</info>'}]},0,0,1,'balanced',rules).rows;
    const op={action:'add',kind:'fact',text:'Dana secretly bought a ring.',sourceId:0,evidence:'Dana secretly bought a ring.',evidenceType:'occurred',confidence:1,knowledge:{}};
    const result=parseMemoryOperations(JSON.stringify({operations:[op]}),rows,[],'chat',[],{collectorOnly:true});
    assert.equal(result.operations.length,0);assert.equal(result.rejected,1);
    op.text=op.evidence='Dana said hello.';op.evidenceType='explicit_statement';
    assert.equal(parseMemoryOperations(JSON.stringify({operations:[op]}),rows,[],'chat',[],{collectorOnly:true}).operations.length,1);
});

function ui() {
    class Element {
        children=[];value='';textContent='';disabled=false;listeners={};
        append(...nodes){this.children.push(...nodes)}
        replaceChildren(...nodes){this.children=nodes}
        setAttribute(){}
        addEventListener(name,fn){this.listeners[name]=fn}
        async click(){if(!this.disabled)await this.listeners.click?.()}
    }
    const elements=Object.fromEntries(['collection-ranges','range-start','range-end','range-add','range-feedback'].map(k=>[k,new Element()]));
    const config={collectionExcludedRanges:[],facts:[{text:'existing memory'}]};let persisted,fail=false;
    const box={busy:false,extracting:false,translating:false,normalGenerating:false,rangeSettingsSaving:false,
        document:{createElement:()=>new Element()},$id:id=>elements[id],settings:()=>config,normalizeCollectionRanges,
        fileStorage:{save:async()=>{if(fail)throw Error('save failed');persisted=structuredClone(config)}},
        makeButton:(text,fn)=>{const button=new Element();button.textContent=text;button.addEventListener('click',fn);return button}};
    box.render=()=>box.renderCollectionRanges(false);
    vm.createContext(box);vm.runInContext(code.slice(code.indexOf('function renderCollectionRanges('),code.indexOf('function renderCollectionExclusions(')),box);
    box.bindCollectionRanges();box.render();
    return {box,elements,config,get persisted(){return persisted},set fail(x){fail=x}};
}
test('settings add/delete pairs persist, duplicates and blanks do not apply, HTML is literal, memories unchanged', async () => {
    const t=ui(),e=t.elements;
    await e['range-add'].click();assert.match(e['range-feedback'].textContent,/모두 입력/);
    e['range-start'].value='<info>';e['range-end'].value='</info>';await e['range-add'].click();
    assert.deepEqual(t.persisted.collectionExcludedRanges,rules.slice(0,1));
    assert.equal(e['range-start'].value,'');assert.equal(e['collection-ranges'].children[0].children[0].textContent,'<info>');
    e['range-start'].value='<info>';e['range-end'].value='</info>';await e['range-add'].click();
    assert.match(e['range-feedback'].textContent,/이미 등록/);assert.equal(t.config.collectionExcludedRanges.length,1);
    await e['collection-ranges'].children[0].children[2].click();assert.equal(t.persisted.collectionExcludedRanges.length,0);
    assert.deepEqual(t.config.facts,[{text:'existing memory'}]);
});
test('failed setting saves roll back, input remains available to retry, editing is blocked during collection', async () => {
    const t=ui(),e=t.elements;t.fail=true;e['range-start'].value='<info>';e['range-end'].value='</info>';
    await e['range-add'].click();assert.equal(t.config.collectionExcludedRanges.length,0);assert.equal(e['range-start'].value,'<info>');assert.match(e['range-feedback'].textContent,/save failed/);
    t.fail=false;t.box.extracting=true;t.box.renderCollectionRanges(true);await e['range-add'].click();assert.equal(t.config.collectionExcludedRanges.length,0);
});
