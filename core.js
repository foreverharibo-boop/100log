export const MAX_FACTS = 80;
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
    }).sort((a, b) => b.score - a.score).slice(0, limit).map(({ fact }) => fact);
}

export function buildChecks(draft, facts, recent = '') {
    const chunks = chunksOfDraft(draft);
    if (chunks.length > 32) throw new Error('초안 문단이 너무 많아 검수를 중단했어요.');
    const confirmed = facts.filter((fact) => fact?.active && fact?.text).slice(0, MAX_FACTS);
    const tasks = [];
    chunks.forEach((part, segmentIndex) => {
        for (const fact of pickFacts(part, confirmed)) {
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
                instructions: `Check only whether candidate segment ${item.segmentIndex + 1} directly contradicts established fact ${item.fact.id}. Judge what is asserted as true in the scene, not hypotheticals, lies in dialogue, questions, flashbacks, or temporary changes. Choose unclear when context is insufficient.`,
                criteria: {
                    contradiction: 'A clear, direct incompatibility with the established fact in the same time and scene.',
                    no_conflict: 'No clear contradiction; compatible, unrelated, or a plausible change over time.',
                    unclear: 'Cannot decide from the provided evidence.'
                }
            };
        });
        batches.push({
            state: {
                established_facts: slice.map((item, index) => ({ q: `q${index}`, id: item.fact.id, text: item.fact.text, scope: item.fact.scope, source: item.fact.sourceText ?? '' })),
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
        if (!value || value.type !== 'choice' || !['contradiction', 'no_conflict', 'unclear'].includes(value.choice)) {
            throw new Error('Jev 판정 형식을 확인할 수 없어요.');
        }
        const confidence = Number(value.confidence);
        if (value.choice !== 'contradiction' || !Number.isFinite(confidence) || confidence < threshold) return [];
        return [{ segmentIndex: item.segmentIndex, segment: item.segment, fact: item.fact, confidence }];
    });
}

export function parseFactCandidates(raw, sourceMessages) {
    const text = String(raw ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('사실 후보의 JSON을 읽을 수 없어요. 다시 추출해 주세요.'); }
    if (!Array.isArray(parsed.facts)) throw new Error('사실 후보 형식이 맞지 않아요.');
    const byId = new Map(sourceMessages.map((message) => [message.id, message]));
    return parsed.facts.slice(0, 25).flatMap((fact) => {
        const source = byId.get(Number(fact.sourceId));
        const value = typeof fact.text === 'string' ? fact.text.trim().slice(0, 300) : '';
        if (!source || value.length < 4) return [];
        return [{ id: newId(), text: value, sourceId: source.id, sourceText: source.text.slice(0, 350), scope: fact.scope === 'scene' ? 'scene' : 'always', active: false }];
    });
}
