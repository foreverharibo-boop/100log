// Retain useful current memories, not a second permanent RP archive.
const current = fact => !fact.archived && !fact.supersededBy;
const protectedFact = fact => fact.pinned || fact.origin !== 'auto';
export function shortSignature(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) { const n = text.charCodeAt(i); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return `h1:${text.length}:${a >>> 0}:${b >>> 0}`;
}
export function boundJournal(auto) {
    if (!auto || !Array.isArray(auto.journal)) return;
    // Older entries keep only small source signatures for edited/swiped-message detection.
    const last = [...auto.journal].reverse().find(entry => entry.changes?.length && !entry.undoneAt);
    auto.journal = auto.journal.slice(-100).map(entry => ({
        sources: (entry.sources ?? []).map(({ id, signature }) => ({ id, signature })),
        start: entry.start, offset: entry.offset, group: entry.group,
        changes: entry === last ? entry.changes : [],
        ...(entry.undoneAt ? { undoneAt: entry.undoneAt } : {}),
    }));
}
export function compactMemoryStore(value) {
    if (!value || typeof value !== 'object') return;
    value.facts = (value.facts ?? []).filter(fact => current(fact) || protectedFact(fact));
    for (const row of value.rejectedMemories ?? []) if (row.sourceSignature) delete row.sourceText;
    value.candidates = []; // Obsolete approval queue; automatic collection has replaced it.
    const ids = new Set(value.facts.map(fact => fact.id));
    for (const fact of value.facts) {
        if (fact.previousId && !ids.has(fact.previousId)) delete fact.previousId;
        if (fact.supersededBy && !ids.has(fact.supersededBy)) delete fact.supersededBy;
    }
    for (const state of Object.values(value.chats ?? {})) {
        boundJournal(state?.autoMemory);
        for (const entry of state?.autoMemory?.journal ?? []) for (const change of entry.changes) for (const snapshot of [change.before, change.after]) {
            if (!snapshot) continue;
            if (snapshot.previousId && !ids.has(snapshot.previousId)) delete snapshot.previousId;
            if (snapshot.supersededBy && !ids.has(snapshot.supersededBy)) delete snapshot.supersededBy;
        }
    }
    if (value.autoMemory) boundJournal(value.autoMemory);
    if (typeof value.lastCleanupSignature === 'string' && !value.lastCleanupSignature.startsWith('h1:')) value.lastCleanupSignature = shortSignature(value.lastCleanupSignature);
    if (value.embeddingIndex?.entries) for (const id of Object.keys(value.embeddingIndex.entries)) if (!ids.has(id)) delete value.embeddingIndex.entries[id];
    for (const key of ['cleanupWarnings', 'cleanupConflicts']) if (Array.isArray(value[key])) value[key] = value[key].filter(row => row.ids?.every(id => ids.has(id)));
    for (const scope of Object.values(value.chatMemoryScopes ?? {})) if (scope?.store) compactMemoryStore(scope.store);
}
export function compactConfig(config) {
    for (const value of Object.values(config.characterStores ?? {})) compactMemoryStore(value);
}
export function forgetFactCopies(value, id, text) {
    if (value.embeddingIndex?.entries) delete value.embeddingIndex.entries[id];
    for (const state of [...Object.values(value.chats ?? {}), value]) {
        if (state.autoMemory?.journal) for (const entry of state.autoMemory.journal) {
            entry.changes = (entry.changes ?? []).filter(change => change.id !== id);
            for (const change of entry.changes) for (const snapshot of [change.before, change.after]) {
                if (!snapshot) continue;
                if (snapshot.previousId === id) delete snapshot.previousId;
                if (snapshot.supersededBy === id) delete snapshot.supersededBy;
            }
        }
        // Reports may contain excerpts of a removed fact. They are disposable UI data.
        delete state.lastReview;
        if (state.collectionExclusions?.items) state.collectionExclusions.items = state.collectionExclusions.items.filter(row => row.id !== id && row.text !== text && row.targetId !== id && row.existingId !== id && row.savedId !== id);
    }
    delete value.lastCleanupSignature;
    for (const key of ['cleanupWarnings', 'cleanupConflicts']) if (value[key]) value[key] = value[key].filter(row => !row.ids?.includes(id));
}
export function forgetRoomProgress(root, chatId) {
    // Shared facts remain useful to other rooms even when their source room was deleted.
    delete root.chats?.[chatId];
    for (const scope of Object.values(root.chatMemoryScopes ?? {})) if (scope?.store) {
        delete scope.store.chats?.[chatId];
        scope.store.rejectedMemories = (scope.store.rejectedMemories ?? []).filter(row => row.sourceChatId !== chatId);
    }
    root.rejectedMemories = (root.rejectedMemories ?? []).filter(row => row.sourceChatId !== chatId);
}
export async function pruneDeletedRoomProgress(config, listRooms, currentChatId = '') {
    for (const [key, root] of Object.entries(config.characterStores ?? {})) {
        const avatar = config.characterIdentityRegistry?.records?.[root.uuid ?? key.replace(/^uuid:/, '')]?.avatar;
        if (!avatar) continue;
        let rooms;
        try { rooms = await listRooms(avatar); } catch { continue; }
        // Only the simple endpoint returns raw filenames, including unreadable chat files.
        // Older versions/error objects are NOT authoritative lists.
        if (!Array.isArray(rooms) || !rooms.every(row => typeof row.file_id === 'string' && row.file_name === `${row.file_id}.jsonl`)) continue;
        const live = new Set(rooms.map(row => row.file_id));
        live.add(currentChatId); // The currently open room may not have been saved yet.
        for (const id of Object.keys(root.chats ?? {})) if (!live.has(id)) forgetRoomProgress(root, id);
        for (const scope of Object.values(root.chatMemoryScopes ?? {})) for (const id of Object.keys(scope?.store?.chats ?? {})) if (!live.has(id)) forgetRoomProgress(root, id);
    }
}

export function renameRoom(root, oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    const move = object => {
        if (!object || !Object.hasOwn(object, oldId)) return;
        Object.defineProperty(object, newId, { value: object[oldId], enumerable: true, writable: true, configurable: true });
        delete object[oldId];
    };
    if (root.chatMemoryScopes?.[oldId] && root.chatMemoryScopes?.[newId]) return; // Never overwrite an independent world.
    move(root.chats); move(root.chatMemoryScopes);
    for (const scope of Object.values(root.chatMemoryScopes ?? {})) move(scope.store?.chats);
    const visit = item => {
        if (!item || typeof item !== 'object') return;
        if (item.sourceChatId === oldId) item.sourceChatId = newId;
        for (const value of Object.values(item)) if (value && typeof value === 'object') visit(value);
    };
    visit(root);
}
