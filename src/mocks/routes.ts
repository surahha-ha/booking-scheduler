// ============================================================================
// Mock 라우트 테이블 — (method + path) → payload 핸들러
// ----------------------------------------------------------------------------
// 실제 *Api.ts 가 호출하는 URL(예: '/api/booking/v1/staff')을 그대로 매칭한다.
// baseURL('/api' 등) 접두는 index.ts 에서 '/api/booking' 기준으로 정규화해 넘겨준다.
// 핸들러는 payload(봉투 안 내용물)만 반환하고, ApiResponse 봉투는 index.ts 가 씌운다.
// ============================================================================
import * as db from './db';
import type {BookItem} from '@/api/bookApi';
import type {SiteHolidayHours} from '@/api/siteApi';

export interface MockCtx {
    /** GET 쿼리 파라미터 (axios config.params) */
    params: Record<string, any>;
    /** POST/PUT body (JSON 파싱됨, 아니면 원문 문자열) */
    body: any;
    /** path 변수 (예: :id) */
    pathParams: Record<string, string>;
}

export interface MockRoute {
    method: string;
    pattern: string; // '/api/booking/...' — ':name' 은 path 변수
    handle: (_ctx: MockCtx) => any;
}

// 상태 단어 → 코드 매핑 (updateStatus / modifyAppointmentState)
function toStatusCode(state: string): {status?: string; delYn?: 'Y'} {
    switch ((state || '').toLowerCase()) {
        case 'complete': return {status: '01'};
        case 'waiting': return {status: '05'};
        case 'cancel': return {status: '03'};
        case 'noshow': case 'undone': return {status: '02'};
        case 'delete': return {delYn: 'Y'};
        case 'default_': case 'restore': return {status: '00'};
        default: return /^\d{2}$/.test(state) ? {status: state} : {};
    }
}

function findReservation(id: string): BookItem | undefined {
    return db.reservations.find(r => String(r.reservationId) === String(id));
}

// 요청(BookItemRequest) → BookItem 변환
function requestToItem(b: any, existing?: BookItem): BookItem {
    const grp = db.serviceGroups.find(g => g.serviceGroupId === b?.serviceGroupId);
    const item = grp?.items.find(i => i.serviceItemId === b?.serviceItemId);
    return {
        ...(existing ?? {} as BookItem),
        reservationId: existing?.reservationId ?? db.nextNo(),
        tenantId: 'TENANT_MOCK',
        statusCode: b?.state ?? existing?.statusCode ?? '00',
        startAt: b?.startDate ?? existing?.startAt,
        endAt: b?.endDate ?? existing?.endAt,
        externalStaffNo: 0, // name 모드 매칭용 — staffName 로만 컬럼 배정(위 seed 주석 참조). truthy 면 카드 전멸.
        staffName: b?.doctorName ?? existing?.staffName ?? '',
        customerId: b?.customerRefId ?? existing?.customerId ?? db.nextNo(),
        memberYn: existing?.memberYn ?? 'N',
        memberNo: b?.memberNo ?? existing?.memberNo,
        customerPhone: b?.patientPhone ?? existing?.customerPhone ?? '',
        customerName: b?.patientName ?? existing?.customerName ?? '',
        delYn: 'N',
        memo: b?.memo ?? existing?.memo ?? '',
        serviceGroupId: b?.serviceGroupId ?? existing?.serviceGroupId,
        serviceItemId: b?.serviceItemId ?? existing?.serviceItemId,
        serviceGroupName: grp?.serviceGroupName ?? existing?.serviceGroupName ?? null,
        serviceItemName: item?.serviceItemName ?? existing?.serviceItemName ?? null,
        birthDate: existing?.birthDate ?? null,
        sexDivisionCode: existing?.sexDivisionCode ?? null,
        createdAt: existing?.createdAt ?? new Date().toISOString().slice(0, 19),
        externalYn: 'N',
    };
}

