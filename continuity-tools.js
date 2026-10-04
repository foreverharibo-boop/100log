// Character-scoped identity links, bounded supporting quotes and source-scoped exclusions.
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const safeName = value => {
    const name = String(value ?? '').trim().slice(0, 50);
    return name && !['__proto__', 'constructor', 'prototype'].includes(name) ? name : '';
};
export function normalizeAliases(raw = []) {
    const links = [];
    for (const row of (Array.isArray(raw) ? raw : []).slice(0, 100)) {
        const alias = safeName(row?.alias), canonical = safeName(row?.canonical);
        if (alias && canonical && alias !== canonical && !links.some(x => x.alias === alias)) links.push({ alias, canonical });
    }
    return links;
}
export function canonicalName(name, raw = []) {
    let current = safeName(name);
    const links = normalizeAliases(raw), seen = new Set();
    while (!seen.has(current)) {
        seen.add(current);
        const next = links.find(row => row.alias === current)?.canonical;
        if (!next) return current;
        current = next;
    }
    return safeName(name); // Invalid imported cycles never resolve to an arbitrary person.
}
export function linkAlias(value, alias, canonical) {
    alias = safeName(alias); canonical = safeName(canonical);
    if (!alias || !canonical || alias === canonical) throw new Error('서로 다른 두 이름을 입력해 주세요.');
    const links = normalizeAliases(value.nameAliases).filter(row => row.alias !== alias);
    if (canonicalName(canonical, links) === alias) throw new Error('서로를 가리키는 별칭은 연결할 수 없어요.');
    if (links.length >= 100) throw new Error('이름 연결은 최대 100개예요.');
    value.nameAliases = [...links, { alias, canonical }];
}
// Projection keeps original keys intact so unlinking restores separate people.
export function resolveFactNames(fact, aliases = []) {
    const knowledge = {}, knowledgeEvidence = {}, groups = new Map();
    for (const [name, status] of Object.entries(fact.knowledge || {})) {
        if (!['known', 'unknown', 'unverified'].includes(status)) continue;
        const canonical = canonicalName(name, aliases);
        if (!canonical) continue;
        if (!groups.has(canonical)) groups.set(canonical, []);
        groups.get(canonical).push({ name, status, proof: fact.knowledgeEvidence?.[name] });
    }
    const conflicts = [];
    for (const [name, entries] of groups) {
        const manual = entries.filter(x => x.proof?.manual);
        const relevant = manual.length ? manual : entries;
        const states = new Set(relevant.map(x => x.status));
        const status = states.size === 1 ? relevant[0].status : 'unverified';
        knowledge[name] = status;
        if (states.size > 1) conflicts.push(name);
        else {
            const choice = [...relevant].sort((a,b) => (b.proof?.sourceId ?? -1) - (a.proof?.sourceId ?? -1))[0];
            if (choice.proof) knowledgeEvidence[name] = { ...choice.proof };
        }
    }
    return { ...fact, knowledge, knowledgeEvidence, nameAliases: normalizeAliases(aliases), aliasConflicts: conflicts };
}
export function normalizeSupportingEvidence(raw = []) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : []).filter(row => {
        if (!row || !Number.isInteger(row.sourceId) || row.sourceId < 0 || typeof row.sourceChatId !== 'string' || !compact(row.evidence)) return false;
        const key = JSON.stringify([row.sourceChatId,row.sourceId,compact(row.evidence)]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    }).slice(-4).map(row => ({ sourceId:row.sourceId, sourceChatId:row.sourceChatId, evidence:String(row.evidence).slice(0,500),
        reason:String(row.reason || '').slice(0,180), sourceSignature:String(row.sourceSignature || ''), sourceChecked:row.sourceChecked === true }));
}
export function appendSupportingEvidence(fact, proof) {
    const before = normalizeSupportingEvidence(fact.supportingEvidence);
    if (before.some(row => row.sourceChatId === proof.sourceChatId && row.sourceId === proof.sourceId && compact(row.evidence) === compact(proof.evidence))) return false;
    const groups = new Map();
    const rows = [...before,proof];
    for (const row of rows) if (!groups.has(row.sourceChatId)) groups.set(row.sourceChatId,groups.size);
    rows.sort((a,b) => a.sourceChatId === b.sourceChatId ? a.sourceId - b.sourceId : groups.get(a.sourceChatId) - groups.get(b.sourceChatId));
    fact.supportingEvidence = normalizeSupportingEvidence(rows);
    return JSON.stringify(before) !== JSON.stringify(fact.supportingEvidence);
}
export function addRejectedMemory(value, fact) {
    if (!fact.sourceChatId || !Number.isInteger(fact.sourceId) || !compact(fact.sourceText)) throw new Error('원문 출처가 있는 기억만 재수집에서 제외할 수 있어요.');
    value.rejectedMemories ??= [];
    const existing = value.rejectedMemories.find(row => row.sourceChatId === fact.sourceChatId && row.sourceId === fact.sourceId && compact(row.text) === compact(fact.text));
    if (existing) return existing;
    const row = { id:`rejected-${Date.now()}-${Math.random().toString(36).slice(2)}`, text:String(fact.text).slice(0,300),
        sourceChatId:fact.sourceChatId, sourceId:fact.sourceId, sourceText:String(fact.sourceText).slice(0,500), sourceSignature:fact.sourceSignature || '' };
    if (value.rejectedMemories.length >= 200) throw new Error('재수집 제외는 최대 200개예요. 설정에서 필요 없는 항목의 제외를 해제해 주세요.');
    value.rejectedMemories.push(row); return row;
}
export function rejectedMemoryMatch(op, records = [], chatId = '') {
    return records.find(row => row.sourceChatId === chatId && row.sourceId === op.sourceId
        && (row.sourceSignature && op.sourceSignature ? row.sourceSignature === op.sourceSignature : compact(row.sourceText) === compact(op.sourceText))
        && (compact(row.text).toLowerCase() === compact(op.text).toLowerCase() || row.id === op.rejectedMatchId));
}
export function aliasSuggestions(raw, rows, chatId = '') {
    return (Array.isArray(raw) ? raw : []).slice(0,12).flatMap(row => {
        const alias = safeName(row?.alias), canonical = safeName(row?.canonical);
        const source = rows.find(x => x.id === row?.sourceId), evidence = compact(row?.evidence);
        if (!alias || !canonical || alias === canonical || !source || evidence.length < 4 || !compact(source.text).includes(evidence)) return [];
        return [{alias,canonical,sourceId:source.id,sourceChatId:chatId,evidence:String(row.evidence).slice(0,500),reason:String(row.reason || '').slice(0,180)}];
    });
}

// Hide stale support from consumers without mutating journal snapshots before rollback.
export function availableSupportingEvidence(fact, chat, currentChatId, cutoff, signature) {
    return normalizeSupportingEvidence(fact.supportingEvidence).filter(proof => {
        if (proof.sourceChatId !== currentChatId) return true; // Saved cross-chat quote; no same-number lookup.
        const message = chat[proof.sourceId];
        return proof.sourceId >= cutoff && message && !message.is_system && !message.is_hidden && !message.hidden
            && typeof message.mes === 'string' && compact(message.mes).includes(compact(proof.evidence))
            && (!proof.sourceSignature || proof.sourceSignature === signature(message));
    });
}
