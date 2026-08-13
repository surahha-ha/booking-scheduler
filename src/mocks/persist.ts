// ============================================================================
// 로컬 저장소 영속화 (localStorage)
// ----------------------------------------------------------------------------
// 스키마 버전을 키에 넣는다 — 구조가 바뀌면 키가 달라져 자동으로 시드에서 새로 시작한다.
// (마이그레이션을 짜지 않기 위한 의도적 선택)
// ============================================================================
const KEY = 'booking-scheduler:db:v2';

/** 5MB 한도의 80% — 넘으면 경고만 하고 저장은 계속한다. */
const WARN_BYTES = 4 * 1024 * 1024;

function hasStorage(): boolean {
    try {
        return typeof localStorage !== 'undefined';
    }
    catch {
        return false;
    }
}

const KEY_PREFIX = 'booking-scheduler:db:';

/** 이전 스키마 버전의 저장분을 지운다 — 남겨두면 한도(약 5MB)만 잡아먹는다. */
function dropStaleVersions(): void {
    try {
        Object.keys(localStorage)
            .filter((k) => k.startsWith(KEY_PREFIX) && k !== KEY)
            .forEach((k) => localStorage.removeItem(k));
    }
    catch { /* 무시 */ }
}

export function loadDb<T = unknown>(): T | null {
    if (!hasStorage()) return null;
    try {
        dropStaleVersions();
        const raw = localStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as T) : null;
    }
    catch (e) {
        console.warn('[저장소] 불러오기 실패 — 시드로 시작한다', e);
        return null;
    }
}

export function saveDb(snapshot: unknown): void {
    if (!hasStorage()) return;
    try {
        const json = JSON.stringify(snapshot);
        if (json.length > WARN_BYTES) {
            console.warn(
                `[저장소] 데이터가 ${(json.length / 1024 / 1024).toFixed(1)}MB 로 커졌다. `
                + '브라우저 한도(약 5MB)에 근접하면 IndexedDB 로 옮겨야 한다.',
            );
        }
        localStorage.setItem(KEY, json);
    }
    catch (e) {
        // QuotaExceededError 등 — 앱은 계속 동작하되(메모리 상태 유지) 저장만 실패한다.
        console.error('[저장소] 저장 실패 — 이번 변경은 새로고침 시 사라진다', e);
    }
}

export function clearDb(): void {
    if (!hasStorage()) return;
    try {
        localStorage.removeItem(KEY);
    }
    catch { /* 무시 */ }
}
