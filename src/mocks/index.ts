// ============================================================================
// 로컬 저장소 어댑터 설치 — axios adapter 를 교체해 브라우저 안에서 API 를 처리한다
// ----------------------------------------------------------------------------
// useApi() 가 반환하는 axios 싱글턴의 adapter 를 교체한다.
//  - adapter 는 요청의 종착점 → 실제 네트워크 대신 mock payload 를 즉시 반환.
//  - 공통 응답 인터셉터가 response.data 를 벗겨 ApiResponse 로 넘기므로
//    여기서는 { data: <ApiResponse 봉투>, status: 200 } 형태만 만들어주면 된다.
//  - *Api.ts / store 는 한 줄도 수정하지 않는다(중앙 가로채기).
// ============================================================================
import {useApi} from '@/lib/http';
import {routes, type MockCtx} from './routes';
import * as db from './db';

const SUCCEED = 'succeed';

/** '/api/booking/...' 기준으로 경로 정규화 (baseURL·호스트·쿼리 제거) */
function normalizePath(config: any): string {
    const raw = `${config.baseURL ?? ''}${config.url ?? ''}`;
    const noQuery = raw.split('?')[0];
    const idx = noQuery.indexOf('/api/booking/');
    if (idx >= 0) return noQuery.slice(idx);
    // '/api/booking' 로 끝나는 경우(book 목록 등 하위 없음)도 커버
    const tail = noQuery.indexOf('/api/booking');
    return tail >= 0 ? noQuery.slice(tail) : noQuery;
}

/** 패턴('/api/booking/:id/delete')과 실제 경로를 매칭 → path 변수 추출(불일치 시 null) */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
    const ps = pattern.split('/').filter(Boolean);
    const xs = path.split('/').filter(Boolean);
    if (ps.length !== xs.length) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(':')) out[ps[i].slice(1)] = decodeURIComponent(xs[i]);
        else if (ps[i] !== xs[i]) return null;
    }
    return out;
}

/** config.data(직렬화된 문자열/객체) → JS 객체 */
function parseBody(data: any): any {
    if (data == null) return undefined;
    if (typeof data !== 'string') return data;
    try {
        return JSON.parse(data);
    } catch {
        return data; // text/plain 등
    }
}

/**
 * ⚠️ 공통 응답 인터셉터는 body 에 status·code·message 가 "모두" 있으면
 *    내용물을 body.data 에서 꺼내 반환한다(우리 store 는 res.data.payload 를 기대 → 불일치로 파손).
 *    실제 서버 응답 봉투처럼 셋 중 하나(status)를 비워 인터셉터를 bail 시켜 raw 응답을 그대로 흘린다.
 *    => ['status','code','message'].every(k => k in envelope) 는 반드시 false 여야 한다.
 */
export function mockEnvelope(payload: any) {
    return {code: SUCCEED, message: 'OK', payload};
}

function buildResponse(config: any, payload: any) {
    return {
        data: mockEnvelope(payload),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
    };
}

/** 실제 라우팅 — 매칭되면 payload 반환, 아니면 null(경고) */
function route(config: any): any {
    const method = String(config.method ?? 'get').toUpperCase();
    const path = normalizePath(config);
    for (const r of routes) {
        if (r.method !== method) continue;
        const pathParams = matchPattern(r.pattern, path);
        if (!pathParams) continue;
        const ctx: MockCtx = {
            params: config.params ?? {},
            body: parseBody(config.data),
            pathParams,
        };
        return {matched: true, payload: r.handle(ctx)};
    }
    return {matched: false, payload: null};
}

const LATENCY_MS = 120; // 실제 네트워크 흉내(로딩 스피너 확인용)

/** axios adapter — config → mock AxiosResponse. useApi 인스턴스에 주입해 네트워크를 대체한다. */
export function createMockAdapter(opts: {latencyMs?: number; log?: boolean} = {}) {
    const latency = opts.latencyMs ?? LATENCY_MS;
    const log = opts.log ?? true;
    return (config: any) =>
        new Promise((resolve) => {
            const {matched, payload} = route(config);
            // 쓰기 요청(비-GET)은 처리 후 통째로 영속화한다.
            // 변경 지점을 하나씩 훅킹하지 않아 누락이 없다.
            const method = String(config.method ?? 'get').toUpperCase();
            if (matched && method !== 'GET') db.saveSnapshot();
            if (log) {
                if (!matched) {
                    // 미등록 엔드포인트도 네트워크 오류 대신 빈 성공으로 — 화면 깨짐 방지
                    console.warn('[mock] ⚠ 미등록:', String(config.method).toUpperCase(), normalizePath(config));
                } else {
                    const n = Array.isArray(payload) ? `[${payload.length}]` : (payload == null ? 'null' : 'obj');
                    console.info('[mock]', String(config.method).toUpperCase(), normalizePath(config), '→', n);
                }
            }
            const finish = () => resolve(buildResponse(config, payload));
            if (latency > 0) setTimeout(finish, latency);
            else finish();
        });
}

export function installMockAdapter() {
    const api: any = useApi();
    api.defaults.adapter = createMockAdapter();

    // 데모·개발용 초기화 수단 — 콘솔에서 `resetSeed()` 로 저장분을 버리고 시드 상태로 되돌린다.
    if (typeof window !== 'undefined') {
        (window as any).resetSeed = db.resetToSeed;
    }

    console.info(
        '%c[저장소] 브라우저 로컬 저장소로 구동 중 — 초기화하려면 콘솔에서 resetSeed()',
        'color:#2f6fed;font-weight:bold',
    );
}

/**
 * dev 부분 mock 대상 — WAS 가 외부 시스템을 "직접" 호출해 dev 미비 시 실패하는 것만.
 *
 * <p>GET /staff 는 넣지 않는다. 자체 DB(담당자 테이블) 조회이고 외부 연동은 테이블이 빌 때만
 * self-heal 로 쓰이며 실패해도 graceful 이다(StaffService#getMedicalStaffList). mock 하면 실제 담당자가
 * 가짜로 덮여 실제 예약이 어느 칼럼에도 매칭되지 않는다 — 매칭 키가 이름 스냅샷(staffName)이기 때문.
 */
const EXTERNAL_ROUTES = new Set([
    'POST /api/booking/v1/staff/sync',   // 외부 담당자 정보 조회
    'GET /api/booking/v1/work-state',   // 운영중 상태 조회
    'PUT /api/booking/v1/work-state/modify', // 운영중 상태 저장
]);

/**
 * dev 부분 mock — 위 3건만 임시데이터로 돌리고 자체 API 는 실제 WAS 로 나간다.
 *
 * <p>adapter 를 통째로 갈아끼우는 {@link installMockAdapter} 와 달리 request 인터셉터에서
 * 대상 요청에만 config.adapter 를 심는다. 나머지는 config.adapter 가 없으므로 axios 가
 * 기본 어댑터(실제 네트워크)를 그대로 고른다 — 실어댑터를 붙잡아둘 필요가 없다.
 */
export function installExternalMockAdapter() {
    const api: any = useApi();
    const mock = createMockAdapter();
    api.interceptors.request.use((config: any) => {
        const key = `${String(config.method ?? 'get').toUpperCase()} ${normalizePath(config)}`;
        if (EXTERNAL_ROUTES.has(key)) config.adapter = mock;
        return config;
    });
    console.info('%c[mock] dev 부분 모드 — 외부 연동(담당자 마스터 동기화·사업장 설정 운영중)만 임시데이터, 자체 API 는 실호출', 'color:#e67e22;font-weight:bold');
}
