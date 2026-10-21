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

export function memoryCopySources(root, currentChatId) {
    if (!root) return [];
    const sources = [{ key: 'shared', label: '이 캐릭터의 공용 기억', store: root, shared: true }];
    const ids = new Set([...Object.keys(root.chats ?? {}), ...Object.keys(root.chatMemoryScopes ?? {})]);
    for (const id of ids) {
        if (id === String(currentChatId)) continue;
        const scope = roomScope(root, id);
        const shared = !scope?.independent;
        const store = selectedMemoryStore(root, id);
        if (store) sources.push({ key: `room:${id}`, label: `${id} · ${shared ? '공용 기억' : '독립 기억'}`, store, shared });
    }
    return sources;
}

