// Light formatting for messages: *bold* (or **bold**), _italic_, ~strike~ (or ~~strike~~),
// `code` and ```code blocks```, plus clickable web links. parse() only returns segments; the page
// builds them as DOM nodes, so nothing a person types is ever parsed as HTML.
//
// Segment shapes: { type: 'text' | 'code' | 'pre', text }, { type: 'link', href, text },
// { type: 'bold' | 'italic' | 'strike', children: [...segments] }.

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
// Punctuation that ends a sentence rather than an address. A trailing _ stays, since URLs can end in one.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"*~]+$/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
// Longer markers first, so ** is read before *.
const MARKERS = [['**', 'bold'], ['~~', 'strike'], ['*', 'bold'], ['_', 'italic'], ['~', 'strike']];

export function parse(text) {
    return split(text, /```\n?([\s\S]+?)\n?```/g, (match) => ({ type: 'pre', text: match[1] }), (outside) =>
        split(outside, /`([^`\n]+)`/g, (match) => ({ type: 'code', text: match[1] }), (plain) =>
            links(plain)));
}

// Returns the text without any formatting, for places that show a short preview.
export function plainText(text) {
    return flatten(parse(text));
}

function flatten(segments) {
    return segments.map((segment) => segment.children ? flatten(segment.children) : segment.text).join('');
}

// Cuts out every match of pattern; the text between matches goes through between().
function split(text, pattern, onMatch, between) {
    const out = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > last) out.push(...between(text.slice(last, match.index)));
        out.push(onMatch(match));
        last = match.index + match[0].length;
    }
    if (last < text.length) out.push(...between(text.slice(last)));
    return out;
}

// Web addresses become links and are never formatted inside, so an underscore in a URL stays put.
function links(text) {
    const out = [];
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        const address = match[0].replace(TRAILING_PUNCTUATION, '');
        let href = null;
        try {
            const url = new URL(address);
            if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
        } catch {
            // Not a valid address; it stays as text.
        }
        if (!href) continue;
        if (match.index > last) out.push(...emphasis(text.slice(last, match.index)));
        out.push({ type: 'link', href, text: address });
        last = match.index + address.length;
    }
    if (last < text.length) out.push(...emphasis(text.slice(last)));
    return out;
}

// A marker opens only at the start of a word and closes only at the end of one, on the same line.
// That keeps 2*3*4, snake_case and file_names_like_this as they are.
function emphasis(text, inside = []) {
    const out = [];
    let buffer = '';
    let i = 0;
    while (i < text.length) {
        const found = MARKERS.find(([marker, type]) => !inside.includes(type) && text.startsWith(marker, i) && opens(text, i, marker));
        if (found) {
            const [marker, type] = found;
            const end = closing(text, i, marker);
            if (end > 0) {
                if (buffer) out.push({ type: 'text', text: buffer });
                buffer = '';
                out.push({ type, children: emphasis(text.slice(i + marker.length, end), [...inside, type]) });
                i = end + marker.length;
                continue;
            }
        }
        buffer += text[i];
        i++;
    }
    if (buffer) out.push({ type: 'text', text: buffer });
    return out;
}

function opens(text, i, marker) {
    const before = text[i - 1];
    const after = text[i + marker.length];
    return after !== undefined && !SPACE.test(after) && after !== marker[0] && (before === undefined || (!WORD.test(before) && before !== marker[0]));
}

function closing(text, start, marker) {
    for (let j = start + marker.length + 1; j < text.length; j++) {
        if (text[j] === '\n') return -1;
        if (!text.startsWith(marker, j)) continue;
        const before = text[j - 1];
        const after = text[j + marker.length];
        if (!SPACE.test(before) && before !== marker[0] && (after === undefined || (!WORD.test(after) && after !== marker[0]))) return j;
    }
    return -1;
}
