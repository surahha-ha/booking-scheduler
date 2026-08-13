// 전화번호 패턴 (검증 + 포맷 공용)
const PHONE_PATTERNS: { test: RegExp; format: RegExp; replacement: string }[] = [
    {test: /^01[016789]\d{7,8}$/, format: /(01[016789])(\d{3,4})(\d{4})/, replacement: '$1-$2-$3'},
    {test: /^02\d{7,8}$/, format: /(02)(\d{3,4})(\d{4})/, replacement: '$1-$2-$3'},
    {test: /^(15|16|18)\d{6}$/, format: /(\d{4})(\d{4})/, replacement: '$1-$2'},
    {test: /^0\d{2}\d{7,8}$/, format: /(0\d{2})(\d{3,4})(\d{4})/, replacement: '$1-$2-$3'},
];

function isValidPhoneDigits(n: string) {
    return PHONE_PATTERNS.some(p => p.test.test(n));
}

export function formatPhoneNumber(raw = '') {
    const n = raw.replace(/\D/g, '');

    if (n.startsWith('82') && n.length > 2) {
        return '+82-' + formatPhoneNumber(n.slice(2));
    }

    for (const p of PHONE_PATTERNS) {
        if (p.test.test(n)) return n.replace(p.format, p.replacement);
    }

    return n;
}

// 이름에서 첫 단어의 일부 추출
export function extractFirstChars(name = '', length = 1) {
    const firstWord = name.trim().split(/\s+/)[0] ?? '';
    return firstWord.slice(0, length);
}

// 전화번호 유효성
export function isValidPhoneNumber(v: string) {
    const s = (v ?? '').trim();

    // formatter가 만드는 형태들:
    // 010-1234-5678 or 010-123-4567
    // 02-1234-5678 or 02-123-4567
    // 031-1234-5678 or 031-123-4567
    // 1588-1234
    // +82-10-1234-5678 / +82-2-1234-5678
    const re =
        /^(?:\+82-(?:1[016789]-\d{3,4}-\d{4}|2-\d{3,4}-\d{4}|(?:\d{2})-\d{3,4}-\d{4})|01[016789]-\d{3,4}-\d{4}|02-\d{3,4}-\d{4}|0\d{2}-\d{3,4}-\d{4}|(?:15|16|18)\d{2}-\d{4})$/;

    if (!re.test(s)) return false;

    return isValidPhoneDigits(onlyNumber(s.startsWith('+82-') ? '82' + s.slice(4) : s));
}

// 문자열에서 숫자만 추출
export function onlyNumber(value?: string | null): string {
    return value ? value.replace(/\D/g, '') : '';
}

type IdLike = string | number;

export function normalizeId(v: IdLike | null | undefined): string {
    // 1, "1", " 1 " -> "1"
    // null/undefined -> ""
    return v == null ? '' : String(v).trim();
}

export function labelBlockedReason(reason: string) {
    switch (reason) {
        case 'closedDate':
        case 'closedWeekday':
            return '휴무일';
        case 'outsideHours':
            return '운영종료 시간';
        case 'lunch':
            return '휴게시간1';
        case 'dinner':
            return '휴게시간2';
        case 'blockedTime':
            return '휴게시간';
        default:
            return '';
    }
}