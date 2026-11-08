// Distinguish a loaded chat's copied messages from newly received replies.
// This is transient event state, not a saved collection checkpoint.
export function createCollectionEventGate({ key, signature, visible, windowStart }) {
    let snapshot = null;
    function loaded(ctx) {
        const chat = ctx.chat ?? [];
        const signatures = new Map();
        for (let i = windowStart(chat); i < chat.length; i++) {
            if (visible(chat[i])) signatures.set(i, signature(chat[i]));
        }
        snapshot = { key: key(ctx), length: chat.length, signatures };
    }
    function received(ctx, index, type) {
        const room = key(ctx);
        if (!room || !snapshot || snapshot.key !== room) {
            loaded(ctx);
            return false;
        }
        const message = ctx.chat?.[index];
        if (!Number.isInteger(index) || index < 0 || !visible(message) || message.is_user) return false;
        const current = signature(message);
        const previous = snapshot.signatures.get(index);
        const copied = index < snapshot.length && previous === undefined;
        const changed = previous !== current;
        snapshot.signatures.set(index, current);
        snapshot.length = ctx.chat.length;
        const start = windowStart(ctx.chat);
        for (const id of snapshot.signatures.keys()) if (id < start || id >= ctx.chat.length) snapshot.signatures.delete(id);
        // Greeting/reload notifications never mean an exchange has completed.
        return type !== 'first_message' && !copied && changed;
    }
    return { loaded, received };
}
