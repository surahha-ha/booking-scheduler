import {defineStore} from 'pinia';
import {computed, ref} from 'vue';
import {
    addDoctors,
    type ApiResponse,
    type DoctorPayload,
    getDoctors,
    syncDoctors
} from '@/api/staffApi';
import {push} from 'notivue';
import dayjs from 'dayjs';
import {
    getSiteWorkHours,
    getStaffWorkHours,
    getTeams,
    getTreatmentSettings,
    type DoctorTeam,
    type SiteDayHours,
    type SiteWorkHoursResponse,
    type SiteDateHours,
    type SiteHolidayHours,
    type StaffWorkHoursResponse,
    type WorkHoursRow,
    type TreatmentSettingsPayload
} from '@/api/siteApi';
import {fetchPublicHolidays} from '@/api/publicHolidayApi';
import {DEFAULT_END, DEFAULT_START} from '@/constants/schedulerBoard';

// 운영시간·담당자 store
export type Doctor = {
    id: string;
    text: string;
    staffId?: number;       // 신규 API의 담당자 PK (staff_id로 백엔드 저장 시 사용)
    externalStaffNo?: number;
    externalStaffName?: string;
    openYn?: 'Y' | 'N';    // 공개여부 — 'N'(비공개) 의사도 목록에 포함(#1), 검색필터·헤더에 '비공개' 뱃지
};

type HHMM = string;
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 일~토

type TimeRange = {
    start: HHMM;
    end: HHMM;
};

// CLOSED = OFF 된 세션(예: 오후 미사용)이 만든 비운영 구간 → 점심/저녁이 아니라 '운영종료'로 표시.
type BreakType = 'LUNCH' | 'DINNER' | 'CLOSED';
type BlockType = 'BLOCKED';

type BreakRange = TimeRange & {
    type: BreakType
};
type BlockRange = TimeRange & {
    type: BlockType
};

export type DailySchedule = {
    open?: TimeRange | null;
    breaks?: BreakRange[] | null;
    blocks?: BlockRange[] | null;
    dayOffYn?: 'Y' | 'N';
};

export type SchedulerRuleSet = {
    closedDates?: Set<string> | string[] | null;
    holidayWorkDates?: Set<string> | string[] | null;
    closedWeekdays?: Set<number> | number[] | null;
    /**
     * 요일별 운영시간. 키 없음 = **미설정**(상위 fallback), `null` = **명시적 휴무**(fallback 금지).
     * 담당자는 이 셋이 모두 나타난다 — 저장 규약이 `행 없음=미설정 / 행+시각=진료 / 행+시각 null=휴무`.
     */
    weekly?: Partial<Record<Weekday, DailySchedule | null>> | null;
    /** 공휴일에 적용할 운영시간 — 사업장당 한 세트(요일 축 없음). 원천 = 사업장 설정 공휴일 운영시간 테이블.
     *  undefined = 미설정(공휴일 휴무와 다르다). 휴무 여부는 holidayClosedYn → closedDates 로 이미 갈린다. */
    holiday?: DailySchedule | null;
    /** 공휴일이면서 최종적으로 진료하는 날("YYYY-MM-DD"). = 공휴일 − closedDates(최종).
     *  이 날의 진료 시작·종료는 **담당자 설정이 먼저**고(정해 뒀으면 진료든 휴무가든 그 값),
     *  미설정일 때만 holiday 운영시간을 쓴다. 단 휴게는 사업장만 소유하므로 담당자 값을 쓸 때도
     *  이 날짜의 기관 휴게(= 공휴일 휴게)로 간다 — pickDailySchedule·resolveUnitHours 같은 규칙. */
    holidayOpenDates?: Set<string> | string[] | null;
    /** 날짜("YYYY-MM-DD") → 그 날짜에 **실제로 저장된** 사업장 운영시간. 원천 = 사업장 설정 일자별 운영시간.
     *  지정일자(임시진료)의 시간이며, 없으면 그 날짜는 종전대로 종일 열림으로 본다.
     *  ★요일·공휴일보다 우선한다 — 날짜를 콕 집어 정한 값이라 의도가 가장 구체적이다
     *  (BE 운영중 판정도 "일자별 → 공휴일 → 요일별" 순서다). */
    dailyByDate?: Record<string, DailySchedule> | null;
};

