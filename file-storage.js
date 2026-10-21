// SillyTavern's authenticated, per-user files directory. No RP data in settings.json.
export const FILE_NAME = '100log-data-v1.json';
export const FILE_URL = `/user/files/${FILE_NAME}`;
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const serial = value => JSON.stringify(value);
const fail = code => Object.assign(new Error(code), { storageCode: code });
function decode(value) {
    if (!object(value) || value.format !== '100LOG' || value.schema !== 1 || typeof value.revision !== 'string'
        || !object(value.data) || !object(value.data.characterStores ?? {})) throw fail('invalid_file');
    return value;
}
function replace(target, source) {
    // Keep references held by the UI/current collection alive.
    for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
    for (const [key, value] of Object.entries(source)) {
        if (Object.hasOwn(target, key) && object(value) && object(target[key])) replace(target[key], value);
        else Object.defineProperty(target, key, { value: clone(value), enumerable: true, writable: true, configurable: true });
    }
}
function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}

export function createFileStorage({ request = fetch, headers = () => ({}), compact = () => {}, prepare = async () => {}, changed = () => {}, wasMigrated = () => false, markMigrated = () => {} } = {}) {
    let data = null, baseline = '', revision = null, tail = Promise.resolve(), failure = null, unverified = null;
    const notify = error => { failure = error || null; changed(failure); };
    async function timedRequest(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try { return await request(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); }
    }
    async function read() {
        const response = await timedRequest(`${FILE_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
        if (response.status === 404) return null;
        if (!response.ok) throw Object.assign(fail('read_failed'), { status: response.status });
        let body;
        try { body = await response.json(); } catch { throw fail('invalid_file'); }
        return decode(body);
    }
    async function write(candidate, expected) {
        // Never silently overwrite a revision from a different browser/device.
        const before = await read();
        if (unverified && serial(before) === serial(unverified)) {
            // Upload succeeded but its read-back was interrupted. Recognize only our exact write.
            revision = before.revision; baseline = serial(before.data); expected = revision; unverified = null;
            if (serial(candidate) === baseline) return;
        }
        if ((before?.revision ?? null) !== expected) throw fail('conflict');
        const envelope = { format: '100LOG', schema: 1,
            revision: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, data: candidate };
        unverified = envelope;
        const response = await timedRequest('/api/files/upload', { method: 'POST', credentials: 'same-origin', headers: headers(),
            body: JSON.stringify({ name: FILE_NAME, data: base64(serial(envelope)) }) });
        if (!response.ok) throw Object.assign(fail('write_failed'), { status: response.status });
        // A 200 alone is not a completed migration. Verify the actual stored bytes/data.
        const verified = await read();
        if (!verified || serial(verified) !== serial(envelope)) throw fail('verify_failed');
        revision = verified.revision; baseline = serial(candidate); unverified = null;
    }
    const enqueue = action => {
        const pending = tail.then(action).then(result => { notify(null); return result; }, error => { notify(error); throw error; });
        tail = pending.catch(() => {});
        return pending;
    };
    return {
        get value() { if (!data) throw fail('not_ready'); return data; },
        get error() { return failure; },
        get ready() { return data !== null; },
        get dirty() { return data !== null && serial(data) !== baseline; },
        init(legacy) { return enqueue(async () => {
            if (data) return data;
            const remote = await read();
            if (!remote && wasMigrated()) throw fail('missing_file');
            const candidate = clone(remote?.data ?? legacy ?? { enabled: false });
            await prepare(candidate); compact(candidate);
            if (!remote || serial(candidate) !== serial(remote.data)) await write(candidate, remote?.revision ?? null);
            else { revision = remote.revision; baseline = serial(candidate); }
            data = candidate;
            try { markMigrated(); } catch { /* Optional account-local missing-file guard. */ }
            return data;
        }); },
        save() { return enqueue(async () => {
            if (!data) throw fail('not_ready');
            compact(data);
            const candidate = clone(data);
            if (serial(candidate) === baseline) {
                if (failure) {
                    const remote = await read();
                    if (!remote) throw fail('missing_file');
                    if (remote.revision !== revision || serial(remote.data) !== baseline) throw fail('conflict');
                }
                return;
            }
            await write(candidate, revision);
        }); },
        refresh() { return enqueue(async () => {
            if (!data) throw fail('not_ready');
            compact(data);
            if (serial(data) !== baseline) await write(clone(data), revision);
            const remote = await read();
            if (!remote) throw fail('missing_file');
            if (remote.revision !== revision) {
                if (serial(data) !== baseline) throw fail('conflict'); // UI edited while the read was in flight.
                replace(data, remote.data); revision = remote.revision; baseline = serial(data);
                compact(data);
            }
        }); },
    };
}
