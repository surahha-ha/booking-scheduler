// ============================================================================
// Mock In-Memory DB — 퍼블리싱 전용 임시 데이터 (stateful)
// ----------------------------------------------------------------------------
// WAS 없이 화면을 구동하기 위한 가짜 데이터 저장소.
// - 시드(seed) 는 모듈 로드 시 1회 생성(오늘 날짜 기준으로 예약을 흩뿌림).
// - add/modify/remove 는 이 객체를 직접 변형(stateful) → 화면에 즉시 반영.
// - 새로고침하면 모듈이 재평가되어 시드 상태로 복귀.
// 타입은 실제 API 모듈(../api/*)의 것을 그대로 재사용해 payload 스키마를 강제한다.
// ============================================================================
import type {BookDayGroupResponse, BookItem, HolidayItem as NationalHoliday} from '@/api/bookApi';
import type {DoctorPayload} from '@/api/staffApi';
import type {
    DoctorTeam,
    SiteDayHours,
    SiteWorkHoursResponse,
    SiteHolidayHours,
    StaffWorkHoursResponse,
    WorkHoursRow,
    TreatmentSettingsPayload,
} from '@/api/siteApi';
import type {ReservationSettingsPayload} from '@/api/reservationSettingsApi';
import type {ServiceGroupTree} from '@/api/serviceItemApi';
import {csvDoctors, csvReservations} from './csvSeed';
import {clearDb, loadDb, saveDb} from './persist';
import seedFile from './data/reservations.json';

// ─────────────────────────── 날짜 유틸 ───────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAY: BookDayGroupResponse['dayCd'][] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEKDAY_NM = ['일', '월', '화', '수', '목', '금', '토'];

// ─────────────────────────── 담당자 마스터 (CSV distinct STAFF_NAME) ───────────────────────────
export const doctors: DoctorPayload[] = csvDoctors;

// ─────────────────────────── 서비스 항목 마스터 ───────────────────────────
export const serviceGroups: ServiceGroupTree[] = [
    {
        serviceGroupId: 1, serviceGroupName: '상담', sortOrd: 1, items: [
            {serviceItemId: 11, serviceGroupId: 1, serviceItemName: '초회 상담', sortOrd: 1, useYn: 'Y'},
            {serviceItemId: 12, serviceGroupId: 1, serviceItemName: '정기 상담', sortOrd: 2, useYn: 'Y'},
            {serviceItemId: 13, serviceGroupId: 1, serviceItemName: '방문 상담', sortOrd: 3, useYn: 'Y'},
        ],
    },
    {
        serviceGroupId: 2, serviceGroupName: '점검', sortOrd: 2, items: [
            {serviceItemId: 21, serviceGroupId: 2, serviceItemName: '기본 점검', sortOrd: 1, useYn: 'Y'},
            {serviceItemId: 22, serviceGroupId: 2, serviceItemName: '정밀 점검', sortOrd: 2, useYn: 'Y'},
        ],
    },
    {
        serviceGroupId: 3, serviceGroupName: '관리', sortOrd: 3, items: [
            {serviceItemId: 31, serviceGroupId: 3, serviceItemName: '정기 관리', sortOrd: 1, useYn: 'Y'},
            {serviceItemId: 32, serviceGroupId: 3, serviceItemName: '집중 관리', sortOrd: 2, useYn: 'Y'},
        ],
    },
    // 직접입력 그룹(항목 없음) — 실제 서버 동작과 동일하게 항상 1개 존재
    {serviceGroupId: 99, serviceGroupName: '직접입력', sortOrd: 99, items: []},
];

// ─────────────────────────── 예약 (CSV 스냅샷, 오늘 기준 시프트) ───────────────────────────
// stateful 저장소 — add/modify/remove 가 직접 변형. 스프레드로 mutable 복사본.
export const reservations: BookItem[] = [...csvReservations];
let nextReservationId = 900000; // CSV no(1..N) 와 충돌 없는 대역
export const nextNo = () => nextReservationId++;

// ─────────────────────────── 조회 헬퍼 ───────────────────────────
/**
 * 목록·통계 공통 필터 (날짜/의사/키워드) — BE bookSearchFilterCondition 대응.
 * 통계가 이 필터를 거치지 않으면 보드에 없는 예약까지 세어 카드 수와 어긋난다.
 */
