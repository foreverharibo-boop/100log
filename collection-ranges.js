// Literal delimiters, never regular expressions. Keep source offsets stable so
// an interrupted/chunked collection cannot resume inside an excluded block.
export function normalizeCollectionRanges(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).flatMap(rule => {
        if (typeof rule?.start !== 'string' || typeof rule?.end !== 'string'
            || !rule.start.trim() || !rule.end.trim() || rule.start.length > 500 || rule.end.length > 500) return [];
        const key = JSON.stringify([rule.start, rule.end]);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ start: rule.start, end: rule.end }];
    }).slice(0, 32);
}

export function stripCollectionRanges(value, rules, preserveLength = false) {
    const text = String(value ?? '');
    const spans = [];
    for (const { start, end } of normalizeCollectionRanges(rules)) {
        let cursor = 0;
        while (cursor < text.length) {
            const from = text.indexOf(start, cursor);
            if (from < 0) break;
            let scan = from + start.length, depth = 1;
            while (depth) {
                const close = text.indexOf(end, scan);
                const open = start === end ? -1 : text.indexOf(start, scan);
                if (close < 0) { scan = text.length; break; }
                if (open >= 0 && open < close) { depth++; scan = open + start.length; }
                else { depth--; scan = close + end.length; }
            }
            spans.push([from, scan]);
            cursor = scan;
        }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [from, to] of spans) {
        const last = merged.at(-1);
        if (last && from <= last[1]) last[1] = Math.max(last[1], to);
        else merged.push([from, to]);
    }
    let out = '', cursor = 0;
    for (const [from, to] of merged) {
        out += text.slice(cursor, from);
        out += preserveLength ? text.slice(from, to).replace(/[^\r\n]/g, ' ') : '\n\n';
        cursor = to;
    }
    return out + text.slice(cursor);
}
