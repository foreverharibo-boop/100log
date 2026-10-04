import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../continuity-tools.js';
import * as m from '../memory-engine.js';
import * as core from '../core.js';
const fact=()=>({id:'f',text:'A에게 흉터가 생겼다.',kind:'fact',active:true,origin:'auto',sourceId:0,sourceChatId:'c',sourceText:'A was injured.',sourceSignature:'sig0',knowledge:{A:'known'},knowledgeEvidence:{},retention:'recent'});
const rows=[{id:5,text:'A looked at the scar and showed it to B.',signature:'sig5'}];
const confirm=(extra={})=>({action:'confirm',id:'f',sourceId:5,evidence:rows[0].text,evidenceType:'occurred',reason:'직접 흉터를 확인하고 보여 줌',...extra});
const parse=(value,operations,sourceRows=rows)=>m.parseMemoryOperations(JSON.stringify({operations}),sourceRows,value.facts.map(f=>c.resolveFactNames(f,value.nameAliases)),'c',[],{collectorOnly:true});
test('alias links are scoped to supplied character, reversible and cycle-safe',()=>{
 const a={nameAliases:[]}, b={};c.linkAlias(a,'Emris','엠리스');c.linkAlias(a,'별명','Emris');
 assert.equal(c.canonicalName('별명',a.nameAliases),'엠리스');assert.equal(c.canonicalName('Emris',b.nameAliases),'Emris');
 assert.throws(()=>c.linkAlias(a,'엠리스','별명'));
 const original={knowledge:{Emris:'known'}};const projected=c.resolveFactNames(original,a.nameAliases);assert.deepEqual(projected.knowledge,{'엠리스':'known'});assert.deepEqual(original.knowledge,{Emris:'known'});
 a.nameAliases=[];assert.deepEqual(c.resolveFactNames(original,a.nameAliases).knowledge,{Emris:'known'});
});
test('conflicting aliases stay uncertain and a manual correction takes precedence',()=>{
 const links=[{alias:'Emris',canonical:'엠리스'}], f={knowledge:{Emris:'known','엠리스':'unknown'},knowledgeEvidence:{}};
 assert.equal(c.resolveFactNames(f,links).knowledge['엠리스'],'unverified');assert.deepEqual(c.resolveFactNames(f,links).aliasConflicts,['엠리스']);
 f.knowledgeEvidence.Emris={status:'known',manual:true};assert.equal(c.resolveFactNames(f,links).knowledge['엠리스'],'known');
 f.knowledgeEvidence['엠리스']={status:'unknown',manual:true};assert.equal(c.resolveFactNames(f,links).knowledge['엠리스'],'unverified');
});
test('alias suggestions require source quotes and never apply themselves',()=>{
 const raw={operations:[],aliasSuggestions:[{alias:'A',canonical:'에이',sourceId:5,evidence:rows[0].text},{alias:'B',canonical:'비',sourceId:5,evidence:'fabricated quote'}]};
 const value={facts:[]};const result=m.parseMemoryOperations(JSON.stringify(raw),rows,[],'c',[],{collectorOnly:true});assert.equal(result.aliasSuggestions.length,1);assert.equal(value.nameAliases,undefined);
});
test('collected names and downstream review use approved aliases including speaker guard',()=>{
 const value={facts:[{...fact(),knowledge:{Emris:'unknown'},sourceText:'He was never told.'}],nameAliases:[{alias:'Emris',canonical:'엠리스'}]};
 assert.deepEqual(m.collectedCharacterNames(value,[{mes:'hi',name:'Emris'}]),['엠리스']);
 const resolved=c.resolveFactNames(value.facts[0],value.nameAliases);
 const batch=core.buildChecks('reply',[resolved],'','Emris')[0];assert.deepEqual(batch.state.established_facts[0].name_aliases,value.nameAliases);
 assert.equal(core.readContradictions(batch,{q0:{type:'choice',choice:'knowledge_leak',confidence:.99}}).length,1);
 assert.match(m.memoryInjection([resolved],'',40,true),/name_aliases/);
});
test('new support preserves fact identity, original source, retention and fact count',()=>{
 const value={facts:[fact()]};const original=structuredClone(value.facts[0]);const parsed=parse(value,[confirm()]);assert.equal(parsed.operations.length,1);
 const result=m.applyMemoryOperations(value,parsed.operations,'c');assert.equal(result.updated,1);assert.equal(result.added,0);assert.equal(value.facts.length,1);
 const {supportingEvidence,...unchanged}=value.facts[0];assert.deepEqual(unchanged,original);assert.equal(supportingEvidence[0].sourceId,5);assert.equal(supportingEvidence[0].sourceChecked,true);
 assert.equal(m.applyMemoryOperations(value,parsed.operations,'c').updated,0);
});
test('confirmation can establish a new learner, quoted support cannot invent a learner',()=>{
 const value={facts:[fact()]};const op=confirm({knowledge:{B:'known',C:'known'},knowledgeEvidence:{B:{status:'known',sourceId:5,evidence:rows[0].text,reason:'직접 보여 줌'},C:{status:'known',sourceId:5,evidence:'invented',reason:'guess'}}});
 m.applyMemoryOperations(value,parse(value,[op]).operations,'c');assert.deepEqual(value.facts[0].knowledge,{A:'known',B:'known'});assert.equal(value.facts[0].supportingEvidence.length,1);
});
test('support cannot bypass exact quotes, lock protection or manual memory protection',()=>{
 for(const extra of [{pinned:true},{origin:'manual'}]){const value={facts:[{...fact(),...extra}]};assert.equal(parse(value,[confirm()]).operations.length,0)}
 const value={facts:[fact()]};assert.equal(parse(value,[confirm({evidence:'not in source'})]).operations.length,0);
});
test('support is bounded and retained outside JEV review',()=>{
 const f=fact();for(let id=1;id<=7;id++)c.appendSupportingEvidence(f,{sourceId:id,sourceChatId:'c',evidence:`source ${id}`,sourceChecked:true});
 assert.equal(f.supportingEvidence.length,4);assert.equal(f.supportingEvidence.at(-1).sourceId,7);
 assert.equal(core.buildChecks('reply',[f])[0].state.established_facts[0].supporting_evidence,undefined);
 const chat=Array.from({length:30},(_,id)=>({mes:`source ${id}`,name:'A'}));assert.ok(core.buildReviewSources(chat,[f],'c').some(row=>row.id===7));assert.ok(!core.buildReviewSources(chat,[f],'other').some(row=>row.id===7));
});
test('support is not used after swipe, hiding or leaving visible window, and does not break rollback',()=>{
 const chat=Array.from({length:6},(_,id)=>({mes:id===5?rows[0].text:`message ${id}`,name:'A'}));
 const value={facts:[fact()]},state={autoMemory:{cursor:0,offset:0,journal:[]}};
 const sourceRows=[{...rows[0],signature:m.messageSignature(chat[5])}];const result=m.applyMemoryOperations(value,parse(value,[confirm()],sourceRows).operations,'c');
 m.recordMemoryBatch(state,{rows:sourceRows,start:5,offset:0,nextCursor:6,nextOffset:0,changes:result.changes});
 assert.equal(c.availableSupportingEvidence(value.facts[0],chat,'c',0,m.messageSignature).length,1);
 assert.equal(c.availableSupportingEvidence(value.facts[0],chat,'c',6,m.messageSignature).length,0);
 chat[5].is_hidden=true;assert.equal(c.availableSupportingEvidence(value.facts[0],chat,'c',0,m.messageSignature).length,0);
 m.reconcileMemory(value,state,chat);assert.equal(value.facts[0].supportingEvidence,undefined);
});
test('new support does not restart a carryover lifetime or keep an expired ordinary fact',()=>{
 const f={...fact(),summaryCarryover:true,carryoverStartId:0,retention:'summary'},value={facts:[f]};m.applyMemoryOperations(value,parse(value,[confirm()]).operations,'c');assert.equal(f.carryoverStartId,0);
 const chat=Array.from({length:110},()=>({mes:'visible',name:'A'}));const state={};m.pruneToRecentWindow(value,state,chat,'c');assert.equal(value.facts.length,0);
});
test('same-state knowledge accepts later evidence but not older recheck evidence',()=>{
 const value={facts:[fact()]};const op=confirm({action:'knowledge',knowledge:{A:'known'},knowledgeEvidence:{A:{status:'known',sourceId:5,evidence:rows[0].text,reason:'direct perception'}}});
 assert.equal(m.applyMemoryOperations(value,parse(value,[op]).operations,'c').updated,1);
 const oldRows=[{id:2,text:'A noticed the scar.',signature:'s2'}],old={...op,sourceId:2,evidence:oldRows[0].text,knowledgeEvidence:{A:{status:'known',sourceId:2,evidence:oldRows[0].text,reason:'older'}}};
 m.applyMemoryOperations(value,parse(value,[old],oldRows).operations,'c');assert.equal(value.facts[0].knowledgeEvidence.A.sourceId,5);
});
test('knowledge updates honor manual aliases and patch all equivalent stored keys',()=>{
 const aliases=[{alias:'A',canonical:'에이'}];const value={facts:[{...fact(),knowledge:{A:'unknown','에이':'unverified'}}],nameAliases:aliases};
 const op=confirm({action:'knowledge',knowledge:{'에이':'known'},knowledgeEvidence:{'에이':{status:'known',sourceId:5,evidence:rows[0].text,reason:'perception'}}});
 m.applyMemoryOperations(value,parse(value,[op]).operations,'c');assert.deepEqual(value.facts[0].knowledge,{A:'known','에이':'known'});
 value.facts[0].knowledgeEvidence.A={status:'known',manual:true};op.knowledge['에이']='unknown';op.knowledgeEvidence['에이'].status='unknown';assert.equal(parse(value,[op]).operations.length,0);
});
test('rejecting a claim survives rebuild, blocks identical and declared paraphrase proposals only at original source',()=>{
 const value={facts:[fact()]};const rejected=c.addRejectedMemory(value,value.facts[0]);core.removeFact(value,'f');
 const op={action:'add',text:rejected.text,sourceId:0,sourceSignature:'sig0',sourceText:rejected.sourceText,kind:'fact',knowledge:{}};
 assert.equal(m.applyMemoryOperations(value,[op],'c').added,0);
 assert.equal(m.applyMemoryOperations(value,[{...op,text:'다른 표현',rejectedMatchId:rejected.id}],'c').added,0);
 assert.equal(m.applyMemoryOperations(value,[{...op,text:'다른 사건'}],'c').added,1);
 const chat=[{mes:'A was injured.',name:'A'}];m.resetRecentWindow(value,{},chat,'c');assert.equal(value.rejectedMemories.length,1);
 assert.equal(m.applyMemoryOperations(value,[{...op,sourceId:1,sourceSignature:'new'}],'c').added,1);
 value.facts=[];assert.equal(m.applyMemoryOperations(value,[op],'another-chat').added,1);
 value.facts=[];assert.equal(m.applyMemoryOperations(value,[{...op,sourceSignature:'swiped'}],'c').added,1);
});
test('unblocking permits collecting again, source-less rejection fails without deleting memory',()=>{
 const value={facts:[fact()]};c.addRejectedMemory(value,value.facts[0]);value.rejectedMemories=[];assert.equal(c.rejectedMemoryMatch({sourceId:0,text:fact().text,sourceSignature:'sig0'},value.rejectedMemories,'c'),undefined);
 assert.throws(()=>c.addRejectedMemory(value,{text:'no source'}));assert.equal(value.facts.length,1);
});
test('collector receives aliases and relevant exclusions in both standard and omission review',()=>{
 const value={facts:[fact()],nameAliases:[{alias:'A',canonical:'에이'}]};c.addRejectedMemory(value,value.facts[0]);const identity={...value,sourceChatId:'c'};
 for(const request of [m.memoryRequest,m.omissionReviewRequest]){
  const prompt=request(value.facts,[{id:0,text:'A was injured.',signature:'sig0'}],[],'detailed',{},identity);
  assert.match(prompt,/APPROVED_NAME_ALIASES/);assert.match(prompt,/rejected-/);assert.match(prompt,/action confirm/);assert.match(prompt,/without user approval/);
 }
});


test('newest collected memories display first regardless of source, with stable edits and no storage mutation',()=>{
 const a={id:'old',sourceId:500,sourceChatId:'current'},b={id:'middle',sourceId:2,sourceChatId:'other'},c={id:'new',sourceId:1,sourceChatId:'current'};
 const stored=[a,b,c];
 assert.deepEqual(m.sortMemoriesByCollection(stored).map(f=>f.id),['new','middle','old']);
 a.knowledge={Person:'known'};b.commitment={status:'underway'};
 assert.deepEqual(m.sortMemoriesByCollection(stored).map(f=>f.id),['new','middle','old']);
 assert.deepEqual(stored.map(f=>f.id),['old','middle','new']);
 stored.push({id:'manual'});assert.equal(m.sortMemoriesByCollection(stored)[0].id,'manual');
});