export function selectBooks(params: Record<string, any> = {}): BookItem[] {
    const start = String(params.startDate ?? '').replace(/-/g, '');
    const end = String(params.endDate ?? '').replace(/-/g, '');
    const inRange = (dtmStr: string) => {
        const key = dtmStr.slice(0, 10).replace(/-/g, '');
        return (!start || key >= start) && (!end || key <= end);
    };
    const doctorNames: string[] = Array.isArray(params.doctorName) ? params.doctorName : [];
    const keyword = String(params.keyword ?? '').trim();

    return reservations.filter((it) => {
        if (it.delYn === 'Y') return false;
        if (!inRange(it.startAt)) return false;
        if (doctorNames.length && !doctorNames.includes(it.staffName)) return false;
        if (keyword && !(it.customerName ?? '').includes(keyword) && !(it.customerPhone ?? '').includes(keyword)) return false;
        return true;
    });
}

/** book.get — [startDate,endDate] (YYYYMMDD) 범위를 요일 그룹으로 반환 */
export function selectBookGroups(params: Record<string, any> = {}): BookDayGroupResponse[] {
    const groups = new Map<number, BookItem[]>();
    for (const it of selectBooks(params)) {
        const dow = new Date(it.startAt).getDay();
        if (!groups.has(dow)) groups.set(dow, []);
        groups.get(dow)!.push(it);
    }
    return [...groups.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dow, items]) => ({dayCd: WEEKDAY[dow], dayNm: WEEKDAY_NM[dow], items}));
}

/** 국가 공휴일(연도 단위) — 대표 몇 개만. 원천(사업장 설정)과 같이 날짜만 내려준다. */
export function selectNationalHolidays(year: number): NationalHoliday[] {
    return [
        {date: `${year}-01-01`},
        {date: `${year}-03-01`},
        {date: `${year}-05-05`},
        {date: `${year}-06-06`},
        {date: `${year}-08-15`},
        {date: `${year}-10-03`},
        {date: `${year}-10-09`},
        {date: `${year}-12-25`},
    ];
}

// ─────────────────────────── 운영시간 (getSiteWorkHours / getStaffWorkHours) ───────────────────────────
// BE 계약 전환(2026-07): 번들 all → 원천 분리 2조회.
//  - site(사업장, 원천 사업장 설정): 요일별 진료 시작~종료 + 휴게(lunch/dinner) + 휴무 규칙 strict 번들.
//  - staff(담당자, 자체 TB): 요일별 진료 시작~종료(휴게 없음) + 일자 override.
// 진료는 시작~종료 단일 구간이다. USE_YN 계열 필드는 없다 — 진료 안 하는 요일 = 시작·종료 null.
const hhmm = (h: number, m: number) => `${pad(h)}${pad(m)}`;

/* 담당자 요일별 진료 패턴 — 의사마다 다르게 두어 "기관과 다른 담당자" 케이스가 화면에 보이게 한다.
 *  0: 기관과 동일 (평일 09~18, 토 09~13)
 *  1: 늦게 시작 (평일 10~17, 토 휴무)
 *  2: 오전 진료만 (평일 09~13)  → 기관 휴게(13~14)가 운영시간 밖이라 잘려 사라진다 */
const STAFF_PATTERNS: { weekday: [number, number] | null; saturday: [number, number] | null }[] = [
    {weekday: [900, 1800], saturday: [900, 1300]},
    {weekday: [1000, 1700], saturday: null},
    {weekday: [900, 1300], saturday: null},
];

const toHm = (v: number) => hhmm(Math.floor(v / 100), v % 100);

/* 한 담당자의 요일 행 목록 — ★정한 요일만 담는다. 7행으로 채우지 않는다.
 *   행 없음 = 미설정(사업장 운영시간을 따른다) / 행 + 시각 = 진료 / 행 + null = 명시적 휴무
 * 세 상태가 화면에 모두 나타나도록 패턴마다 주말을 다르게 둔다:
 *  0: 평일·토 진료 + 일요일을 휴무로 명시
 *  1: 평일 진료 + 토요일을 휴무로 명시, 일요일은 미설정
 *  2: 평일 진료만 — 주말 두 요일 모두 미설정 */
