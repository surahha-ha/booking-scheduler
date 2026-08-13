import {computed, type ComputedRef, type Ref, unref, watch} from 'vue';
import dayjs from 'dayjs';
import {type DailySchedule, type SchedulerRuleSet} from '@/stores/staffStore';

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
     * @param isHolidayOpen 공휴일이면서 진료하는 날.
     *
     * <b>공휴일에도 담당자 설정이 우선이다.</b> 담당자가 그 요일을 정해 뒀으면(진료든 휴무가든)
     * 그것을 쓰고, **미설정일 때만** 사업장 공휴일 운영시간을 쓴다 — 평상시 우선순위
     * (담당자 설정 > 기관)를 공휴일이라고 뒤집을 이유가 없다.
     *
     * 기관 공휴일 시간도 미설정이면 daily=undefined 로 돌려보낸다. 기관 요일 시간으로는 폴백하지 않는다
     * — 공휴일이 매주 휴무 요일과 겹치면 그 요일엔 시간이 없어 엉뚱하게 뒤집히기 때문.
     * 그 undefined 는 호출측이 **종일진료**로 마감한다(isWorkOverride 경로) — 공휴일에 진료하기로 한
     * 의도를 시간 미입력이 뒤집지 않는다(BE 서버 운영시간 판정 3) 분기와 같은 규칙).
     */
    function pickDailySchedule(
        hr: SchedulerRuleSet | null | undefined,
        dr: SchedulerRuleSet | null | undefined,
        weekday: number,
        isHolidayOpen = false,
        dateDaily?: DailySchedule
    ) {
        /* 0) 일자별 지정 시간이 있으면 **요일·공휴일보다 먼저** 본다 — 날짜를 콕 집어 정한 값이라
         *    의도가 가장 구체적이다(BE 운영중 판정도 "일자별 → 공휴일 → 요일별" 순서).
         *    단 기관 축 안에서의 이야기고, 담당자가 그 요일에 운영시간을 정해 뒀으면 담당자가 먼저다
         *    — 공휴일과 같은 규칙. 휴게는 사업장만 소유하므로 담당자 값을 쓸 때도 그 날짜 휴게로 간다. */
        if (dateDaily) {
            const dd = dr?.weekly?.[weekday as Weekday];
            if (dd) {
                return {daily: {...dd, breaks: dateDaily.breaks ?? null} as DailySchedule, sourceUsed: 'doctor' as const};
            }
            /* dd === null(담당자 명시 휴무)도 여기로 온다 — 그 날짜를 진료로 콕 집어 지정한 것이
             * 더 구체적이라 덮는다(기존 overrideBeatsDoctor 와 같은 취지). 종전에는 이 경우
             * "종일 열림"이었는데, 이제는 그 날짜에 저장된 시간으로 판정한다. */
            return {daily: dateDaily, sourceUsed: 'hospital' as const};
        }

        if (isHolidayOpen) {
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
            return {daily: undefined, sourceUsed: null as const};
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

        return {daily: null, sourceUsed: null as const};
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
        const isWorkOverride = isHolidayWorkDate(date) || isHolidayOpen;
        /* ★단, 공휴일 진료일이 덮는 것은 **사업장** 휴무뿐이다 — 담당자가 그 요일을 명시적으로
         * 휴무로 정해 뒀으면 공휴일이라고 출근시킬 수 없다(담당자 설정 우선).
         * 임시진료 지정일(workDates)은 종전대로 담당자 휴무까지 덮는다 — 그 날짜를 콕 집어
         * "진료한다"고 지정한 것이라 의도가 더 구체적이다. */
        const overrideBeatsDoctor = isHolidayWorkDate(date);

        /* ★공휴일 진료일인데 사업장 공휴일 운영시간이 미설정이어도 **그날은 종일진료다**(휴무 아님).
         * 진료하기로 한 의도를 시간 미입력이 뒤집지 않는다 — 임시진료 지정일(workDates)과 같은 취급이고
         * 서버 운영시간 판정의 3) 분기, 사업장 설정와도 같은 규칙이다.
         * 설정화면이 공휴일 운영시간 입력을 강제하는 것(HOLIDAY_TIME_REQUIRED_MSG)은 별개 축이다 —
         * 판정이 아니라 "하루가 통째로 열리는" 입력 누락을 저장 시점에 잡는 게이트다.
         * ★담당자가 그 요일을 정해 뒀으면 그 값이 이긴다(담당자 우선 유지 — daily 가 undefined 가 아니다). */

        /* 그 날짜에 실제로 저장된 사업장 운영시간(지정일자). 있으면 종일 열림으로 추정하지 않는다. */
        const dateDaily = hr?.dailyByDate?.[ymd];

        const order = buildSourceOrder();

        for (const src of order) {
            const {primary, fallback} = getPrimaryFallbackForSource(src, hr, dr);

            // 1) 휴무(날짜/요일)
            if (opt?.closedDay) {
                const cd = primary?.closedDates ?? (fallback?.closedDates ?? null);
                const cw = primary?.closedWeekdays ?? (fallback?.closedWeekdays ?? null);

                // closedDates는 store에서 holidayWork 제거 후 데이터 -> 그대로 return
                if (cd && hasInSetOrArray(cd as any, ymd)) {
                    return {blocked: true as const, source: src, reason: 'closedDate' as const, range: null as TimeRange | null};
                }

                // holidayWork 날짜면 “요일휴무”은 무시해야 함
                if (!isWorkOverride && cw && hasInSetOrArray(cw as any, weekday)) {
                    return {blocked: true as const, source: src, reason: 'closedWeekday' as const, range: null as TimeRange | null};
                }
            }

            // 2) weekly(open) 기반 운영시간
            // ⚠️ pickDailySchedule 은 (hospitalRules, doctorRules) 고정 순서로 호출해야 한다.
            //   내부에서 priority(HOSPITAL_FIRST/DOCTOR_FIRST)로 소스를 고르는데,
            //   여기서 src 기반 (primary, fallback) 을 넘기면 DOCTOR_FIRST 일 때 인자가 뒤집혀
            //   (의사, 기관) → 내부 priority 재적용으로 이중 swap → 의사 운영시간이 설정돼 있어도
            //   기관 daily(점심 포함)를 반환하던 버그. hr/dr 직접 전달로 한 번만 priority 적용.
            const dailyPick = pickDailySchedule(hr, dr, weekday, isHolidayOpen, dateDaily);
            const daily = dailyPick.daily as (DailySchedule | null);

            // 3) daily 처리: undefined(정보없음) vs null(명시적 휴무) 분리
            // - undefined: 이 소스에 요일 정보가 없음 → 다음 소스로 넘어감(continue)
            // - null:      이 소스가 "명시적으로 휴무"를 선언 → fallback 금지, 여기서 바로 막음
            if (daily === null) {
                // 담당자가 선언한 휴무는 공휴일 진료일이 덮지 않는다(overrideBeatsDoctor 참조).
                if (isWorkOverride && (overrideBeatsDoctor || dailyPick.sourceUsed !== 'doctor')) {
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
                // 공휴일 운영시간이 미설정이거나 휴게 행만 있어도 마찬가지다 — 진료 의도가 이긴다.
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
        const isWorkOverride = isHolidayWorkDate(date) || isHolidayOpen;
        // pickReason 과 같은 규약 — 공휴일 진료일은 담당자가 선언한 휴무까지 덮지는 않는다.
        const overrideBeatsDoctor = isHolidayWorkDate(date);

        /* ★공휴일 진료일은 기관 공휴일 운영시간이 미설정이어도 휴무 배지를 띄우지 않는다 — 종일진료다.
         * pickReason 과 **반드시 같은 규칙**이어야 한다. 갈리면 "예약은 막히는데 배지는 안 뜬다"
         * (또는 그 반대)가 되어 사용자가 이유를 모른 채 아무 칸도 누르지 못하는 화면이 된다. */

        const d = dayjs(date);
        const ymd = d.format(DATE_FORMAT);
        const weekday = d.day() as Weekday;

        // pickReason 과 같은 값을 써야 배지와 차단이 갈리지 않는다.
        const dateDaily = hr?.dailyByDate?.[ymd];

        const order = buildSourceOrder();

        for (const src of order) {
            const {primary, fallback} = getPrimaryFallbackForSource(src, hr, dr);

            // 1) closedDates / closedWeekdays
            if (unref(blockOptions)?.closedDay) {
                const cd = primary?.closedDates ?? (fallback?.closedDates ?? null);
                const cw = primary?.closedWeekdays ?? (fallback?.closedWeekdays ?? null);

                if (cd && hasInSetOrArray(cd as any, ymd)) return true;
                if (!isWorkOverride && cw && hasInSetOrArray(cw as any, weekday)) return true;
            }

            // 2) weekly daily 정보 기반 "하루 휴무" 판단
            // ⚠️ pickReason 과 동일 — (hr, dr) 고정 호출. (primary, fallback) 을 넘기면 DOCTOR_FIRST 일 때
            //   인자 swap 으로 의사 휴무 판정이 기관 daily 로 어긋남.
            const dailyPick = pickDailySchedule(hr, dr, weekday, isHolidayOpen, dateDaily);
            const daily = dailyPick.daily as (DailySchedule | null);

            /* null = 그 소스가 선언한 **명시적 휴무** → 하루휴무 배지. undefined = 정보 없음 → 다음 소스.
             * 둘을 묶어 continue 하면, 담당자가 휴무로 정한 요일에 예약은 막히는데(pickReason)
             * 배지는 안 떠 화면이 서로 어긋난다. */
            if (daily === null) {
                if (isWorkOverride && (overrideBeatsDoctor || dailyPick.sourceUsed !== 'doctor')) continue;
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

    /** 공휴일이면서 진료하는 날(= 공휴일 − 최종 휴무일). 이 날은 요일 휴무/요일 운영시간을 무시하고
     *  사업장 공휴일 운영시간만 본다 — 공휴일이면 holidayClosedYn 만 보는 규칙(BE isClosedToday 와 동일). */
    function isHolidayOpenDate(date: Date | string | number) {
        const hr = unref(hospitalRules);
        if (!hr) return false;
        const ymd = dayjs(date).format('YYYY-MM-DD');
        return hasInSetOrArray(hr.holidayOpenDates as any, ymd);
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

    return {
        // core
        resolveGroupIdForRule,
        isBlockedSlot,
        isBlockedRange,

        // header helper
        isHospitalClosedDayForHeader,
        isClosedDayForHeader,

        // reason / explain
        getBlockedReason,
        explainBlockedReason,

        // cache
        clearRuleCache,
    };
}