export type DoctorRuleMap = Record<string, SchedulerRuleSet | null | undefined>;

// "HHMM" -> "HH:MM"
function hmToHHMM(hm?: string): HHMM | null {
    if (!hm || hm.length !== 4) return null;
    return `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
}

// 외부 일정 조회 요일코드(SUN~SAT) → Weekday(0~6). 휴무 union 용.
export function dayCodeToWeekday(code: string | undefined): Weekday | null {
    switch (code) {
        case 'SUN': return 0;
        case 'MON': return 1;
        case 'TUE': return 2;
        case 'WED': return 3;
        case 'THU': return 4;
        case 'FRI': return 5;
        case 'SAT': return 6;
        default: return null;
    }
}

function toRange(startHm?: string, endHm?: string): TimeRange | null {
    const s = hmToHHMM(startHm);
    const e = hmToHHMM(endHm);
    if (!s || !e) return null;
    return {start: s, end: e};
}

function hmToMinutes(hm: string | number | null | undefined): number | null {
    if (hm == null) return null;
    const digits = String(hm).replace(/\D/g, '').padStart(4, '0');
    if (digits.length !== 4) return null;

    const h = Number(digits.slice(0, 2));
    const m = Number(digits.slice(2, 4));
    if (!Number.isFinite(h) || !Number.isFinite(m) || m < 0 || m >= 60) return null;

    return h * 60 + m;
}

function floorToStep(min: number, step: number) {
    return Math.floor(min / step) * step;
}

function ceilToStep(min: number, step: number) {
    return Math.ceil(min / step) * step;
}

function replaceDoctorName(value: string) {
    const name = value ?? '';
    return name.replace(/[^가-힣a-zA-Z\s]/g, '');
}

/** "HH:MM"(zero-pad) 문자열 비교 = 시간순. */
function hmMax(a: string, b: string) { return a > b ? a : b; }
function hmMin(a: string, b: string) { return a < b ? a : b; }

/** 휴게 구간들을 운영시간(open) 안으로 잘라 BreakRange[] 로. open 밖으로 완전히 벗어난 휴게는 버린다.
 *  예) open 09:00~13:00 + 점심 12:30~13:30 → [LUNCH 12:30~13:00]. */
function clampBreaksToOpen(
    open: TimeRange,
    breaks: { range: TimeRange; type: BreakType }[],
): BreakRange[] {
    return breaks
        .map(b => ({
            start: hmMax(open.start, b.range.start),
            end: hmMin(open.end, b.range.end),
            type: b.type,
        }))
        .filter(b => b.start < b.end)
        .sort((a, b) => a.start.localeCompare(b.start));
}

/** 사업장 운영시간 1행에서 휴게(점심·저녁) 구간만 뽑는다. 담당자 운영시간에도 이 값을 그대로 쓴다.
 *  요일 행(SiteDayHours)과 공휴일 한 세트(SiteHolidayHours)는 dayCd 유무만 다르고 시분 필드가 같아 변환을 공유한다. */
function institutionBreakRanges(row: SiteHolidayHours): { range: TimeRange; type: BreakType }[] {
    const out: { range: TimeRange; type: BreakType }[] = [];
    const lunch = toRange(row.lunchStartHm ?? undefined, row.lunchEndHm ?? undefined);
    if (lunch) out.push({range: lunch, type: 'LUNCH'});
    const dinner = toRange(row.dinnerStartHm ?? undefined, row.dinnerEndHm ?? undefined);
    if (dinner) out.push({range: dinner, type: 'DINNER'});
    return out;
}

/**
 * 담당자 운영시간 1행("HHmm" 시작~종료) → DailySchedule | undefined.
 * 시작/종료가 없으면 undefined 를 돌려준다 — 그 행을 **명시적 휴무**으로 읽어 `weekly[요일]=null` 로
 * 담는 것은 호출측(loadWorkHours)의 몫이다. 미설정 요일은 애초에 행이 오지 않는다.
 *
 * 휴게(점심·저녁)는 담당자가 소유하지 않는다. 같은 요일의 **사업장 휴게를 그대로 받아** 그린다
 * (institutionBreaks). 담당자 운영시간 밖의 휴게는 잘려 나간다.
 */
export function workHoursRowToDailySchedule(
    row: WorkHoursRow,
    institutionBreaks?: { range: TimeRange; type: BreakType }[],
): DailySchedule | undefined {
    const open = toRange(row.staffOpenHm ?? undefined, row.staffCloseHm ?? undefined);
    if (!open) return undefined;

    const breaks = clampBreaksToOpen(open, institutionBreaks ?? []);
    return {dayOffYn: 'N', open, breaks: breaks.length ? breaks : null, blocks: null};
}

/**
 * 사업장 운영시간 1행(요일) → DailySchedule | undefined.
 * - 진료는 시작~종료 단일 구간이다. 시작/종료가 없으면 그 요일은 진료하지 않는다
 *   → undefined (weekly 에서 생략 → 상위 fallback).
 * - 휴게(점심·저녁)는 운영시간 안을 비우는 구간으로 그린다.
 */
export function institutionRowToDailySchedule(row: SiteHolidayHours): DailySchedule | undefined {
    const open = toRange(row.openHm ?? undefined, row.closeHm ?? undefined);
    if (!open) return undefined;

    const breaks = clampBreaksToOpen(open, institutionBreakRanges(row));
    return {dayOffYn: 'N', open, breaks: breaks.length ? breaks : null, blocks: null};
}

/**
 * 공휴일 운영시간(사업장 한 세트) → DailySchedule | undefined.
 * 요일 행과 모양이 같아 변환은 그대로 재사용한다. 시작/종료가 없으면 undefined = **미설정**
 * — '공휴일 휴무'이 아니다(휴무는 holidayClosedYn 이 closedDates 로 만든다). 미설정이면 그 공휴일은
 * 시간 제한 없이 진료하는 것으로 본다(useSchedulerRules 의 isWorkOverride 경로).
 */
export function holidayHoursToDailySchedule(holiday: SiteHolidayHours | null | undefined): DailySchedule | undefined {
    if (!holiday) return undefined;
    return institutionRowToDailySchedule(holiday);
}

/**
 * 일자별 운영시간 목록 → 날짜("YYYY-MM-DD") → DailySchedule Map.
 *
 * 지정일자에 **실제로 저장된 시간**이다. 이게 없으면 FE 는 지정일을 종일 열림으로 추정할 수밖에 없어
 * 저장된 시간(예: 09:00~18:00) 밖 예약을 받는다 — 사업장 설정·운영중 표시와 갈린다.
 *
 * - `closed` 인 날짜(임시휴무)는 담지 않는다. 휴무는 closedDates 가 이미 갖고 있고,
 *   여기 섞으면 "시간이 있는 날"과 뒤엉켜 판정이 흐려진다.
 * - 시작/종료가 없는 행도 담지 않는다 → 그 날짜는 종전대로 종일 열림으로 본다.
 */
export function dateTimesToDailyMap(rows: SiteDateHours[] | null | undefined): Record<string, DailySchedule> {
    const out: Record<string, DailySchedule> = {};
    for (const row of rows ?? []) {
        if (!row?.date || row.closed) continue;
        const daily = institutionRowToDailySchedule(row);
        if (daily) out[row.date] = daily;
    }
    return out;
}

/**
 * 사업장 운영시간(요일별 N행) → weekly DailySchedule 맵.
 * 원천은 사업장 설정이며 요일마다 운영시간·휴게시간이 다를 수 있다.
 * 목록에 없는 요일, 또는 활성 세션이 0인 요일은 weekly 에서 생략된다
 * (→ 의사설정 > 기관 > 일반 fallback 체인의 다음 단계로 넘어감).
 * 빈 배열(한 번도 등록 안 함) → {} (operatingRange 09~18 fallback, 기존 동작 유지).
 */
export function institutionToWeekly(rows: SiteDayHours[] | null | undefined): Partial<Record<Weekday, DailySchedule>> {
    const weekly: Partial<Record<Weekday, DailySchedule>> = {};
    if (!rows || rows.length === 0) return weekly;

    for (const row of rows) {
        const wd = row.dayCd;
        if (wd == null || wd < 0 || wd > 6) continue;
        const daily = institutionRowToDailySchedule(row);
        if (daily) weekly[wd as Weekday] = daily;
    }
    return weekly;
}

export type HolidaySettingsInput = {
    offDates?: string[];           // 'YYYY-MM-DD' 특정날짜 휴무(override OFF)
    workDates?: string[];          // 'YYYY-MM-DD' 휴일근무(override WORK = 휴무 해제/rescue)
    recurringOffRules?: { dayCd: number; repeatTy: 'WEEKLY' | 'MONTHLY'; monthlyNth: number | null }[];
    holidayClosedYn?: boolean;
};

export type HolidayClosure = {
    closedDates: Set<string>;
    closedWeekdays: Set<number>;
    holidayWorkDates: Set<string>;
    holidayOpenDates: Set<string>;
};

/**
 * 자체 휴무 설정(getTreatmentSettings) + 공휴일(adapter) → hospitalRules 휴무 필드.
 * SSOT = 설정화면 isDisplayedOff: offDates/workDates(override) 우선, 없으면 recurring(WEEKLY/MONTHLY).
 * - WEEKLY → closedWeekdays (요일 무한 반복, expand 불필요. useSchedulerRules 가 isWorkOverride 로 workDate rescue)
 * - MONTHLY(매월 N번째 요일, occurrence=ceil(date/7)) → [startYmd,endYmd] horizon 구체 날짜 expand → closedDates
 * - closedDates = offDates ∪ MONTHLY expand ∪ (includePublicHolidays ? publicHolidays : []) − workDates(rescue)
 * - holidayWorkDates = workDates (useSchedulerRules isWorkOverride 가 closedWeekday/dayOff 무시)
 * - holidayOpenDates = publicHolidays − closedDates(최종) = "공휴일인데 진료하는 날".
 *   holidayClosedYn=N(공휴일 진료)이면 전부, holidayClosedYn=Y 여도 workDates 로 구제한 공휴일은 여기 들어온다
 *   — 경로와 무관하게 "공휴일 ∧ ¬휴무"이면 공휴일 운영시간을 적용한다는 한 줄 규칙.
 *   매주 휴무 요일과 겹쳐도 공휴일 판정이 이긴다(공휴일이면 holidayClosedYn 만 본다 — BE isClosedToday 와 같은 규칙).
 * ⚠️ 순수함수(now 미참조) — horizon 은 호출측이 dayjs() 로 산출해 전달. closedDates 소비는 기존 파이프 그대로(엔진/rules 무변경).
 */
export function buildHolidayClosure(
    settings: HolidaySettingsInput,
    publicHolidays: string[],
    startYmd: string,
    endYmd: string,
): HolidayClosure {
    const workSet = new Set(settings.workDates ?? []);
    const closedWeekdays = new Set<number>();
    const monthlyRules: { weekday: number; occurrence: number }[] = [];

    for (const rule of settings.recurringOffRules ?? []) {
        if (rule.repeatTy === 'WEEKLY') {
            closedWeekdays.add(rule.dayCd);
        } else if (rule.repeatTy === 'MONTHLY' && rule.monthlyNth != null) {
            monthlyRules.push({weekday: rule.dayCd, occurrence: rule.monthlyNth});
        }
    }

    const closedDates = new Set<string>();
    for (const d of settings.offDates ?? []) closedDates.add(d);
    if (settings.holidayClosedYn) {
        for (const d of publicHolidays) closedDates.add(d);
    }

    // MONTHLY(매월 N번째 요일) horizon expand
    if (monthlyRules.length) {
        let cursor = dayjs(startYmd);
        const end = dayjs(endYmd);
        while (!cursor.isAfter(end, 'day')) {
            const wd = cursor.day();
            const occ = Math.ceil(cursor.date() / 7); // 1~5
            if (monthlyRules.some((r) => r.weekday === wd && r.occurrence === occ)) {
                closedDates.add(cursor.format('YYYY-MM-DD'));
            }
            cursor = cursor.add(1, 'day');
        }
    }

    // 휴일근무(workDates) rescue → closedDates 에서 제외
    for (const d of workSet) closedDates.delete(d);

    // 공휴일 중 최종적으로 휴무가 아닌 날 = 공휴일 운영시간 적용 대상. rescue 반영 뒤에 계산해야 한다.
    const holidayOpenDates = new Set<string>();
    for (const d of publicHolidays) {
        if (!closedDates.has(d)) holidayOpenDates.add(d);
    }

    return {closedDates, closedWeekdays, holidayWorkDates: workSet, holidayOpenDates};
}

export const useStaffStore = defineStore('staffStore', () => {
    function unwrapBody<T>(res: any): ApiResponse<T> {
        return (res as any).data ?? res;
    }

    const pending = ref(false);
    const doctors = ref<Doctor[]>([]);
    // 진료 팀/직원 필터용 팀 마스터 (가산 — SF-3a). 검색필터 셀렉트박스 + ReservationPopup 담당의사 공유.
    const teams = ref<DoctorTeam[]>([]);
    const treatmentMinHour = ref<number | null>(null);
    const treatmentMaxHour = ref<number | null>(null);

    /** 병원 공통 룰 */
    const hospitalRules = ref<SchedulerRuleSet>({
        closedDates: new Set(),
        holidayWorkDates: new Set(),
        holidayOpenDates: new Set(),
        closedWeekdays: new Set(),
        weekly: null,
        holiday: null,
    });

    /** 의사별 룰 */
    const doctorRules = ref<DoctorRuleMap>({});

    /** 진료최소시작시간, 진료최대종료시간 */
    const schedulerDayRange = computed(() => {
        const fallback = {startDayHour: DEFAULT_START, endDayHour: DEFAULT_END};
        const min = treatmentMinHour.value;
        const max = treatmentMaxHour.value;

        if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
            return fallback;
        }

        const startDayHour = Math.max(0, Math.min(23, min));
        const endDayHour = Math.max(startDayHour + 1, Math.min(24, max));

        return {startDayHour, endDayHour};
    });

    // 반환: 조회 성공 여부. 실패(일시적 네트워크/서비스 장애)와 "성공했는데 0명"을 호출부가 구분하도록 boolean 반환.
    //   (실패 시 doctors 를 비우지 않고 이전 값 유지 → 일시 장애로 화면이 통째로 사라지지 않게.)
    async function loadDoctor(): Promise<boolean> {
        try {
            const res = await getDoctors();
            const body = unwrapBody<DoctorPayload[]>(res);
            const list: Doctor[] = (body.payload ?? []).map((it) => {
                const name = replaceDoctorName(it.staffName);
                return {
                    id    : name,           // 기존 호환: 이름 기반 식별자
                    text  : name,
                    staffId: it.staffId,      // 실제 PK (백엔드 저장 시 사용)
                    openYn: it.openYn,      // 공개여부 — '비공개' 뱃지용(#1)
                };
            });

            doctors.value.splice(0, doctors.value.length, ...list);
            return true;
        } catch (e) {
            console.error('[담당자 > 조회] 실패', e);
            return false;
        }
    }

    // 진료 팀/직원 조회 (가산). 팀 미설정이면 빈 배열 → 검색필터 셀렉트박스 숨김(AS-IS 전체).
    async function loadTeams() {
        try {
            const res = await getTeams();
            const body = unwrapBody<{ teams: DoctorTeam[] }>(res);
            teams.value = body.payload?.teams ?? [];
        } catch (e) {
            console.error('[진료 팀 > 조회] 실패', e);
        }
    }

    async function addDoctorName(params: string) {
        try {
            const res = await addDoctors(params);
            const body = unwrapBody<any>(res);
            await loadDoctor();
            return body;
        } catch (e) {
            push.error(e?.response?.data?.message || '오류가 발생했습니다.');
            console.error('[담당자 > 추가] 실패', e);
        }
    }

    /**
     * 담당자 마스터 동기화 — 외부 시스템에서 담당자 갱신 후 로컬 목록 재조회.
     * 성공/실패를 boolean 으로 반환(가산 — 기존 호출부는 반환값 무시라 무영향).
     *   on-demand 동기화 버튼이 실패 시 잘못된 성공 토스트를 띄우지 않도록(에러는 내부 catch).
     */
    async function syncDoctor(): Promise<boolean> {
        try {
            await syncDoctors();
            await loadDoctor();
            return true;
        } catch (e) {
            console.error('[담당자 > 동기화] 실패', e);
            return false;
        }
    }

    /**
     * 휴무 설정 → hospitalRules.closedDates/closedWeekdays/holidayWorkDates.
     * 소스 = getTreatmentSettings() (휴무 규칙의 원천은 서버가 사업장 설정에서 읽어 내려준다)
     *        + fetchPublicHolidays()(공휴일 adapter).
     * SSOT = 설정화면 isDisplayedOff. 합성은 buildHolidayClosure(순수) 참조.
     * - 공휴일은 범용 데이터(휴무일과 별개). includePublicHolidays=true 일 때만 합류.
     */
    async function loadHolidaySettings() {
        try {
            // 휴무 = 자체(BOOK) SSOT — 자체 휴무일 설정(recurringOffRules/offDates) + 공휴일만.
            // 외부 일정 조회().dayOffYn 은 휴무 소스에서 제외(사용자 확정 2026-06-16). 외부 시스템 전요일 off 가
            // 자체 운영시간/등록 가능 거래처를 전원 휴무로 덮던 문제 해소.
            const [settingsRes, publicHolidays] = await Promise.all([
                getTreatmentSettings(),
                fetchPublicHolidays(),
            ]);
            const body = unwrapBody<TreatmentSettingsPayload>(settingsRes);
            const payload = body?.payload;

            // MONTHLY expand horizon: today ±1년(연 경계). 보드 표시/네비 범위 커버.
            const today = dayjs();
            const startYmd = today.subtract(1, 'year').startOf('year').format('YYYY-MM-DD');
            const endYmd = today.add(1, 'year').endOf('year').format('YYYY-MM-DD');

            const {closedDates, closedWeekdays, holidayWorkDates, holidayOpenDates} = buildHolidayClosure(
                {
                    offDates: payload?.offDates,
                    workDates: payload?.workDates,
                    recurringOffRules: payload?.recurringOffRules,
                    holidayClosedYn: payload?.holidayClosedYn,
                },
                publicHolidays,
                startYmd,
                endYmd,
            );


            hospitalRules.value = {
                ...hospitalRules.value,
                closedDates,
                closedWeekdays,
                holidayWorkDates,
                holidayOpenDates,
            };

            return body;
        } catch (e) {
            console.error('[휴무 설정 > 조회] 실패', e);
        }
    }

    /**
     * 운영시간(기관 + 담당자) 조회 → hospitalRules.weekly + doctorRules + min/max.
     * BE 계약 전환(2026-07): 번들 1콜(getAllWorkHours) → 원천 분리 2콜.
     * - getSiteWorkHours: 사업장(site, 원천 사업장 설정) 요일별 → institutionToWeekly → hospitalRules.weekly (+ min/max)
     * - getStaffWorkHours: 담당자(staff, 자체 TB) times[] → doctorRules[정규화이름].weekly (설정 요일만, 미설정=기관 fallback)
     * 키 = replaceDoctorName(staffName) — V3 unit.doctorId·loadDoctor 키와 정합.
     * useSchedulerRules priority=DOCTOR_FIRST → 의사 운영시간 > 기관 site > 일반(09~18).
     *
     * 휴게(점심·저녁)는 기관만 소유하므로, 담당자 weekly 에도 **같은 요일의 기관 휴게를 넣어 준다**
     * — 의사 컬럼에도 휴게 음영이 그려져야 그 시간에 예약이 잡히지 않는다.
     * (여기는 보드 표시용 조회다. 저장 게이트는 설정 화면(SchedulerSettingsTreatmentSetting)의 몫.)
     */
    async function loadWorkHours() {
        try {
            const [siteRes, staffRes] = await Promise.all([getSiteWorkHours(), getStaffWorkHours()]);
            const siteBody = unwrapBody<SiteWorkHoursResponse>(siteRes);
            const staffBody = unwrapBody<StaffWorkHoursResponse>(staffRes);
            const sitePayload = siteBody?.payload;
            const staffPayload = staffBody?.payload;

            // ── 기관 운영시간: site[] → hospitalRules.weekly + min/max ──
            // 공휴일 운영시간은 요일 축이 없는 별도 한 세트라 weekly 에 섞지 않는다
            // (weekly 를 통째로 순회하는 소비처들이 특수 키를 요일로 오인한다).
            const weekly = institutionToWeekly(sitePayload?.site);
            const holiday = holidayHoursToDailySchedule(sitePayload?.holidayHours) ?? null;
            // 지정일자의 그 날짜 시간 — 종일 열림으로 추정하지 않고 저장된 값을 그대로 쓴다.
            const dailyByDate = dateTimesToDailyMap(sitePayload?.dateTimes);
            hospitalRules.value = {...hospitalRules.value, weekly, holiday, dailyByDate};

            // 담당자 운영시간에 얹을 요일별 기관 휴게 (담당자는 휴게를 소유하지 않는다).
            const breaksByWeekday: Partial<Record<Weekday, { range: TimeRange; type: BreakType }[]>> = {};
            for (const row of sitePayload?.site ?? []) {
                const wd = row.dayCd;
                if (wd == null || wd < 0 || wd > 6) continue;
                breaksByWeekday[wd as Weekday] = institutionBreakRanges(row);
            }

            // 그리드 시간축은 요일마다 운영시간이 달라도 모두 담아야 하므로 7요일 전체의 최소~최대로 잡는다.
            // (한 요일만 보면 그 요일이 휴무일 때 시간축이 사라진다.)
            // 공휴일 운영시간은 여기 넣지 않는다 — 1년에 며칠뿐인데 전역 min/max 를 넓히면 평상시 그리드가
            // 늘어난다. 공휴일 당일 밴드는 V3 엔진이 unit(날짜) 단위로 따로 계산한다.
            let minMinutes: number | null = null;
            let maxMinutes: number | null = null;
            for (const daily of Object.values(weekly)) {
                if (!daily?.open) continue;
                const s = hmToMinutes(daily.open.start);
                const e = hmToMinutes(daily.open.end);
                if (s != null && (minMinutes == null || s < minMinutes)) minMinutes = s;
                if (e != null && (maxMinutes == null || e > maxMinutes)) maxMinutes = e;
            }
            treatmentMinHour.value = minMinutes != null ? floorToStep(minMinutes, 30) / 60 : null;
            treatmentMaxHour.value = maxMinutes != null ? ceilToStep(maxMinutes, 30) / 60 : null;

            // ── 담당자별 운영시간: staff → doctorRules (설정한 요일만, 미설정=기관 fallback) ──
            const map: DoctorRuleMap = {};
            for (const m of staffPayload?.staff ?? []) {
                const key = replaceDoctorName(m.staffName);
                if (!key) continue;

                /* times 에는 **정한 요일만** 실려 온다(미설정 요일은 행 자체가 없다).
                 * 그래서 여기 온 행 중 시각이 없는 것은 미설정이 아니라 **명시적 휴무**이다.
                 * null 로 담아야 pickDailySchedule 이 "휴무"으로 읽고 기관 fallback 을 막는다
                 * — 버리면(키 없음) 미설정과 구분이 사라져 쉬는 의사 컬럼이 기관 시간으로 열린다. */
                const docWeekly: Partial<Record<Weekday, DailySchedule | null>> = {};
                for (const row of m.times ?? []) {
                    const wd = row.dayCd;
                    if (wd < 0 || wd > 6) continue;
                    docWeekly[wd as Weekday] = workHoursRowToDailySchedule(row, breaksByWeekday[wd as Weekday]) ?? null;
                }
                map[key] = {weekly: docWeekly};
            }
            doctorRules.value = map;

            return siteBody;
        } catch (e) {
            console.error('[운영시간 > 조회] 실패', e);
        }
    }

    async function loadSchedule() {
        pending.value = true;
        try {
            const [workBody, holidayBody] = await Promise.all([
                loadWorkHours(),
                loadHolidaySettings()
            ]);

            return {scheduleBody: workBody, holidayBody};
        } catch (e) {
            console.error('[운영시간/휴일정보 > 조회] 실패', e);
        } finally {
            pending.value = false;
        }
    }

    return {
        doctors,
        teams,
        loadTeams,
        pending,
        loadDoctor,
        addDoctorName,
        syncDoctor,
        hospitalRules,
        doctorRules,
        loadSchedule,
        treatmentMinHour,
        treatmentMaxHour,
        schedulerDayRange
    };
});