function staffWeekRows(patternIdx: number): WorkHoursRow[] {
    const idx = patternIdx % STAFF_PATTERNS.length;
    const pattern = STAFF_PATTERNS[idx]!;
    const row = (dayCd: number, span: [number, number] | null): WorkHoursRow => ({
        dayCd,
        staffOpenHm: span ? toHm(span[0]) : null,
        staffCloseHm: span ? toHm(span[1]) : null,
    });

    const rows: WorkHoursRow[] = [];
    if (idx === 0) rows.push(row(0, null));
    for (let dc = 1; dc <= 5; dc++) rows.push(row(dc, pattern.weekday));
    if (idx <= 1) rows.push(row(6, pattern.saturday));
    return rows;
}

/* 사업장 운영시간 — 요일별(0=일 ~ 6=토). 원천은 사업장 설정.
 * 일요일은 목록에서 빠져 휴무(= 미등록 요일), 토요일은 09~13 휴게 없음 — 실제 운영 형태를 모사한다.
 * 평일 휴게는 13:00~14:00 1개만(휴게시간1). 휴게시간2(dinner)는 미설정 → null. */
export const institutionTimes: SiteDayHours[] = [1, 2, 3, 4, 5, 6].map(dayCd => ({
    dayCd,
    openHm: hhmm(9, 0),
    closeHm: dayCd === 6 ? hhmm(13, 0) : hhmm(18, 0),
    lunchStartHm: dayCd === 6 ? null : hhmm(13, 0),
    lunchEndHm: dayCd === 6 ? null : hhmm(14, 0),
    dinnerStartHm: null, dinnerEndHm: null,
}));

/* 사업장 공휴일 운영시간 — 요일 축이 없어 모든 공휴일에 공통 적용된다(사업장당 한 세트).
 * 요일별(09~18, 휴게 13~14)과 일부러 다르게 둔다 — 공휴일에 밴드가 갈리는지 눈으로 구분하려고.
 * ★쉬는지는 holidayClosedYn 이 갖는다. 시드는 holidayClosedYn=true(공휴일 휴무)라 이 값은 보존만 되고 적용되지 않는다
 *   — 화면에서 체크를 풀면 그때부터 적용된다(값 보존 동작을 그대로 확인할 수 있다). */
export const institutionHolidayTime: SiteHolidayHours = {
    openHm: hhmm(10, 0),
    closeHm: hhmm(16, 0),
    lunchStartHm: hhmm(12, 0),
    lunchEndHm: hhmm(13, 0),
    dinnerStartHm: null, dinnerEndHm: null,
};

/* 사업장(site) strict 번들 — GET /work-hours/site. 운영시간 + 휴무 규칙을 함께 내린다.
 * 일요일(0)은 매주 휴무 → site 진료행에는 없고(institutionTimes 는 1~6), recurringOffRules WEEKLY 로 표현. */
export const siteWorkHours: SiteWorkHoursResponse = {
    site: institutionTimes,
    holidayHours: institutionHolidayTime,
    /* 지정일자의 그 날짜 운영시간 — 조회 전용. 비워 두면 FE 가 지정일을 요일 시간으로 판정한다.
     * ★필수 필드다. 예전에 holidayHours 을 빠뜨려 눈검증이 막힌 적이 있다(FE 에 tsc 게이트가 없어 안 드러난다). */
    dateTimes: [],
    recurringOffRules: [{dayCd: 0, repeatTy: 'WEEKLY', monthlyNth: null}],
    workDates: [],
    offDates: [],
    holidayClosedYn: true,
};

/* 담당자(staff) — GET /work-hours/staff. 정한 요일 행만 + 일자 override(행 있고 null 이면 그 날짜만 휴무). */
export const staffWorkHours: StaffWorkHoursResponse = {
    staff: doctors.map((d, i) => ({
        staffId: d.staffId,
        staffName: d.staffName,
        times: staffWeekRows(i),
    })),
    overrides: [],
};

// ─────────────────────────── 팀 / 운영일정 설정 ───────────────────────────
// 팀 = CSV 의사를 앞에서부터 구역별로 분배(2명씩). 운영일정 보기 셀렉트박스용.
export const teams: DoctorTeam[] = (() => {
    const perTeam = 2;
    const out: DoctorTeam[] = [];
    for (let i = 0; i < doctors.length; i += perTeam) {
        const members = doctors.slice(i, i + perTeam).map(d => ({staffId: d.staffId, staffName: d.staffName}));
        out.push({id: out.length + 1, name: `${out.length + 1}구역`, doctors: members});
    }
    return out;
})();

