export const MAX_FACTS = 80;
export const MAX_HISTORY = 500;
export const MAX_DRAFT = 18000;
export const newId = () => `mb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function chatKey(context) {
    if (context.groupId || context.characterId === undefined || context.characterId === null || !context.chatId) return null;
    return `${context.characterId}:${context.chatId}`;
}

export function chunksOfDraft(text) {
    const draft = String(text ?? '').trim();
    if (!draft || draft.length > MAX_DRAFT) throw new Error('초안이 비어 있거나 검수 가능한 길이를 넘었어요.');
    // Split by paragraphs without ever silently dropping the tail.
    const paragraphs = draft.split(/\n\s*\n/).filter(Boolean);
    const chunks = [];
    for (const paragraph of paragraphs) {
        for (let offset = 0; offset < paragraph.length; offset += 1250) {
            chunks.push(paragraph.slice(offset, offset + 1250));
        }
    }
    return chunks;
}

function tokens(text) {
    return [...new Set(String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

export function pickFacts(segment, facts, limit = 6) {
    const words = tokens(segment);
    return facts.map((fact) => {
        const targets = tokens(`${fact.text} ${fact.keywords ?? ''}`);
        return { fact, score: targets.filter((word) => words.some((value) => value.includes(word) || word.includes(value))).length };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ fact }) => fact);
}

export function normalizeKnowledge(raw) {
    const entries = Array.isArray(raw) ? raw.map(({ name, status } = {}) => [name, status])
        : raw && typeof raw === 'object' ? Object.entries(raw) : [];
    const result = {};
    for (const [name, status] of entries.slice(0, 24)) {
        const label = String(name ?? '').trim().slice(0, 50);
        if (label && !['__proto__', 'constructor', 'prototype'].includes(label) && ['known', 'unknown'].includes(status)) result[label] = status;
    }
    return result;
}

export function setKnowledge(fact, name, status) {
    const label = String(name ?? '').trim().slice(0, 50);
    if (!label || ['__proto__', 'constructor', 'prototype'].includes(label)) throw new Error('인물 이름을 입력해 주세요.');
    fact.knowledge = normalizeKnowledge(fact.knowledge);
    if (status !== null && !(label in fact.knowledge) && Object.keys(fact.knowledge).length >= 24) throw new Error('한 사실에 기록할 수 있는 인물은 최대 24명이에요.');
    if (status === null) delete fact.knowledge[label];
    else if (['known', 'unknown'].includes(status)) fact.knowledge[label] = status;
    else throw new Error('인물의 지식 상태를 확인해 주세요.');
    return fact;
}

export function approveFact(value, proposed, replacesId = null) {
    const previous = replacesId ? value.facts.find((fact) => fact.id === replacesId) : null;
    if (replacesId && (!previous || !previous.active || previous.supersededBy)) throw new Error('갱신하려는 현재 사실을 찾을 수 없어요.');
    if (value.facts.length >= MAX_HISTORY) throw new Error('보관 가능한 사실 이력이 가득 찼어요.');
    if (!previous && value.facts.filter((fact) => fact.active && !fact.supersededBy).length >= MAX_FACTS) throw new Error('현재 사실은 최대 80개예요.');
    const record = { ...proposed, id: proposed.id ?? newId(), active: true, knowledge: normalizeKnowledge(proposed.knowledge) };
    delete record.replacesId;
    if (previous) {
        record.previousId = previous.id;
        previous.active = false;
        previous.supersededBy = record.id;
        previous.endedAtSourceId = Number.isInteger(record.sourceId) ? record.sourceId : null;
    }
    value.facts.push(record);
    return record;
}

export function removeFact(value, id) {
    value.facts = value.facts.filter((fact) => fact.id !== id);
    for (const fact of value.facts) {
        if (fact.previousId === id) delete fact.previousId;
        if (fact.supersededBy === id) delete fact.supersededBy;
    }
}

export function suggestReplacement(value, candidate) {
    if (candidate.replacesId === '') return null;
    const explicit = value.facts.find((fact) => fact.id === candidate.replacesId && fact.active && !fact.supersededBy);
    if (explicit) return explicit.id;
    const entity = String(candidate.entity ?? '').trim().toLocaleLowerCase();
    const attribute = String(candidate.attribute ?? '').trim().toLocaleLowerCase();
    if (!entity || !attribute || !Number.isInteger(candidate.sourceId)) return null;
    const matching = value.facts.filter((fact) => fact.active && !fact.supersededBy
        && String(fact.entity ?? '').trim().toLocaleLowerCase() === entity
        && String(fact.attribute ?? '').trim().toLocaleLowerCase() === attribute
        && Number.isInteger(fact.sourceId) && fact.sourceId < candidate.sourceId);
    return matching.sort((a, b) => b.sourceId - a.sourceId)[0]?.id ?? null;
}

export function buildRelevanceChecks(draft, facts, recent = '') {
    chunksOfDraft(draft);
    const active = facts.filter((fact) => fact.active && !fact.supersededBy).slice(0, MAX_FACTS);
    const batches = [];
    for (let start = 0; start < active.length; start += 20) {
        const batchFacts = active.slice(start, start + 20);
        const questions = {};
        batchFacts.forEach((_fact, index) => {
            questions[`r${index}`] = {
                type: 'noul',
                instructions: `Is the fact at facts[${index}] relevant to any statement in draft, including synonyms, paraphrases, changed states, or information known by a character? Use recent_chat to resolve names and context. Answer yes when relevance is uncertain.`
            };
        });
        batches.push({ state: { draft, recent_chat: recent.slice(-2200), facts: batchFacts.map((fact) => ({ text: fact.text, knowledge: normalizeKnowledge(fact.knowledge), source: fact.sourceText ?? '' })) }, questions, facts: batchFacts });
    }
    return batches;
}

export function selectRelevantFacts(draft, batches, answersByBatch, limit = 16) {
    const scored = [];
    batches.forEach((batch, batchIndex) => {
        const answers = answersByBatch[batchIndex];
        batch.facts.forEach((fact, index) => {
            const answer = answers?.[`r${index}`];
            if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error('Jev 관련 사실 판정 형식을 확인할 수 없어요.');
            scored.push({ fact, score: answer.noul });
        });
    });
    const lexical = new Set(pickFacts(draft, scored.map(({ fact }) => fact), limit).map((fact) => fact.id));
    return scored.filter(({ fact, score }) => score >= .35 || lexical.has(fact.id))
        .sort((a, b) => (b.score + (lexical.has(b.fact.id) ? .1 : 0)) - (a.score + (lexical.has(a.fact.id) ? .1 : 0)))
        .slice(0, limit).map(({ fact }) => fact);
}

export function buildChecks(draft, facts, recent = '', speaker = '') {
    const chunks = chunksOfDraft(draft);
    if (chunks.length > 32) throw new Error('초안 문단이 너무 많아 검수를 중단했어요.');
    const confirmed = facts.filter((fact) => fact?.active && !fact.supersededBy && fact?.text).slice(0, 16);
    const tasks = [];
    chunks.forEach((part, segmentIndex) => {
        for (const fact of confirmed) {
            tasks.push({ segmentIndex, segment: part, fact });
        }
    });
    const batches = [];
    for (let start = 0; start < tasks.length; start += 24) {
        const slice = tasks.slice(start, start + 24);
        const questions = {};
        slice.forEach((item, index) => {
            questions[`q${index}`] = {
                type: 'choice',
                instructions: `Compare candidate_segments[${index}] with established_facts[${index}]. Is there a direct contradiction in the current scene, or does the speaker clearly use information explicitly marked unknown to them? Ignore quoted claims, hypothetical statements, lies in dialogue, flashbacks, omniscient narration, and plausible changes over time. Choose unclear when evidence is insufficient.`,
                criteria: {
                    contradiction: 'A clear, direct incompatibility with the established fact in the same time and scene.',
                    knowledge_leak: 'The speaker clearly acts upon or reveals the fact while their knowledge is explicitly marked unknown; not merely a narrator describing it.',
                    no_conflict: 'No clear contradiction; compatible, unrelated, or a plausible change over time.',
                    unclear: 'Cannot decide from the provided evidence.'
                }
            };
        });
        batches.push({
            state: {
                speaker,
                established_facts: slice.map((item, index) => ({ q: `q${index}`, id: item.fact.id, text: item.fact.text, scope: item.fact.scope, source: item.fact.sourceText ?? '', knowledge: normalizeKnowledge(item.fact.knowledge) })),
                candidate_segments: slice.map((item, index) => ({ q: `q${index}`, segment_id: item.segmentIndex + 1, text: item.segment })),
                recent_chat: recent.slice(-2200)
            },
            questions,
            tasks: slice
        });
    }
    return batches;
}

export function readContradictions(batch, answers, threshold = 0.78) {
    if (!answers || typeof answers !== 'object') throw new Error('Jev 응답에 판정 결과가 없어요.');
    return batch.tasks.flatMap((item, index) => {
        const value = answers[`q${index}`];
        if (!value || value.type !== 'choice' || !['contradiction', 'knowledge_leak', 'no_conflict', 'unclear'].includes(value.choice)) {
            throw new Error('Jev 판정 형식을 확인할 수 없어요.');
        }
        const confidence = Number(value.confidence);
        if (!['contradiction', 'knowledge_leak'].includes(value.choice) || !Number.isFinite(confidence) || confidence < threshold) return [];
        if (value.choice === 'knowledge_leak' && !Object.entries(normalizeKnowledge(item.fact.knowledge)).some(([name, state]) => state === 'unknown' && name.toLocaleLowerCase() === String(batch.state.speaker).trim().toLocaleLowerCase())) return [];
        return [{ segmentIndex: item.segmentIndex, segment: item.segment, fact: item.fact, confidence, kind: value.choice }];
    });
}

export function parseFactCandidates(raw, sourceMessages, existingFacts = []) {
    const text = String(raw ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('사실 후보의 JSON을 읽을 수 없어요. 다시 추출해 주세요.'); }
    if (!Array.isArray(parsed.facts)) throw new Error('사실 후보 형식이 맞지 않아요.');
    const byId = new Map(sourceMessages.map((message) => [message.id, message]));
    return parsed.facts.slice(0, 25).flatMap((fact) => {
        const source = byId.get(Number(fact.sourceId));
        const value = typeof fact.text === 'string' ? fact.text.trim().slice(0, 300) : '';
        if (!source || value.length < 4) return [];
        const previous = existingFacts.find((item) => item.id === fact.replacesId && item.active && !item.supersededBy && (!Number.isInteger(item.sourceId) || item.sourceId < source.id));
        return [{ id: newId(), text: value, sourceId: source.id, sourceText: source.text.slice(0, 350), scope: fact.scope === 'scene' ? 'scene' : 'always', knowledge: normalizeKnowledge(fact.knowledge), entity: String(fact.entity ?? '').trim().slice(0, 60), attribute: String(fact.attribute ?? '').trim().slice(0, 60), replacesId: previous?.id ?? null, active: false }];
    });
}
