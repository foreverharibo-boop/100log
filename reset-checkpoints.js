// Read-only server snapshot used only by the explicit character-wide reset.
// No RP text is sent to an AI or retained in the resulting checkpoint list.
export async function captureCharacterRoomLengths(ctx, request = (...args) => fetch(...args), { excludedRoomIds = [] } = {}) {
    const avatar = ctx.characters?.[ctx.characterId]?.avatar;
    const currentId = String(ctx.chatId ?? '');
    if (!avatar || !currentId || ctx.groupId || !Array.isArray(ctx.chat)) throw new Error('캐릭터의 채팅을 먼저 열어 주세요.');
    const length = ctx.chat.length;
    const excluded = new Set(excludedRoomIds);
    const last = JSON.stringify(ctx.chat.at(-1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    async function post(url, body) {
        const response = await request(url, { method: 'POST', signal: controller.signal, credentials: 'same-origin',
            headers: ctx.getRequestHeaders(), body: JSON.stringify(body) });
        if (!response.ok) throw new Error('채팅 위치 확인 실패 (' + response.status + '). 기억을 삭제하지 않았어요.');
        return response.json();
    }
    try {
        const rooms = await post('/api/characters/chats', { avatar_url: avatar, simple: true });
        if (!Array.isArray(rooms) || !rooms.every(room => typeof room?.file_id === 'string' && room.file_id
            && room.file_name === room.file_id + '.jsonl')) throw new Error('채팅 목록을 확인하지 못해 기억을 삭제하지 않았어요.');
        const ids = [...new Set(rooms.map(room => room.file_id))].filter(id => id !== currentId && !excluded.has(id));
        const checkpoints = new Array(ids.length);
        let next = 0;
        // Bound parallel reads for Termux servers. All must succeed before any deletion.
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
            while (next < ids.length) {
                const index = next++, id = ids[index];
                const chat = await post('/api/chats/get', { avatar_url: avatar, file_name: id });
                if (!Array.isArray(chat)) throw new Error('채팅 내용을 확인하지 못해 기억을 삭제하지 않았어요.');
                // ST stores a metadata header before messages; it is not a message index.
                const header = chat[0];
                const hasHeader = header && typeof header === 'object' && !Array.isArray(header)
                    && !Object.hasOwn(header, 'mes')
                    && ['chat_metadata', 'user_name', 'character_name', 'create_date'].some(key => Object.hasOwn(header, key));
                const messages = hasHeader ? chat.slice(1) : chat;
                if (!messages.every(message => message && typeof message === 'object' && typeof message.mes === 'string'))
                    throw new Error('채팅 형식을 확인하지 못해 기억을 삭제하지 않았어요.');
                checkpoints[index] = [id, messages.length];
            }
        }));
        if (ctx.chat.length !== length || JSON.stringify(ctx.chat.at(-1)) !== last)
            throw new Error('위치 확인 중 현재 대화가 바뀌었어요. 삭제하지 않았으니 다시 시도해 주세요.');
        if (!excluded.has(currentId)) checkpoints.push([currentId, length]);
        return checkpoints;
    } finally { clearTimeout(timer); controller.abort(); }
}

export function captureSharedRoomLengths(ctx, root, request) {
    const excludedRoomIds = Object.entries(root?.chatMemoryScopes ?? {})
        .filter(([, scope]) => scope?.independent).map(([id]) => id);
    return captureCharacterRoomLengths(ctx, request, { excludedRoomIds });
}