export const treatmentSettings: TreatmentSettingsPayload = {
    /* 사업장(site) 운영시간 — settings/save 번들에 흡수됨. 조회는 getSiteWorkHours 로 별도. */
    site: institutionTimes,
    holidayHours: institutionHolidayTime,
    recurringOffRules: [{dayCd: 0, repeatTy: 'WEEKLY', monthlyNth: null}],
    workDates: [],
    offDates: [],
    holidayClosedYn: true,
    teams: teams.map(t => ({id: t.id, name: t.name, doctorIds: t.doctors.map(d => d.staffId)})),
    /* staff[].times 는 staff 조회와 같은 규약 — 정한 요일 행만(WorkHoursRow). */
    workingHours: {
        staff: doctors.map((d, i) => ({
            staffId: d.staffId,
            times: staffWeekRows(i),
        })),
        overrides: [],
    },
};

// ─────────────────────────── 예약장부 설정 ───────────────────────────
export const reservationSettings: ReservationSettingsPayload = {
    slotUnitMinutes: 30,
    totalColumnCount: 8,
    displayInfo: ['NAME', 'PHONE', 'TREATMENT'],
    cardHeightLevel: 3,
};

// ─────────────────────────── 운영중 상태 ───────────────────────────
export const workState = {enabled: true};

// ─────────────────────────── 영속화 (localStorage) ───────────────────────────
// 위 export 들은 전부 `const` 라 재할당할 수 없다. 그래서 복원은 "내용 교체"로 한다.
// 쓰기 요청(비-GET)을 처리한 뒤 index.ts 가 saveSnapshot() 을 부른다.

// 시드 지문 — 시드 데이터가 바뀌면 저장분을 버리고 새 시드로 다시 시작한다.
// 스키마 버전(키의 v1)만으로는 "구조는 같고 내용만 바뀐" 시드 교체를 감지하지 못한다.
const SEED_TAG = `${seedFile.anchorDate}:${seedFile.anchorCount}:${seedFile.doctors[0]}`;

export function snapshot() {
    return {
        __seed: SEED_TAG,
        reservations,
        doctors,
        serviceGroups,
        teams,
        siteWorkHours,
        staffWorkHours,
        treatmentSettings,
        reservationSettings,
        workState,
        nextReservationId,
    };
}

function replaceArray<T>(target: T[], next: unknown): void {
    if (!Array.isArray(next)) return;
    target.splice(0, target.length, ...(next as T[]));
}

function replaceObject<T extends object>(target: T, next: unknown): void {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    Object.keys(target).forEach(k => delete (target as Record<string, unknown>)[k]);
    Object.assign(target, next);
}

function restore(s: Partial<ReturnType<typeof snapshot>>): void {
    replaceArray(reservations, s.reservations);
    replaceArray(doctors, s.doctors);
    replaceArray(serviceGroups, s.serviceGroups);
    replaceArray(teams, s.teams);
    replaceObject(siteWorkHours, s.siteWorkHours);
    replaceObject(staffWorkHours, s.staffWorkHours);
    replaceObject(treatmentSettings, s.treatmentSettings);
    replaceObject(reservationSettings, s.reservationSettings);
    replaceObject(workState, s.workState);
    if (typeof s.nextReservationId === 'number') nextReservationId = s.nextReservationId;
}

export function saveSnapshot(): void {
    saveDb(snapshot());
}

/** 저장분을 버리고 시드 상태로 되돌린다 — 데모·개발용. */
export function resetToSeed(): void {
    clearDb();
    if (typeof location !== 'undefined') location.reload();
}

// 모듈 평가의 마지막 — 저장된 상태가 있으면 시드 위에 덮어쓴다.
// 단, 다른 시드로 저장된 것이면 버린다(시드를 갈아끼웠는데 옛 데이터가 살아남는 것을 막는다).
const persisted = loadDb<ReturnType<typeof snapshot>>();
if (persisted) {
    if (persisted.__seed === SEED_TAG) {
        restore(persisted);
        console.info('[저장소] 복원 완료 — 예약', reservations.length, '건');
    }
    else {
        console.info('[저장소] 시드가 바뀌어 저장분을 폐기하고 새 시드로 시작한다.');
        clearDb();
    }
}
