import {computed, type ComputedRef, type Ref, unref, watch} from 'vue';
import dayjs from 'dayjs';
import {type DailySchedule, type SchedulerRuleSet} from '@/stores/staffStore';
import {DEFAULT_OPERATING_END, DEFAULT_OPERATING_START} from '@/constants/operatingHours';

const DATE_FORMAT = 'YYYY-MM-DD';
const TIME_FORMAT = 'HH:mm';

type MaybeRef<T> = T | Ref<T> | ComputedRef<T>;
type HHMM = string;
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RulePriority = 'HOSPITAL_FIRST' | 'DOCTOR_FIRST'; // 룰 우선 순위 HOSPITAL_FIRST: 병원우선, DOCTOR_FIRST: 의사우선
export type RuleMergePolicy = 'FALLBACK' | 'STRICT'; // 롤 정보 정책 FALLBACK: 값이 없으면 merge, STRICT: 값이 없으면 pass

type TimeRange = {
    start: HHMM;
    end: HHMM
};

type DoctorRuleMap = Record<string, SchedulerRuleSet | null | undefined>;

/** 아무도 그 요일을 정하지 않았을 때의 기본 운영시간 — 병원 표준 09:00~18:00.
 *  값은 `constants/operatingHours` 한 곳에서 온다. 밴드(layoutPipeline)와 **같은 값이어야** 하고,
 *  갈리면 밴드는 열려 있는데 클릭하면 운영시간 밖이라고 막히는 화면이 된다. */
const DEFAULT_OPEN_DAILY = {
    open: {start: DEFAULT_OPERATING_START, end: DEFAULT_OPERATING_END},
    breaks: null,
} as const;

type BlockOptions = {
    lunchBlock?: boolean;   // breaks(LUNCH/DINNER) 막기
    blockedTime?: boolean;  // daily.blocks 막기
    closedDay?: boolean;    // closedDates/closedWeekdays 막기
};

export type BlockReasonType =
    | 'lunch'
    | 'dinner'
    | 'blockedTime'
    | 'closedDate'
    | 'closedWeekday'
    | 'outsideHours';

/** 안내 우선순위 — 휴무 > 휴게시간 > 운영종료. 앞설수록 먼저 알려야 할 사유다. */
const BLOCK_WARNING_PRIORITY: BlockReasonType[] = [
    'closedDate', 'closedWeekday', 'lunch', 'dinner', 'blockedTime', 'outsideHours',
];

/** 여러 칸에 걸친 이동에서 안내할 사유 하나를 고른다(누적 reduce 용).
 *  카드가 운영종료 구간과 휴무 구간을 함께 덮으면 휴무를 알려야 한다 — 뒤 칸이 앞 칸을 덮어쓰면
 *  같은 드롭인데 안내 문구가 놓인 위치에 따라 달라진다. */
