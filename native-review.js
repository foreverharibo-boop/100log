// Observe the reply SillyTavern generated. Never generate, append or save one here.
export function createNativeReview({ context, chatKey, review, released = () => {},
    mask = createReplyMask, setTimer = setTimeout }) {
    let pending = null;
    function matches(job) {
        const ctx = context();
        if (pending !== job || job.controller.signal.aborted || chatKey(ctx) !== job.key) return false;
        if (!job.prefix.every((message, index) => ctx.chat[index] === message)) return false;
        if (!job.message) return true;
        return ctx.chat.length === job.index + 1 && ctx.chat[job.index] === job.message
            && job.message.swipe_id === job.swipeId && job.message.mes === job.acceptedText;
    }
    function release(job) {
        job.unmask?.();
        job.controller.signal.removeEventListener('abort', job.onAbort);
        if (pending === job) {
            pending = null;
            if (job.receiving && chatKey(context()) === job.key) context().activateSendButtons?.();
            released(job);
        }
    }
    function cancel() {
        const job = pending;
        if (!job) return;
        job.controller.abort(Object.assign(new Error('답변 검수 중단'), { name: 'AbortError', hundredlogCancelled: true }));
        release(job);
    }
    function arm(job) {
        cancel();
        if (job.controller.signal.aborted) throw job.controller.signal.reason;
        const ctx = context();
        job.index = job.mode === 'swipe' ? ctx.chat.length - 1 : ctx.chat.length;
        job.prefix = ctx.chat.slice(0, job.index);
        job.receiving = false;
        job.validate = () => matches(job);
        job.onAbort = () => release(job);
        pending = job;
        job.controller.signal.addEventListener('abort', job.onAbort, { once: true });
        job.unmask = mask(job.index);
    }
    async function receive(index, type) {
        const job = pending;
        if (!job || job.receiving || index !== job.index || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        if (type && (job.mode === 'swipe') !== (type === 'swipe')) return;
        const ctx = context(), message = ctx.chat[index], stream = ctx.streamingProcessor;
        if (!matches(job) || !message || message.is_user || message.is_system
            || !String(message.mes ?? '').trim() || message.mes === '...'
            || stream?.isStopped || stream?.abortController?.signal.aborted) { cancel(); return; }
        job.receiving = true;
        job.message = message;
        job.swipeId = message.swipe_id;
        job.acceptedText = String(message.mes);
        try { await review(job, message); }
        finally { release(job); }
    }
    function ended() {
        const job = pending;
        if (!job || job.receiving) return;
        // Streaming emits ENDED immediately BEFORE MESSAGE_RECEIVED. Let that
        // awaited receive listener claim the reply before cleaning up a failed send.
        setTimer(() => {
            if (pending !== job || job.receiving) return;
            const stream = context().streamingProcessor;
            if (stream && !stream.isFinished && !stream.isStopped && !stream.abortController?.signal.aborted) return;
            cancel();
        }, 0);
    }
    return { arm, receive, ended, cancel, matches, current: () => pending };
}

export function createReplyMask(index) {
    if (!Number.isInteger(index) || index < 0 || typeof document === 'undefined') return () => {};
    const style = document.createElement('style');
    style.dataset.hundredlogReview = String(index);
    // Collapse only this pending reply, without a placeholder or blank space.
    // Removing this style restores the theme's normal layout after review.
    const selector = `#chat .mes[mesid="${index}"]`;
    style.textContent = `${selector} { display: none !important; }`;
    document.head.append(style);
    return () => style.remove();
}
