import { recentWindowStart, isVisibleChatMessage } from './core.js?v=1.10.19';
import { messageSignature } from './memory-engine.js?v=1.10.19';
import { selectedMemoryStore } from './memory-scope.js?v=1.10.19';

const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined;

// Only reuse a verified, already collected prefix in the same memory store.
// No facts, source ownership, rollback changes, or scope settings are copied.
export function inheritBranchProgress(value, state, ctx, { created = false } = {}) {
    const parentId = ctx.chatMetadata?.main_chat;
    const chatId = String(ctx.chatId ?? '');
    const chat = ctx.chat;
    if (!state || state.branchProgress || typeof parentId !== 'string' || !parentId || parentId === chatId
        || !Array.isArray(chat) || !chat.length || ctx.groupId) return false;
    if (selectedMemoryStore(value, parentId) !== value || selectedMemoryStore(value, chatId) !== value) return false;
    // Never undo a reset or a branch's own collection, including a failed/manual run.
    if (value.memoryResetAt && (value.memoryResetVersion !== 2 || !created)) return false;
    const start = recentWindowStart(chat);
    const previous = state.autoMemory;
    const previousCursor = previous?.cursor ?? state.extractionCursor ?? 0;
    if ((previousCursor !== 0 && previousCursor !== start) || (previous?.offset ?? state.extractionOffset ?? 0)
        || previous?.journal?.length || previous?.undoGroup) return false;
    const parent = own(value.chats, parentId)?.autoMemory;
    if (!parent || !Number.isSafeInteger(parent.cursor) || parent.cursor < 0
        || !Number.isSafeInteger(parent.offset ?? 0) || (parent.offset ?? 0) < 0
        || !Array.isArray(parent.journal)) return false;

    const signatures = new Map();
    for (const entry of parent.journal) for (const source of entry.sources ?? []) {
        if (Number.isSafeInteger(source.id) && typeof source.signature === 'string') signatures.set(source.id, source.signature);
    }
    const end = Math.min(parent.cursor, chat.length);
    const journal = [];
    let cursor = start, offset = 0, pending = [];
    function track(id, signature) {
        pending.push({ id, signature });
        if (isVisibleChatMessage(chat[id])) {
            journal.push({ sources: pending, start: pending[0].id, offset: 0, changes: [] });
            pending = [];
        }
    }
    // Hidden messages do not need AI collection. Visible messages must match the
    // signatures recorded at collection time, not merely today's parent text.
    while (cursor < end) {
        const signature = messageSignature(chat[cursor]);
        if (isVisibleChatMessage(chat[cursor]) && signatures.get(cursor) !== signature) break;
        track(cursor, signature);
        cursor++;
    }
    if (cursor === parent.cursor && cursor < chat.length && parent.offset > 0
        && isVisibleChatMessage(chat[cursor]) && signatures.get(cursor) === messageSignature(chat[cursor])
        && parent.offset < chat[cursor].mes.trim().length) {
        offset = parent.offset;
        track(cursor, messageSignature(chat[cursor]));
    }
    if (pending.length) {
        if (journal.length) journal.at(-1).sources.push(...pending);
        else journal.push({ sources: pending, start: pending[0].id, offset: 0, changes: [] });
    }
    state.autoMemory = { cursor, offset, journal };
    state.extractionCursor = cursor;
    state.extractionOffset = offset;
    // Attempt only once: later parent progress must not jump over work in this branch.
    state.branchProgress = { version: 1, parentChatId: parentId };
    return true;
}