export function pickBlockWarning(
    prev: BlockReasonType | null,
    next: BlockReasonType | 'none' | null | undefined,
): BlockReasonType | null {
    if (!next || next === 'none') return prev;
    if (!prev) return next;
    // 우선순위 표에 없는 사유는 맨 뒤로 — 모르는 값이 앞자리를 차지하면 안내가 뒤바뀐다
    const rank = (r: BlockReasonType) => {
        const i = BLOCK_WARNING_PRIORITY.indexOf(r);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return rank(next) < rank(prev) ? next : prev;
}

export type BlockReason =
    | {
    blocked: false;
    source: 'none' | 'hospital' | 'doctor';
    reason: BlockReasonType | 'none';
    groupId: string | null;
    ymd: string;
    weekday: number;
    range?: TimeRange | null;
}
    | {
    blocked: true;
    source: 'hospital' | 'doctor';
    reason: BlockReasonType;
    groupId: string | null;
    ymd: string;
    weekday: number;
    range?: TimeRange | null;
};

type DoctorLike = {
    id: string | number;
    text?: string
};

export type SchedulerRulesOptions = {
    priority?: RulePriority;
    mergePolicy?: RuleMergePolicy;
    enableCache?: boolean;
    cacheMaxEntries?: number;
};

export type UseSchedulerRulesParams = {
    hospitalRules: MaybeRef<SchedulerRuleSet | null | undefined>;
    doctorRules: MaybeRef<DoctorRuleMap | null | undefined>;
    blockOptions: MaybeRef<BlockOptions | null | undefined>;
    selectedDoctors: MaybeRef<Set<string> | null | undefined>;
    cellDuration: MaybeRef<number | null | undefined>;
    doctorsRef?: MaybeRef<DoctorLike[] | null | undefined>;
    options?: MaybeRef<SchedulerRulesOptions | null | undefined>;
};

export function useSchedulerRules({
                                      hospitalRules,
                                      doctorRules,
                                      blockOptions,
                                      selectedDoctors,
                                      cellDuration,
                                      doctorsRef,
                                      options,
                                  }: UseSchedulerRulesParams) {
    const opt = computed(() => unref(options) ?? {});

    const priority = computed<RulePriority>(() => opt.value.priority ?? 'HOSPITAL_FIRST');
    const mergePolicy = computed<RuleMergePolicy>(() => opt.value.mergePolicy ?? 'FALLBACK');
    const enableCache = computed<boolean>(() => opt.value.enableCache ?? true);
    const cacheMaxEntries = computed<number>(() => Math.max(0, opt.value.cacheMaxEntries ?? 5000));

    const reasonCache = new Map<string, BlockReason>();

    function enforceMax(map: Map<string, any>) {
        if (cacheMaxEntries.value <= 0) return;
        while (map.size > cacheMaxEntries.value) {
            const k = map.keys().next().value;
            if (k) map.delete(k);
            else break;
        }
    }

    function clearRuleCache() {
        reasonCache.clear();
    }

    watch(
        () => [
            unref(hospitalRules),
            unref(doctorRules),
            unref(blockOptions),
            Array.from(unref(selectedDoctors) ?? []),
            unref(cellDuration),
            priority.value,
            mergePolicy.value,
        ],
        clearRuleCache,
        {deep: true}
    );

    function hasInSetOrArray<T>(setOrArray: Set<T> | T[] | null | undefined, v: T) {
        if (!setOrArray) return false;
        if (setOrArray instanceof Set) return setOrArray.has(v);
        if (Array.isArray(setOrArray)) return setOrArray.includes(v);
        return false;
    }

    function hhmmToMinutes(hhmm: HHMM) {
        const [hh, mm] = String(hhmm).split(':').map((x) => Number(x));
        return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
    }

    function getCellRange(date: Date | string | number) {
        const start = dayjs(date);
        const stepMin = Math.max(5, Number(unref(cellDuration) ?? 30));
        const end = start.add(stepMin, 'minute');
        return {start, end};
    }

    function minutesOf(d: dayjs.Dayjs) {
        return d.hour() * 60 + d.minute();
    }

    function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
        return Math.max(aStart, bStart) < Math.min(aEnd, bEnd); // [start,end)
    }

    function overlapsByMinutes(
        cellStart: dayjs.Dayjs,
        cellEnd: dayjs.Dayjs,
        startHHMM: HHMM,
        endHHMM: HHMM
    ) {
        const aStart = minutesOf(cellStart);
        const aEnd = minutesOf(cellEnd);
        const bStart = hhmmToMinutes(startHHMM);
        const bEnd = hhmmToMinutes(endHHMM);
        return overlaps(aStart, aEnd, bStart, bEnd);
    }

    function overlapsWithHHMMRange(
        cellStart: dayjs.Dayjs,
        cellEnd: dayjs.Dayjs,
        startHHMM: HHMM,
        endHHMM: HHMM
    ) {
        return overlapsByMinutes(cellStart, cellEnd, startHHMM, endHHMM);
    }

    function buildSourceOrder() {
        return priority.value === 'DOCTOR_FIRST'
            ? (['doctor', 'hospital'] as const)
            : (['hospital', 'doctor'] as const);
    }

    function getDoctorRule(groupId: string | null | undefined) {
        const rules = unref(doctorRules);
        return groupId ? rules?.[groupId] ?? null : null;
    }

    const selectedDoctorList = computed(() => Array.from(unref(selectedDoctors) ?? []));

    function resolveGroupIdForRule(cellGroupId: string | null | undefined) {
        if (cellGroupId) return cellGroupId;
        const list = selectedDoctorList.value;
        if (list.length === 1) return list[0];
        return null;
    }

    function getDoctorNameById(doctorId: string | null) {
        if (!doctorId) return '';
        const list = unref(doctorsRef) ?? [];
        const d = list.find((x) => String(x.id) === String(doctorId));
        return d?.text ?? '';
    }

    /**
     * @param isPublicHoliday 그 날짜가 국가 공휴일인가.
     *
     * <b>공휴일에도 담당자 설정이 우선이다.</b> 담당자가 그 요일을 정해 뒀으면(진료든 휴무가든)
     * 그것을 쓰고, **미설정일 때만** 사업장 공휴일 운영시간을 쓴다 — 평상시 우선순위
     * (담당자 설정 > 기관)를 공휴일이라고 뒤집을 이유가 없다.
     *
     * 공휴일 운영시간 폴백은 네 계층이 같다:
     *   담당자 그 날짜 지정 → 담당자 그 요일 → 사업장 공휴일 → 사업장 요일별 → 09:00~18:00
     *
     * ★기준은 "그 날이 공휴일인가"이지 "사업장이 그 공휴일에 문을 여는가"가 아니다.
     * 공휴일 축은 담당자 자기 값(HOLIDAY_OPEN_YN)이라 사업장이 공휴일 휴무여도 'Y' 인 담당자는 그날 연다.
     * 사업장 기준(holidayOpenDates)으로 가르면 그런 담당자의 시간이 사업장 공휴일 시간을 건너뛰고
     * 요일 시간으로 떨어져, 설정·보기 화면과 답이 갈렸다.
     *
     * 임시운영 지정일도 예외가 아니다 — 그 날짜의 시간은 서버가 저장 시점에 <b>같은 규칙</b>으로 채워
     * (그 요일 사업장 운영시간 → 없으면 09:00~18:00) dateTimes 로 내려오고, 그것이 여기 dateDaily 로
     * 들어와 가장 먼저 쓰인다.
     */
    function pickDailySchedule(
        hr: SchedulerRuleSet | null | undefined,
        dr: SchedulerRuleSet | null | undefined,
        weekday: number,
        isPublicHoliday = false,
        dateDaily?: DailySchedule,
        doctorDateDaily?: DailySchedule
    ) {
        /* -1) 담당자 특정일자 진료 시각이 있으면 **모든 것보다 먼저** 본다 — 담당자 축 안에서
         *     일자 > 요일이고, 담당자 설정이 사업장보다 먼저이므로(§3-1-1) 가장 구체적인 값이다.
         *     담당자 특정일자 휴무는 여기 오기 전에 closedDates 게이트가 막는다(같은 날짜에 둘이 공존하지 않는다).
         *     휴게는 사업장만 소유하므로 그 날짜의 기관 휴게가 있으면 그것으로 간다(store 가 이미 얹지만,
         *     기관 지정일자 시간이 따로 있으면 그쪽이 그 날짜의 값이다). */
        if (doctorDateDaily) {
            return {
                daily: {...doctorDateDaily, breaks: dateDaily?.breaks ?? doctorDateDaily.breaks ?? null} as DailySchedule,
                sourceUsed: 'doctor' as const,
            };
        }

        /* 0) 일자별 지정 시간이 있으면 **요일·공휴일보다 먼저** 본다 — 날짜를 콕 집어 정한 값이라
         *    의도가 가장 구체적이다(BE 운영중 판정도 "일자별 → 공휴일 → 요일별" 순서).
         *    단 기관 축 안에서의 이야기고, 담당자가 그 요일에 운영시간을 정해 뒀으면 담당자가 먼저다
         *    — 공휴일과 같은 규칙. 휴게는 사업장만 소유하므로 담당자 값을 쓸 때도 그 날짜 휴게로 간다. */
        if (dateDaily) {
            const dd = dr?.weekly?.[weekday as Weekday];
            if (typeof dd !== 'undefined') {
                /* 담당자가 그 요일을 정해 뒀으면 그것이 답이다 — 진료면 담당자 시각(휴게만 그 날짜 기관 값),
                 * 휴무(null)이면 휴무. 사업장 임시진료 지정은 사업장 축의 값이라 담당자의 명시 휴무를
                 * 덮지 못한다(§3-1-1: 자기 매주 휴무 > 사업장 상속). 종전에는 null 을 기관 지정 시각으로
                 * 열어, 휴무일 탭 뷰어(휴무)와 보드(열림)가 같은 날짜에 다른 답을 냈다. */
                return {
                    daily: (dd ? {...dd, breaks: dateDaily.breaks ?? null} : null) as DailySchedule | null,
                    sourceUsed: 'doctor' as const,
                };
            }
            return {daily: dateDaily, sourceUsed: 'hospital' as const};
        }

        if (isPublicHoliday) {
            const hd = hr?.holiday;
            const dd = dr?.weekly?.[weekday as Weekday];
            if (typeof dd !== 'undefined') {
                /* 진료 시작·종료는 담당자 값이지만 **휴게는 그 날짜의 기관 값**을 쓴다.
                 * 휴게는 사업장만 소유하고(담당자에는 휴게 필드가 없다), 담당자 daily 에 실려 오는
                 * 휴게는 staffStore 가 병합한 **요일별** 휴게다. 공휴일 휴게를 따로 정해 뒀는데
                 * 담당자가 그 요일을 정했다는 이유로 평일 휴게가 쓰이면 그 설정이 무시된다.
                 * 기관 공휴일 시간 자체가 미설정(hd 없음)이면 바꿀 근거가 없어 그대로 둔다. */
                const daily = dd && hd ? {...dd, breaks: hd.breaks ?? null} : dd;
                return {daily: (daily ?? null) as DailySchedule | null, sourceUsed: 'doctor' as const};
            }
            if (hd) return {daily: hd as DailySchedule, sourceUsed: 'hospital' as const};
            /* 기관 공휴일 시간도 없으면 아래 요일 축으로 내려간다 — 기관 요일별 → 09:00~18:00.
             * 종전에는 daily=undefined 를 돌려 그날을 통째로 열었는데(종일진료), 설정·보기 화면과
             * 타임라인 밴드는 요일 시간을 그려 "화면은 09~18 인데 보드는 종일 열림"이 됐다. */
        }

        const h = hr?.weekly?.[weekday as Weekday];
        const d = dr?.weekly?.[weekday as Weekday];

        const hasH = typeof h !== 'undefined';
        const hasD = typeof d !== 'undefined';

        if (priority.value === 'DOCTOR_FIRST') {
            if (hasD) return {daily: (d ?? null) as DailySchedule | null, sourceUsed: 'doctor' as const};
            if (hasH) return {daily: (h ?? null) as DailySchedule | null, sourceUsed: 'hospital' as const};
        } else {
            if (hasH) return {daily: (h ?? null) as DailySchedule | null, sourceUsed: 'hospital' as const};
            if (hasD) return {daily: (d ?? null) as DailySchedule | null, sourceUsed: 'doctor' as const};
        }

        /* ★담당자도 사업장도 그 요일을 정하지 않았다 — **기본 운영시간 09:00~18:00 으로 연다.**
         * 종전에는 null(= 명시적 휴무)로 접어 휴무처럼 막았는데, 그건 정한 적 없는 휴무를 만들어 내는 것이었다.
         * 사업장이 매주 쉬는 요일에는 운영시간 행 자체가 없어서, 그 요일을 스스로 정한(= 기관 휴무를
         * 상속하지 않는) 담당자까지 이 폴백에 걸려 열리지 않았다.
         * 기관 휴무를 그대로 상속하는 담당자는 여기 오기 전에 closedWeekdays 검사가 이미 막는다. */
        return {daily: DEFAULT_OPEN_DAILY, sourceUsed: null as const};
    }

    function makeKey(date: Date | string | number, groupIdOrNull: string | null | undefined) {
        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const hm = d.format(TIME_FORMAT);
        const gid = resolveGroupIdForRule(groupIdOrNull) ?? '';
        const opt = unref(blockOptions);
        const flags = `${opt?.lunchBlock ? 1 : 0}${opt?.blockedTime ? 1 : 0}${opt?.closedDay ? 1 : 0}`;
        return `${ymd}|${hm}|${gid}|${flags}|${priority.value}|${mergePolicy.value}`;
    }

    function makeCacheKey(date: Date | string | number, groupIdOrNull: string | null | undefined) {
        return makeKey(date, groupIdOrNull);
    }

    function createBlockedReason(params: {
        blocked: boolean;
        source: 'hospital' | 'doctor' | 'none';
        reason: BlockReasonType | 'none';
        groupId: string | null;
        ymd: string;
        weekday: number;
        range?: TimeRange | null;
    }): BlockReason {
        return {
            blocked: params.blocked as any,
            source: params.source,
            reason: params.reason,
            groupId: params.groupId,
            ymd: params.ymd,
            weekday: params.weekday,
            range: params.range ?? null,
        } as BlockReason;
    }

    function getPrimaryFallbackForSource(
        src: 'hospital' | 'doctor',
        hr: SchedulerRuleSet | null | undefined,
        dr: SchedulerRuleSet | null | undefined
    ) {
        const primary = src === 'hospital' ? hr : dr;
        const fallback = mergePolicy.value === 'FALLBACK' ? (src === 'hospital' ? dr : hr) : null;
        return {primary, fallback};
    }

    /**
     * 그 날짜에 이 담당자가 **진료로 정했는가** — 사업장 휴무를 덮는 근거(R11, 사용자 확정).
     * "사업장이 휴무인데 담당자가 휴무가 아니면 담당자를 따른다."
     *
     * 담당자 축 안에서는 구체적인 것이 이긴다 — 자기 특정일자 휴무 > 자기 특정일자 진료 >
     * 자기 매주 휴무 > 자기 진료 요일. 자기 휴무가 하나라도 걸리면 덮지 않는다(그 담당자는 쉬는 날이다).
     * ⚠️ 이 판정의 SSOT 는 store 다 — 여기서 규칙을 다시 조립하지 않고 채워진 집합만 읽는다
     *    (매월 N번째·공휴일 전개는 buildHolidayClosure 가 이미 closedDates 로 접어 넣었다).
     */
    function isDoctorWorkOverride(
        dr: SchedulerRuleSet | null | undefined,
        ymd: string,
        weekday: number,
    ) {
        if (!dr) return false;
        if (hasInSetOrArray(dr.closedDates as any, ymd)) return false;
        if (hasInSetOrArray(dr.workDates as any, ymd)) return true;
        if (hasInSetOrArray(dr.closedWeekdays as any, weekday)) return false;
        return hasInSetOrArray(dr.workWeekdays as any, weekday);
    }

    /**
     * 사업장 휴무 중 **이 담당자에게 상속되는 것**인가 — 상속은 축 단위다(§4-2).
     * 설정 화면 `inheritedInstitutionOff` 와 같은 규칙이어야 한다. 갈리면 설정에서 진료로 보이는 날에
     * 보드가 예약을 막는다(같은 규칙이 두 벌인 자리라, 한쪽만 고쳐 두 번 어긋난 적이 있다).
     *
     * - 일자 축을 하나도 정하지 않았으면 사업장 **일자 지정**을 따른다
     * - 요일 축을 하나도 정하지 않았으면 사업장 **반복 휴무**(요일 · 매월 N번째 전개)을 따른다
     * - **공휴일에서 온 휴무는 따르지 않는다** — `HOLIDAY_OPEN_YN` 이 NOT NULL 2상태라 공휴일은 늘 자기 값이고,
     *   기관 값은 팀 배치 시점에 이미 복사돼 있다(§3-2). 런타임으로 또 내려받으면 "공휴일에도 진료"로
     *   정해 둔 담당자가 기관 공휴일 휴무를 상속해 휴무가 된다.
     *
     * closedDates 는 이 셋을 합쳐 둔 값이라 그대로는 축을 가를 수 없다 — 그래서 출처별 집합을 본다.
     * 담당자 규칙이 없는 대상(dr 없음)은 종전대로 사업장 판정을 그대로 받는다.
     */
    function inheritsHospitalClosedDate(
        hr: SchedulerRuleSet | null | undefined,
        dr: SchedulerRuleSet | null | undefined,
        ymd: string,
    ) {
        /* 판정의 기준은 종전대로 closedDates 다 — 여기서 휴무를 **새로 만들지 않는다**.
         * 출처별 집합은 그 휴무가 어느 축에서 왔는지 가르는 데만 쓴다. */
        if (!hasInSetOrArray(hr?.closedDates as any, ymd)) return false;
        if (!dr) return true;
        /* 출처를 갈라 두지 않은 rule set 은 어느 축인지 알 수 없다 — 종전대로 전부 상속한다.
         * 모른다고 상속을 끊으면 사업장이 닫은 날에 예약이 조용히 열린다. */
        if (!hr?.designatedOffDates && !hr?.recurringClosedDates) return true;

        if (hasInSetOrArray(hr?.designatedOffDates as any, ymd)) return dr.inheritsHospitalDateOff !== false;
        if (hasInSetOrArray(hr?.recurringClosedDates as any, ymd)) return dr.inheritsHospitalWeekdayOff !== false;
        return false;   // 남은 사유는 공휴일뿐 — 담당자 자기 축이라 상속하지 않는다
    }

    /* 공휴일에는 사업장 **요일** 휴무를 상속하지 않는다 — 기관 축도 공휴일이면 반복 휴무를 보지 않고
     * 공휴일 스위치로만 가르기 때문이다(설정 화면 isNaturallyOff 와 같은 규약). 그 스위치만 빼고 요일
     * 규칙이 대신 들어오면, 기관이 진료하는 공휴일에 정한 것 없는 담당자만 쉬게 된다. */
    function inheritsHospitalClosedWeekday(
        hr: SchedulerRuleSet | null | undefined,
        dr: SchedulerRuleSet | null | undefined,
        weekday: number,
        ymd: string,
    ) {
        if (!hasInSetOrArray(hr?.closedWeekdays as any, weekday)) return false;
        if (!dr) return true;
        if (hasInSetOrArray(hr?.publicHolidayDates as any, ymd)) return false;
        return dr.inheritsHospitalWeekdayOff !== false;
    }

    function normalizeBreakReason(type?: string) {
        return type === 'DINNER' ? 'dinner' : 'lunch';
    }

    function pickReason(date: Date | string | number, groupIdOrNull: string | null | undefined) {
        const opt = unref(blockOptions);
        const hr = unref(hospitalRules);
        const resolvedGroupId = resolveGroupIdForRule(groupIdOrNull);
        const dr = resolvedGroupId ? getDoctorRule(resolvedGroupId) : null;

        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const weekday = d.day();

        const {start: cellStart, end: cellEnd} = getCellRange(date);

        // holidayWork 여부는 “리턴”이 아니라 “휴무 조건만 무시”하는 플래그: holidayWork면 근무요일로 지정
        // 공휴일 진료일도 같은 성격 — 요일 휴무(closedWeekdays)·요일 dayOffYn 을 무시해야 한다.
        const isHolidayOpen = isHolidayOpenDate(date);
        /* 운영시간 소스를 고르는 기준은 "그 날이 공휴일인가"다 — 기관이 그 공휴일에 문을 여는지
         * (isHolidayOpen)와 별개다. 공휴일 축은 담당자 자기 값이라 기관이 쉬어도 그날 여는 담당자가 있다. */
        const isPublicHoliday = isPublicHolidayDate(date);
        const isWorkOverride = isHolidayWorkDate(date) || isHolidayOpen;
        /* ★임시진료 지정일·공휴일 진료일이 덮는 것은 **사업장** 휴무뿐이다 — 담당자가 명시적으로
         * 휴무로 정해 뒀으면 사업장이 그날 진료한다고 출근시킬 수 없다(§3-1-1 담당자 우선).
         * 종전에는 임시진료 지정일만 담당자 휴무까지 덮었는데(R11 이전 잔재), 휴무일 탭 뷰어는
         * 담당자 매주 휴무를 그대로 휴무로 보여 같은 날짜에 보드와 답이 갈렸다. */

        /* ★공휴일 진료일인데 사업장 공휴일 운영시간이 미설정이어도 **그날은 종일진료다**(휴무 아님).
         * 진료하기로 한 의도를 시간 미입력이 뒤집지 않는다 — 임시진료 지정일(workDates)과 같은 취급이고
         * 서버 운영시간 판정의 3) 분기, 사업장 설정와도 같은 규칙이다.
         * 설정화면이 공휴일 운영시간 입력을 강제하는 것(HOLIDAY_TIME_REQUIRED_MSG)은 별개 축이다 —
         * 판정이 아니라 "하루가 통째로 열리는" 입력 누락을 저장 시점에 잡는 게이트다.
         * ★담당자가 그 요일을 정해 뒀으면 그 값이 이긴다(담당자 우선 유지 — daily 가 undefined 가 아니다). */

        /* 그 날짜에 실제로 저장된 사업장 운영시간(지정일자). 있으면 종일 열림으로 추정하지 않는다. */
        const dateDaily = hr?.dailyByDate?.[ymd];
        /* 그 날짜에 이 담당자가 저장한 특정일자 진료 시각. 있으면 요일·기관 시각보다 먼저다. */
        const doctorDateDaily = dr?.dailyByDate?.[ymd];

        const order = buildSourceOrder();

        for (const src of order) {
            const {primary, fallback} = getPrimaryFallbackForSource(src, hr, dr);

            // 1) 휴무(날짜/요일)
            if (opt?.closedDay) {
                /* 사업장 소스는 **이 담당자에게 상속되는 것만** 본다 — 상속은 축 단위다(§4-2).
                 * 담당자 소스는 종전대로 자기 값이다. */
                const cdHit = src === 'hospital'
                    ? inheritsHospitalClosedDate(hr, dr, ymd)
                    : hasInSetOrArray((primary?.closedDates ?? fallback?.closedDates ?? null) as any, ymd);
                /* 이 소스가 자기 요일휴무를 갖고 있는가 — 없어서 다른 소스 것을 빌려 쓰면 규약도 함께 빌린다.
                 * (담당자가 요일을 정하지 않았으면 그 요일은 사업장 것이고, 공휴일 규약도 사업장 것이다.) */
                const ownCw = primary?.closedWeekdays ?? null;
                const cwHit = src === 'hospital'
                    ? inheritsHospitalClosedWeekday(hr, dr, weekday, ymd)
                    : hasInSetOrArray((ownCw ?? fallback?.closedWeekdays ?? null) as any, weekday);

                /* 사업장 휴무는 그 담당자가 진료로 정해 뒀으면 덮인다(R11). 담당자 소스에서도 같은 판정을
                 * 쓴다 — isDoctorWorkOverride 는 자기 휴무(특정일자·매주)을 먼저 보므로 자기 휴무를 자기가
                 * 무시하는 일은 없고, 자기 **특정일자 진료가 자기 매주 휴무를 덮는** 경우(일자 > 요일)만 통과한다. */
                const doctorWorks = isDoctorWorkOverride(dr, ymd, weekday);

                // closedDates는 store에서 holidayWork 제거 후 데이터 -> 그대로 return
                if (!doctorWorks && cdHit) {
                    return {blocked: true as const, source: src, reason: 'closedDate' as const, range: null as TimeRange | null};
                }

                /* 요일휴무를 무시하는 조건은 소스마다 다르다.
                 *  - 사업장 소스: 임시진료 지정일·공휴일 진료일이면 그 요일 휴무는 무시한다(기관 축 안에서 일자 > 요일).
                 *  - 담당자 소스: **자기 요일휴무는 아무것도 건너뛰지 않는다.** 사업장의 임시진료 지정은
                 *    담당자 매주 휴무를 덮지 못하고(§3-1-1), 공휴일 진료('Y')도 "공휴일이라는 이유로는 쉬지
                 *    않는다"는 뜻일 뿐이라 요일 휴무를 덮지 않는다(§4-2 2단계) — 매주 금요일 쉬는 담당자가
                 *    금요일 공휴일에 나온다는 결론은 성립하지 않는다. 자기 특정일자 진료만 doctorWorks 로
                 *    요일을 이긴다(일자 > 요일).
                 *    단 **빌려 온 요일휴무**(ownCw 없음 = 그 요일을 정하지 않아 사업장 것을 쓰는 경우)에는
                 *    사업장 규약을 그대로 적용한다 — 기관이 진료하는 공휴일에 미설정 담당자만 쉴 수는 없다. */
                const skipWeekday = src === 'doctor' ? (ownCw === null && isWorkOverride) : isWorkOverride;
                if (!skipWeekday && !doctorWorks && cwHit) {
                    return {blocked: true as const, source: src, reason: 'closedWeekday' as const, range: null as TimeRange | null};
                }
            }

            // 2) weekly(open) 기반 운영시간
            // ⚠️ pickDailySchedule 은 (hospitalRules, doctorRules) 고정 순서로 호출해야 한다.
            //   내부에서 priority(HOSPITAL_FIRST/DOCTOR_FIRST)로 소스를 고르는데,
            //   여기서 src 기반 (primary, fallback) 을 넘기면 DOCTOR_FIRST 일 때 인자가 뒤집혀
            //   (의사, 기관) → 내부 priority 재적용으로 이중 swap → 의사 운영시간이 설정돼 있어도
            //   기관 daily(점심 포함)를 반환하던 버그. hr/dr 직접 전달로 한 번만 priority 적용.
            const dailyPick = pickDailySchedule(hr, dr, weekday, isPublicHoliday, dateDaily, doctorDateDaily);
            const daily = dailyPick.daily as (DailySchedule | null);

            // 3) daily 처리: undefined(정보없음) vs null(명시적 휴무) 분리
            // - undefined: 이 소스에 요일 정보가 없음 → 다음 소스로 넘어감(continue)
            // - null:      이 소스가 "명시적으로 휴무"를 선언 → fallback 금지, 여기서 바로 막음
            if (daily === null) {
                // 담당자가 선언한 휴무는 임시진료 지정일·공휴일 진료일이 덮지 않는다(위 주석 참조).
                if (isWorkOverride && dailyPick.sourceUsed !== 'doctor') {
                    return {blocked: false as const, source: 'none' as const, reason: 'none' as const, range: null};
                }
                return {blocked: true as const, source: (dailyPick.sourceUsed ?? src), reason: 'outsideHours' as const, range: null};
            }

            if (typeof daily === 'undefined') {
                // 공휴일 진료일 + 담당자 미설정 + 기관 공휴일 시간 미설정 → 종일진료(위 주석 참조).
                // 담당자가 그 요일을 정해 뒀다면 daily 가 undefined 가 아니므로 여기 오지 않는다.
                if (isWorkOverride) {
                    return {blocked: false as const, source: 'none' as const, reason: 'none' as const, range: null};
                }
                continue;
            }

            const dayOffYn = daily?.dayOffYn;

            // 4) holidayWork가 아니면 dayOffYn=Y를 휴무로 처리
            if (!isWorkOverride && dayOffYn === 'Y') {
                return {blocked: true as const, source: (dailyPick.sourceUsed ?? src), reason: 'outsideHours' as const, range: null};
            }

            // open 유효성 체크 (start/end 둘 다 있어야 “근무시간”으로 인정)
            const open = daily.open;
            const hasOpenRange = !!(open?.start && open?.end);

            // open 정보가 없으면
            if (!hasOpenRange) {
                // holidayWork·공휴일 진료일이면 "하루종일 오픈" 처리(= 밖/점심/저녁 표시 안 뜨게).
                // ※ staffStore 의 변환기는 시작·종료가 없는 행을 daily 자체가 undefined(미설정)로 만들므로
                //    (휴게 행만 있어도 같다) 여기로 오는 "open 없는 daily" 는 원천 데이터에서는 생기지 않는다.
                //    미설정 공휴일은 위의 typeof daily === 'undefined' 분기 → 기관 요일 시간으로 내려간다.
                if (isWorkOverride) {
                    return {blocked: false as const, source: 'none' as const, reason: 'none' as const, range: null};
                }
                // holidayWork 아니면 기존처럼 운영시간 외
                return {blocked: true as const, source: (dailyPick.sourceUsed ?? src), reason: 'outsideHours' as const, range: null};
            }

            // open 밖이면 breaks가 있어도 무조건 outsideHours
            const inOpen = overlapsWithHHMMRange(cellStart, cellEnd, open!.start, open!.end);
            if (!inOpen) {
                return {blocked: true as const, source: (dailyPick.sourceUsed ?? src), reason: 'outsideHours' as const, range: open!};
            }

            // CLOSED break = OFF 된 세션이 만든 비운영 구간(open 안이지만 진료 안 함) → 운영종료(outsideHours).
            //   점심/저녁이 아니라 lunchBlock 옵션과 무관하게 차단. 클릭 시 "운영종료 시간" alert.
            const closedHit = (daily.breaks ?? []).find(
                (r) => r.type === 'CLOSED' && overlapsWithHHMMRange(cellStart, cellEnd, r.start, r.end),
            );
            if (closedHit) {
                return {blocked: true as const, source: (dailyPick.sourceUsed ?? src), reason: 'outsideHours' as const, range: {start: closedHit.start, end: closedHit.end}};
            }

            // 5) breaks: 점심시간/저녁시간
            if (opt?.lunchBlock) {
                const breaks = daily.breaks ?? [];
                const hit = breaks.find((r) => overlapsWithHHMMRange(cellStart, cellEnd, r.start, r.end));
                if (hit) {
                    const rr = normalizeBreakReason(hit.type);
                    return {
                        blocked: false as const,
                        source: (dailyPick.sourceUsed ?? src),
                        reason: rr as any,
                        range: {start: hit.start, end: hit.end},
                    };
                }
            }

            // 6) blocks: 그 외 휴무시간
            if (opt?.blockedTime) {
                const blocks = daily.blocks ?? [];
                const hit = blocks.find((r) => overlapsWithHHMMRange(cellStart, cellEnd, r.start, r.end));
                if (hit) {
                    return {
                        blocked: false as const,
                        source: (dailyPick.sourceUsed ?? src),
                        reason: 'blockedTime' as const,
                        range: {start: hit.start, end: hit.end},
                    };
                }
            }
        }

        return {blocked: false as const, source: 'none' as const, reason: 'none' as const, range: null as TimeRange | null};
    }


    function getBlockedReason(
        date: Date | string | number,
        groupIdOrNull: string | null | undefined
    ): BlockReason {
        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const weekday = d.day();
        const finalGroupId = resolveGroupIdForRule(groupIdOrNull);

        if (enableCache.value) {
            const k = makeCacheKey(date, groupIdOrNull);
            const cached = reasonCache.get(k);
            if (cached) return cached;

            const picked = pickReason(date, groupIdOrNull);
            const r: BlockReason = createBlockedReason({
                blocked: picked.blocked,
                source: picked.source,
                reason: picked.reason as any,
                groupId: finalGroupId,
                ymd,
                weekday,
                range: picked.range ?? null,
            });

            reasonCache.set(k, r);
            enforceMax(reasonCache);
            return r;
        }

        const picked = pickReason(date, groupIdOrNull);
        return createBlockedReason({
            blocked: picked.blocked,
            source: picked.source,
            reason: picked.reason as any,
            groupId: finalGroupId,
            ymd,
            weekday,
            range: picked.range ?? null,
        });
    }

    function isBlockedSlot(date: Date | string | number, groupIdOrNull: string | null | undefined) {
        return getBlockedReason(date, groupIdOrNull).blocked;
    }

    function isBlockedRange(
        startDate: Date | string | number,
        groupIdOrNull: string | null | undefined
    ) {
        const r = getBlockedReason(startDate, groupIdOrNull);
        return r.blocked;
    }

    function isClosedDayForHeader(
        date: Date | string | number,
        groupIdOrNull: string | null | undefined
    ) {
        const hr = unref(hospitalRules);
        const resolvedGroupId = resolveGroupIdForRule(groupIdOrNull);
        const dr = resolvedGroupId ? getDoctorRule(resolvedGroupId) : null;

        // holidayWork면 요일휴무/dayOffYn은 무시 (네 로직 그대로 유지). 공휴일 진료일도 동일.
        const isHolidayOpen = isHolidayOpenDate(date);
        /* 운영시간 소스를 고르는 기준은 "그 날이 공휴일인가"다 — 기관이 그 공휴일에 문을 여는지
         * (isHolidayOpen)와 별개다. 공휴일 축은 담당자 자기 값이라 기관이 쉬어도 그날 여는 담당자가 있다. */
        const isPublicHoliday = isPublicHolidayDate(date);
        const isWorkOverride = isHolidayWorkDate(date) || isHolidayOpen;
        // pickReason 과 같은 규약 — 임시진료 지정일·공휴일 진료일은 담당자가 선언한 휴무까지 덮지는 않는다.

        /* ★공휴일 진료일은 기관 공휴일 운영시간이 미설정이어도 휴무 배지를 띄우지 않는다 — 종일진료다.
         * pickReason 과 **반드시 같은 규칙**이어야 한다. 갈리면 "예약은 막히는데 배지는 안 뜬다"
         * (또는 그 반대)가 되어 사용자가 이유를 모른 채 아무 칸도 누르지 못하는 화면이 된다. */

        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const weekday = d.day() as Weekday;

        // pickReason 과 같은 값을 써야 배지와 차단이 갈리지 않는다.
        const dateDaily = hr?.dailyByDate?.[ymd];
        const doctorDateDaily = dr?.dailyByDate?.[ymd];

        const order = buildSourceOrder();

        for (const src of order) {
            const {primary, fallback} = getPrimaryFallbackForSource(src, hr, dr);

            // 1) closedDates / closedWeekdays
            if (unref(blockOptions)?.closedDay) {
                /* pickReason 과 같은 규약 — 사업장 소스는 이 담당자에게 상속되는 것만 본다(축 단위, §4-2). */
                const cdHit = src === 'hospital'
                    ? inheritsHospitalClosedDate(hr, dr, ymd)
                    : hasInSetOrArray((primary?.closedDates ?? fallback?.closedDates ?? null) as any, ymd);
                /* 이 소스가 자기 요일휴무를 갖고 있는가 — 없어서 다른 소스 것을 빌려 쓰면 규약도 함께 빌린다.
                 * (담당자가 요일을 정하지 않았으면 그 요일은 사업장 것이고, 공휴일 규약도 사업장 것이다.) */
                const ownCw = primary?.closedWeekdays ?? null;
                const cwHit = src === 'hospital'
                    ? inheritsHospitalClosedWeekday(hr, dr, weekday, ymd)
                    : hasInSetOrArray((ownCw ?? fallback?.closedWeekdays ?? null) as any, weekday);
                // pickReason 과 같은 규약 — 담당자가 진료로 정한 날은 사업장 휴무 배지를 띄우지 않는다(R11).
                const doctorWorks = isDoctorWorkOverride(dr, ymd, weekday);

                if (!doctorWorks && cdHit) return true;
                /* pickReason 과 같은 조건 — 담당자가 정한 매주 휴무는 사업장 임시진료도, 공휴일 진료('Y')도
                 * 덮지 못한다. 빌려 온 요일휴무(ownCw 없음)에만 사업장 규약을 적용한다. */
                const skipWeekday = src === 'doctor' ? (ownCw === null && isWorkOverride) : isWorkOverride;
                if (!skipWeekday && !doctorWorks && cwHit) return true;
            }

            // 2) weekly daily 정보 기반 "하루 휴무" 판단
            // ⚠️ pickReason 과 동일 — (hr, dr) 고정 호출. (primary, fallback) 을 넘기면 DOCTOR_FIRST 일 때
            //   인자 swap 으로 의사 휴무 판정이 기관 daily 로 어긋남.
            const dailyPick = pickDailySchedule(hr, dr, weekday, isPublicHoliday, dateDaily, doctorDateDaily);
            const daily = dailyPick.daily as (DailySchedule | null);

            /* null = 그 소스가 선언한 **명시적 휴무** → 하루휴무 배지. undefined = 정보 없음 → 다음 소스.
             * 둘을 묶어 continue 하면, 담당자가 휴무로 정한 요일에 예약은 막히는데(pickReason)
             * 배지는 안 떠 화면이 서로 어긋난다. */
            if (daily === null) {
                if (isWorkOverride && dailyPick.sourceUsed !== 'doctor') continue;
                return true;
            }
            if (typeof daily === 'undefined') {
                // 공휴일 진료일인데 기관 공휴일 시간이 미설정이어도 휴무가 아니다 — 종일진료(pickReason 과 같은 규칙).
                continue;
            }

            // holidayWork가 아니면 dayOffYn=Y는 하루휴무
            if (!isWorkOverride && daily?.dayOffYn === 'Y') return true;

            // open이 null이면 (스토어 모델상) 하루휴무 취급
            if (daily.open === null) return true;

            // open.start/end 둘 다 없으면 하루휴무로 볼지 정책 선택:
            // - 휴무로 보려면 true, 아니면 false
            const open = daily.open;
            const hasOpenRange = !!(open?.start && open?.end);
            if (!hasOpenRange && !isWorkOverride) return true;
        }

        return false;
    }

    function explainBlockedReason(date: Date | string | number, groupIdOrNull: string | null | undefined) {
        const r = getBlockedReason(date, groupIdOrNull);
        if (!r.blocked) return '';

        const doctorName = getDoctorNameById(r.groupId);
        const who = r.source === 'hospital' ? '병원 공통' : doctorName ? `의사(${doctorName})` : '의사';

        switch (r.reason) {
            case 'outsideHours':
                return r.range ? `${who} 운영시간 외(${r.range.start}~${r.range.end})` : `${who} 휴무`;
            case 'lunch':
                return `${who} 휴게시간1(${r.range?.start}~${r.range?.end})`;
            case 'dinner':
                return `${who} 휴게시간2(${r.range?.start}~${r.range?.end})`;
            case 'blockedTime':
                return `${who} 휴게시간(${r.range?.start}~${r.range?.end})`;
            case 'closedDate':
                return `${who} 휴무일(${r.ymd})`;
            case 'closedWeekday': {
                const names = ['일', '월', '화', '수', '목', '금', '토'] as const;
                return `${who} 휴무요일(${names[r.weekday]})`;
            }
            default:
                return `${who} 예약 불가`;
        }
    }

    function isHolidayWorkDate(date: Date | string | number) {
        const hr = unref(hospitalRules);
        if (!hr) return false;
        const ymd = dayjs(date).format('YYYY-MM-DD');
        return hasInSetOrArray(hr.holidayWorkDates as any, ymd);
    }

    /** 사업장이 문을 여는 공휴일(= 공휴일 − 최종 휴무일). 이 날은 **기관 축의** 요일 휴무를 무시한다
     *  — 공휴일이면 holidayClosedYn 만 보는 규칙(BE isClosedToday 와 동일). 휴무 판정 전용이다. */
    function isHolidayOpenDate(date: Date | string | number) {
        const hr = unref(hospitalRules);
        if (!hr) return false;
        const ymd = dayjs(date).format('YYYY-MM-DD');
        return hasInSetOrArray(hr.holidayOpenDates as any, ymd);
    }

    /** 그 날짜가 국가 공휴일인가 — 사업장이 그날 문을 여는지와 무관한 날짜 자체의 성질.
     *  **운영시간 소스**를 고를 때 쓴다(설정 화면 isHolidayDate 와 같은 기준). */
    function isPublicHolidayDate(date: Date | string | number) {
        const hr = unref(hospitalRules);
        if (!hr) return false;
        const ymd = dayjs(date).format('YYYY-MM-DD');
        return hasInSetOrArray(hr.publicHolidayDates as any, ymd);
    }

    function isHospitalClosedDayForHeader(date: Date | string | number) {
        const hr = unref(hospitalRules);
        if (!hr) return false;

        // holidayWork면 근무요일로 지정. 공휴일 진료일도 마찬가지로 휴무가 아니다
        // (요일 휴무와 겹쳐도 공휴일 판정이 이긴다 — 아래 weekly/closedWeekdays 검사에 도달하지 않는다).
        const isWorkOverride = isHolidayWorkDate(date) || isHolidayOpenDate(date);
        if (isWorkOverride) return false;

        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const weekday = d.day() as Weekday;

        if (hasInSetOrArray(hr.closedDates as any, ymd)) return true;
        if (hasInSetOrArray(hr.closedWeekdays as any, weekday)) return true;

        const daily = hr.weekly?.[weekday];

        if (typeof daily !== 'undefined' && daily?.dayOffYn === 'Y') return true;

        if (typeof daily !== 'undefined' && daily?.open === null) return true;

        return false;
    }

    /**
     * 사업장 휴무가 **이 담당자 칸에** 적용되는가 — 헤더 담당자 칸의 '휴무' 뱃지·예약 팝업의 휴무일 플래그용.
     *
     * isHospitalClosedDayForHeader 는 사업장만 보는 순수 판정(날짜 행용)이라 담당자를 모른다. 그 값을
     * 담당자 칸에 그대로 쓰면 R11(담당자가 진료로 정했으면 사업장 휴무를 덮는다)이 셀(pickReason)에는
     * 적용되고 뱃지에는 적용되지 않아 "뱃지는 휴무인데 셀은 열려 있는" 화면이 된다.
     */
    function isHospitalClosedDayForDoctor(
        date: Date | string | number,
        groupIdOrNull: string | null | undefined
    ) {
        if (!isHospitalClosedDayForHeader(date)) return false;
        const resolvedGroupId = resolveGroupIdForRule(groupIdOrNull);
        const dr = resolvedGroupId ? getDoctorRule(resolvedGroupId) : null;
        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const weekday = d.day() as Weekday;

        if (isDoctorWorkOverride(dr, ymd, weekday)) return false;
        if (!dr) return true;

        /* 여기부터는 pickReason 과 같은 축 단위 상속(§4-2) — 스스로 정한 축은 사업장 **휴무 규칙**을
         * 따라가지 않는다. 기관 휴무의 출처로 축을 가른다: 일자 지정이면 일자 축, 반복 휴무가면 요일 축. */
        const hr = unref(hospitalRules);
        if (inheritsHospitalClosedDate(hr, dr, ymd)) return true;
        if (inheritsHospitalClosedWeekday(hr, dr, weekday, ymd)) return true;

        /* 여기까지 왔으면 이 담당자는 그 축을 스스로 정해 기관 휴무를 따라가지 않는다 — 배지도 붙이지 않는다.
         * ★그 요일에 열 시간이 없어 셀이 막히는 것과는 다른 이야기다. 그건 휴무가 아니라 시간의 부재이고,
         *  "휴무" 이라고 적으면 정한 적 없는 휴무를 화면이 지어내는 셈이 된다. */
        return false;
    }

    return {
        // core
        resolveGroupIdForRule,
        isBlockedSlot,
        isBlockedRange,

        // header helper
        isHospitalClosedDayForHeader,
        isHospitalClosedDayForDoctor,
        isClosedDayForHeader,

        // reason / explain
        getBlockedReason,
        explainBlockedReason,

        // cache
        clearRuleCache,
    };
}
