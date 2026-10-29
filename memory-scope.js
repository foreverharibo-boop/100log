// Character memories stay shared by default. A room may opt into its own store.
// Copy only memory data: never copy the scope registry or another room's journal.
const clone = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

export function roomScope(root, chatId) {
    return own(root?.chatMemoryScopes, String(chatId));
}

export function selectedMemoryStore(root, chatId) {
    const scope = roomScope(root, chatId);
    return scope?.independent ? scope.store : root;
}

function freshState(length) {
    const cursor = Math.max(0, Number.isInteger(length) ? length : 0);
    return { extractionCursor: cursor, extractionOffset: 0, autoMemory: { cursor, offset: 0, journal: [] } };
}

export function copiedMemoryStore(root, source, chatId, length) {
    const result = { version: 2, uuid: root.uuid, facts: [], candidates: [], chats: {} };
    // Fact IDs and their internal links are scoped to this independently cloned store.
    for (const key of ['facts', 'candidates', 'nameAliases', 'aliasSuggestions', 'collectionPreferences', 'rejectedMemories']) {
        if (source?.[key] !== undefined) result[key] = clone(source[key]);
    }
    put(result.chats, String(chatId), freshState(length));
    return result;
}

export function separateRoomMemory(root, chatId, length, source = null) {
    if (!root || !chatId) throw new Error('채팅을 먼저 열어 주세요.');
    const store = copiedMemoryStore(root, source, chatId, length);
    root.chatMemoryScopes ??= {};
    put(root.chatMemoryScopes, String(chatId), { independent: true, store });
    return store;
}

export function resetRoomMemory(root, chatId, length) {
    const previous = selectedMemoryStore(root, chatId);
    const store = separateRoomMemory(root, chatId, length);
    // Collection preferences are settings, not memories. Preserve only these.
    if (previous?.collectionPreferences) store.collectionPreferences = clone(previous.collectionPreferences);
    return store;
}

export function resetCharacterMemory(root, chatId, length, roomLengths = []) {
    if (!root || !chatId) throw new Error('캐릭터의 채팅을 먼저 열어 주세요.');
    const checkpoints = new Map(roomLengths);
    checkpoints.set(String(chatId), length);
    for (const [id, count] of checkpoints) if (typeof id !== 'string' || !id || !Number.isSafeInteger(count) || count < 0)
        throw new Error('채팅의 마지막 위치를 확인하지 못해 삭제하지 않았어요.');
    const resetAt = Date.now();
    const empty = source => {
        const store = { version: 2, uuid: root.uuid, facts: [], candidates: [], chats: {}, memoryResetAt: resetAt, memoryResetVersion: 2 };
        if (source?.collectionPreferences) store.collectionPreferences = clone(source.collectionPreferences);
        return store;
    };
    const replacement = empty(root);
    // Preserve each room's independent/shared routing and collection preferences,
    // but no facts, evidence, embeddings, aliases, reports or undo snapshots.
    for (const [id, scope] of Object.entries(root.chatMemoryScopes ?? {})) {
        if (!scope?.independent) continue;
        replacement.chatMemoryScopes ??= {};
        put(replacement.chatMemoryScopes, id, { independent: true, store: empty(scope.store) });
    }
    for (const [id, count] of checkpoints) put(selectedMemoryStore(replacement, id).chats, id, freshState(count));
    // Keep the character store identity held by the UI and active scope checks.
    for (const key of Object.keys(root)) delete root[key];
    for (const [key, value] of Object.entries(replacement)) put(root, key, value);
    return selectedMemoryStore(root, chatId);
}

export function resetSharedMemory(root, chatId, length, roomLengths = []) {
    if (!root || !chatId) throw new Error('캐릭터의 채팅을 먼저 열어 주세요.');
    const checkpoints = new Map(roomLengths);
    if (!roomScope(root, chatId)?.independent) checkpoints.set(String(chatId), length);
    for (const [id, count] of checkpoints) if (typeof id !== 'string' || !id || !Number.isSafeInteger(count) || count < 0)
        throw new Error('채팅의 마지막 위치를 확인하지 못해 삭제하지 않았어요.');
    const replacement = { version: 2, uuid: root.uuid, facts: [], candidates: [], chats: {},
        memoryResetAt: Date.now(), memoryResetVersion: 2 };
    if (root.collectionPreferences) replacement.collectionPreferences = clone(root.collectionPreferences);
    // Retain independent stores and their journals/cursors by reference, unchanged.
    if (root.chatMemoryScopes !== undefined) replacement.chatMemoryScopes = root.chatMemoryScopes;
    for (const [id, count] of checkpoints) {
        if (!roomScope(root, id)?.independent) put(replacement.chats, id, freshState(count));
    }
    for (const key of Object.keys(root)) delete root[key];
    for (const [key, value] of Object.entries(replacement)) put(root, key, value);
    return root;
}

export function memoryCopySources(root, currentChatId) {
    if (!root) return [];
    const sources = [{ key: 'shared', label: '이 캐릭터의 공용 기억', store: root, shared: true }];
    const ids = new Set([...Object.keys(root.chats ?? {}), ...Object.keys(root.chatMemoryScopes ?? {})]);
    for (const id of ids) {
        if (id === String(currentChatId)) continue;
        const scope = roomScope(root, id);
        // All shared rooms point to root, already listed once above.
        if (!scope?.independent || !scope.store) continue;
        sources.push({ key: `room:${id}`, label: `${id} · 독립 기억`, store: scope.store, shared: false });
    }
    return sources;
}