export const routes: MockRoute[] = [
    // ── 장부 (book) ──
    {method: 'GET', pattern: '/api/booking/v1/holidays', handle: ({params}) => db.selectNationalHolidays(Number(params.year) || new Date().getFullYear())},
    {method: 'GET', pattern: '/api/booking/recent', handle: ({params}) => {
        const kw = String(params.keyword ?? '');
        return db.reservations
            .filter(r => r.delYn === 'N' && (!kw || r.customerName.includes(kw) || (r.customerPhone ?? '').includes(kw)))
            .slice(0, Number(params.limit) || 10)
            .map(r => ({
                reservationId: r.reservationId, statusCode: r.statusCode,
                startAt: r.startAt, endAt: r.endAt,
                staffName: r.staffName, customerName: r.customerName, customerPhone: r.customerPhone, memberYn: r.memberYn,
                birthDate: r.birthDate ?? null, sexDivisionCode: r.sexDivisionCode ?? null,
            }));
    }},
    // 통계는 "배열" 응답 (FE reduceStatisticsData 가 배열을 reduce). 단일 객체면 .reduce 폭발.
    // 모수는 목록(selectBookGroups)과 동일해야 한다 — 전건 집계하면 화면 밖 예약까지 세어 카드 수와 어긋난다.
    {method: 'GET', pattern: '/api/booking/statistics/member', handle: ({params}) => {
        const live = db.selectBooks(params);
        return [
            {memberYn: 'Y', cnt: live.filter(r => r.memberYn === 'Y').length},
            {memberYn: 'N', cnt: live.filter(r => r.memberYn !== 'Y').length},
        ];
    }},
    {method: 'GET', pattern: '/api/booking/statistics/state', handle: ({params}) => {
        const live = db.selectBooks(params);
        // 상태코드 → FE 라벨(APPOINTMENT/TREATMENT_STATUS_TYPE 값)
        const byLabel: Record<string, string> = {'00': '예약', '03': '취소', '05': '접수대기', '01': '완료', '02': '미이행'};
        const acc = new Map<string, number>();
        for (const label of Object.values(byLabel)) acc.set(label, 0);
        for (const r of live) {
            const label = byLabel[r.statusCode] ?? '예약';
            acc.set(label, (acc.get(label) ?? 0) + 1);
        }
        return [...acc.entries()].map(([name, cnt]) => ({name, cnt}));
    }},
    {method: 'GET', pattern: '/api/booking/v2/schedule/unassigned-reservations', handle: () => ({assignable: false})},
    {method: 'POST', pattern: '/api/booking/v2/schedule/assign-unassigned', handle: () => ({updated: 0})},
    {method: 'POST', pattern: '/api/booking/add', handle: ({body}) => {
        const item = requestToItem(body);
        db.reservations.push(item);
        return item;
    }},
    {method: 'PUT', pattern: '/api/booking/modify/:id', handle: ({pathParams, body}) => {
        const existing = findReservation(pathParams.id);
        if (existing) Object.assign(existing, requestToItem(body, existing));
        return existing ?? null;
    }},
    {method: 'DELETE', pattern: '/api/booking/:id/delete', handle: ({pathParams}) => {
        const it = findReservation(pathParams.id);
        if (it) it.delYn = 'Y';
        return null;
    }},
    // updateStatus: PUT /api/booking/:id/:state (modify/delete 보다 뒤 — 위 패턴 우선)
    {method: 'PUT', pattern: '/api/booking/:id/:state', handle: ({pathParams}) => {
        const it = findReservation(pathParams.id);
        if (it) {
            const {status, delYn} = toStatusCode(pathParams.state);
            if (status) it.statusCode = status;
            if (delYn) it.delYn = delYn;
        }
        return it ?? null;
    }},
    // 장부 조회(맨 뒤 — 가장 포괄적인 '/api/booking' 는 마지막에)
    {method: 'GET', pattern: '/api/booking', handle: ({params}) => db.selectBookGroups(params)},

    // ── 담당자 / 운영시간 ──
    {method: 'GET', pattern: '/api/booking/v1/staff', handle: () => db.doctors},
    {method: 'POST', pattern: '/api/booking/v1/staff/add', handle: () => null},
    {method: 'POST', pattern: '/api/booking/v1/staff/sync', handle: () => null},

    // ── 운영일정 설정 (운영시간 / 팀 / 운영일정 설정) ──
    // 운영시간 원천 분리 2조회 (BE 계약 전환 2026-07). site=사업장(사업장 strict), staff=담당자(자체 TB).
    {method: 'GET', pattern: '/api/booking/v2/schedule/work-hours/site', handle: () => db.siteWorkHours},
    {method: 'GET', pattern: '/api/booking/v2/schedule/work-hours/staff', handle: () => db.staffWorkHours},
    {method: 'GET', pattern: '/api/booking/v2/schedule/teams', handle: () => ({teams: db.teams})},
    {method: 'GET', pattern: '/api/booking/v2/schedule/settings', handle: () => db.treatmentSettings},
    {method: 'POST', pattern: '/api/booking/v2/schedule/settings/save', handle: ({body}) => {
        /* settings/save 는 파트 3축이다(BE 계약 2026-07). 필드 미전송(null) = 그 파트를 아예 손대지 않음.
         *  - body.site         없음 → 사업장 파트(사업장 운영시간 + 휴무규칙/지정일자/공휴일) 통째 skip
         *  - body.teams        없음 → 자체 파트 통째 skip (팀 + 담당자 운영시간)
         *  - body.workingHours 없음 → 담당자 운영시간·오버라이드 미변경(삭제도 안 함). 팀은 정상 저장
         * ★workingHours 는 teams 없이 올 수 없다 — BE 가 요청 teams 로 "팀 소속 담당자만" 거른다.
         * 빈 목록 []/{} 은 생략이 아니라 "전부 삭제" 라는 정상 의도 (null 과 구분).
         * 응답 payload 는 파트별 결과 {staff, site}: 'succeed' | 'failed' | 'skipped'. */
        const b = (body && typeof body === 'object') ? body : {};
        const siteIncluded = b.site != null;
        const staffIncluded = b.teams != null;
        const workingHoursIncluded = staffIncluded && b.workingHours != null;

        if (siteIncluded) {
            // site 는 사업장 설정 원천 — 조회(getSiteWorkHours)와 round-trip 되게 함께 반영.
            if (Array.isArray(b.site)) db.siteWorkHours.site = b.site;
            if (Array.isArray(b.recurringOffRules)) {
                db.siteWorkHours.recurringOffRules = b.recurringOffRules;
                db.treatmentSettings.recurringOffRules = b.recurringOffRules;
            }
            if (Array.isArray(b.workDates)) {
                db.siteWorkHours.workDates = b.workDates;
                db.treatmentSettings.workDates = b.workDates;
            }
            if (Array.isArray(b.offDates)) {
                db.siteWorkHours.offDates = b.offDates;
                db.treatmentSettings.offDates = b.offDates;
            }
            if (typeof b.holidayClosedYn === 'boolean') {
                db.siteWorkHours.holidayClosedYn = b.holidayClosedYn;
                db.treatmentSettings.holidayClosedYn = b.holidayClosedYn;
            }
            /* 공휴일 운영시간도 요일별과 같이 전체 치환이다(BE buildHolidayRows 규약).
             *  - null/미전송 → baseline 보존. 공휴일을 휴무로 바꾼 저장이 시간을 지우면
             *    다시 진료로 되돌렸을 때 값이 사라진다
             *  - 전체 구간(work)이 없으면 휴게만 남길 이유가 없어 빈 목록 = 미설정으로 떨어진다(삭제 경로)
             *  - 휴게는 시작·종료가 둘 다 있을 때만 행이 되므로, 왕복에서 한쪽만 남지 않는다 */
            if (b.holidayHours != null && typeof b.holidayHours === 'object') {
                const p = b.holidayHours as Record<string, string | null>;
                const keep = (s: string | null, e: string | null) => (s && e ? s : null);
                const next: SiteHolidayHours | null = (p.openHm && p.closeHm) ? {
                    openHm: p.openHm, closeHm: p.closeHm,
                    lunchStartHm: keep(p.lunchStartHm, p.lunchEndHm), lunchEndHm: keep(p.lunchEndHm, p.lunchStartHm),
                    dinnerStartHm: keep(p.dinnerStartHm, p.dinnerEndHm), dinnerEndHm: keep(p.dinnerEndHm, p.dinnerStartHm),
                } : null;
                db.siteWorkHours.holidayHours = next;
                db.treatmentSettings.holidayHours = next;
            }
        }

        // 팀은 전체 치환 — 미전송 시 여기까지 오지 않으므로 기존 팀이 보존된다(전멸 방지).
        if (staffIncluded && Array.isArray(b.teams)) db.treatmentSettings.teams = b.teams;

        /* 담당자 운영시간은 팀과 **따로** 생략될 수 있다 — 운영시간 조회 실패로 workingHours 가
         * 빠져도 위에서 팀은 이미 저장됐다. 여기서 손대지 않아야 기존 운영시간이 보존된다. */
        if (workingHoursIncluded && typeof b.workingHours === 'object') {
            if (Array.isArray(b.workingHours.staff)) {
                // payload 에는 이름이 없다 — 조회 round-trip 을 위해 기존 staffName 을 보존한다.
                db.staffWorkHours.staff = b.workingHours.staff.map((row: any) => ({
                    ...row,
                    staffName: db.staffWorkHours.staff.find(m => m.staffId === row.staffId)?.staffName ?? '',
                }));
            }
            if (Array.isArray(b.workingHours.overrides)) db.staffWorkHours.overrides = b.workingHours.overrides;
        }

        return {
            staff: staffIncluded ? 'succeed' : 'skipped',
            site: siteIncluded ? 'succeed' : 'skipped',
        };
    }},

    // ── 예약장부 설정 (reservation) ──
    {method: 'GET', pattern: '/api/booking/v2/reservation-settings/settings', handle: () => db.reservationSettings},
    {method: 'POST', pattern: '/api/booking/v2/reservation-settings/settings/save', handle: ({body}) => {
        if (body && typeof body === 'object') Object.assign(db.reservationSettings, body);
        return null;
    }},

    // ── 서비스 항목 마스터 (service-items) ──
    {method: 'GET', pattern: '/api/booking/service-items/groups', handle: () => db.serviceGroups},
    {method: 'POST', pattern: '/api/booking/service-items/groups', handle: ({body}) => {
        const g = {serviceGroupId: db.nextNo(), serviceGroupName: body?.serviceGroupName ?? '새 그룹', sortOrd: body?.sortOrd ?? db.serviceGroups.length + 1, items: []};
        db.serviceGroups.splice(db.serviceGroups.length - 1, 0, g); // 직접입력(99) 앞에 삽입
        return g;
    }},
    {method: 'PUT', pattern: '/api/booking/service-items/groups/:id', handle: ({pathParams, body}) => {
        const g = db.serviceGroups.find(x => String(x.serviceGroupId) === pathParams.id);
        if (g && body) Object.assign(g, {serviceGroupName: body.serviceGroupName ?? g.serviceGroupName, sortOrd: body.sortOrd ?? g.sortOrd});
        return null;
    }},
    {method: 'DELETE', pattern: '/api/booking/service-items/groups/:id', handle: ({pathParams}) => {
        const i = db.serviceGroups.findIndex(x => String(x.serviceGroupId) === pathParams.id);
        if (i >= 0) db.serviceGroups.splice(i, 1);
        return null;
    }},
    {method: 'POST', pattern: '/api/booking/service-items/items', handle: ({body}) => {
        const g = db.serviceGroups.find(x => x.serviceGroupId === body?.serviceGroupId);
        const item = {serviceItemId: db.nextNo(), serviceGroupId: body?.serviceGroupId, serviceItemName: body?.serviceItemName ?? '새 항목', sortOrd: body?.sortOrd ?? (g?.items.length ?? 0) + 1, useYn: 'Y' as const};
        g?.items.push(item);
        return item;
    }},
    {method: 'PUT', pattern: '/api/booking/service-items/items/:id', handle: ({pathParams, body}) => {
        for (const g of db.serviceGroups) {
            const it = g.items.find(x => String(x.serviceItemId) === pathParams.id);
            if (it && body) {
                Object.assign(it, {serviceItemName: body.serviceItemName ?? it.serviceItemName, sortOrd: body.sortOrd ?? it.sortOrd});
                break;
            }
        }
        return null;
    }},
    {method: 'DELETE', pattern: '/api/booking/service-items/items/:id', handle: ({pathParams}) => {
        for (const g of db.serviceGroups) {
            const i = g.items.findIndex(x => String(x.serviceItemId) === pathParams.id);
            if (i >= 0) {g.items.splice(i, 1); break;}
        }
        return null;
    }},

    // ── 고객 (고객) ──
    {method: 'GET', pattern: '/api/booking/v1/customers', handle: ({params}) => {
        const kw = String(params.name ?? params.keyword ?? '');
        // store 는 배열(CustomerRecord[])을 기대. 시드 고객 풀에서 검색어로 필터.
        const rows = db.reservations
            .filter(r => r.delYn === 'N' && (!kw || r.customerName.includes(kw) || (r.customerPhone ?? '').includes(kw)))
            .reduce((acc: any[], r) => {
                if (!acc.some(a => a.customerId === String(r.customerId))) {
                    acc.push({memberYn: r.memberYn === 'Y', customerId: String(r.customerId), customerName: r.customerName, customerPhone: r.customerPhone});
                }
                return acc;
            }, []);
        return rows;
    }},
    {method: 'POST', pattern: '/api/booking/v1/customers/add', handle: () => null},

    // ── 사업장 설정 (운영중 상태) ──
    {method: 'GET', pattern: '/api/booking/v1/work-state', handle: () => db.workState.enabled},
    {method: 'PUT', pattern: '/api/booking/v1/work-state/modify', handle: ({params}) => {
        db.workState.enabled = params.enabled === 'Y' || params.enabled === true;
        return db.workState.enabled;
    }},
];
