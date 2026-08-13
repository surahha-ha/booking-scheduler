// 선언/주석류 차단
const DECL_OR_COMMENT_RE = /<\s*!(?:--|doctype)\b|<\s*\?\w+\b/i;

// <tag ...> 에서 tag 이름만 추출
const TAG_TOKEN_RE = /<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b/g;

// 실제 HTML 표준 태그 목록
const HTML_TAGS = new Set([
    'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
    'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
    'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
    'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
    'em', 'embed',
    'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html',
    'i', 'iframe', 'img', 'input', 'ins',
    'kbd',
    'label', 'legend', 'li', 'link',
    'main', 'map', 'mark', 'meta', 'meter',
    'nav', 'noscript',
    'object', 'ol', 'optgroup', 'option', 'output',
    'p', 'param', 'picture', 'pre', 'progress',
    'q',
    'rp', 'rt', 'ruby',
    's', 'samp', 'script', 'section', 'select', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track',
    'u', 'ul',
    'var', 'video',
    'wbr'
]);

export function hasBlockedHtmlTag(input: string): boolean {
    if (!input) return false;

    // 1. <!DOCTYPE, <!--, <?xml 같은 선언류
    if (DECL_OR_COMMENT_RE.test(input)) return true;

    // 2. <tag ...> 형태에서 tag가 HTML 표준이면 차단
    TAG_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = TAG_TOKEN_RE.exec(input)) !== null) {
        const tag = (m[1] ?? '').toLowerCase();
        if (HTML_TAGS.has(tag)) return true;
    }

    return false;
}