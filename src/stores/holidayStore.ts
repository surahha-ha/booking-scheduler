import {defineStore} from 'pinia';
import {computed, ref} from 'vue';
import {getHolidays, type HolidayItem} from '@/api/bookApi';

// 국가 공휴일 store — 연도 단위 캐시 + 날짜 포함 여부 조회.
// 기관별 휴무일(staffStore.hospitalRules.closedDates)과 별개. 전역·읽기전용 표시용.
// 원천은 사업장 설정(BE 경유) — 날짜만 내려오므로 공휴일명은 없다. 커버리지는 원천 기동일 기준 ~ +2년.
export const useHolidayStore = defineStore('holidayStore', () => {
    function unwrapBody<T>(res: any) {
        return ((res as any).data ?? res) as { payload: T };
    }

    /** year → 그 해 공휴일 목록 */
    const byYear = ref<Map<number, HolidayItem[]>>(new Map());
    /** 동일 연도 중복 호출 방지 (in-flight 공유) */
    const inflight = new Map<number, Promise<void>>();
    const pending = ref(false);

    /** 공휴일 날짜("YYYY-MM-DD") 집합. 로드된 모든 연도 병합 */
    const dateSet = computed(() => {
        const set = new Set<string>();
        for (const list of byYear.value.values()) {
            for (const h of list) set.add(h.date);
        }
        return set;
    });

    function isHoliday(date: string): boolean {
        return dateSet.value.has(date);
    }

    /**
     * 특정 연도 공휴일 로드. 이미 캐시됐거나 진행 중이면 재호출하지 않음.
     * 공휴일 원천 커버리지 밖 연도는 빈 배열이 정상 — 그대로 캐시해 반복 호출을 막는다.
     */
    async function loadYear(year: number): Promise<void> {
        if (byYear.value.has(year)) return;
        const existing = inflight.get(year);
        if (existing) return existing;

        const task = (async () => {
            pending.value = true;
            try {
                const res = await getHolidays(year);
                const body = unwrapBody<HolidayItem[]>(res);
                const next = new Map(byYear.value);
                next.set(year, body.payload ?? []);
                byYear.value = next;
            } catch (e) {
                console.error('[BOOK > 공휴일 > 조회] 실패', year, e);
            } finally {
                pending.value = false;
                inflight.delete(year);
            }
        })();

        inflight.set(year, task);
        return task;
    }

    /**
     * 여러 연도를 한 번에 보장 (주간 뷰가 연 경계를 가로지를 때).
     * 빠진 연도만 병렬 로드.
     */
    async function ensureYears(years: number[]): Promise<void> {
        await Promise.all([...new Set(years)].map(loadYear));
    }

    return {
        byYear,
        pending,
        dateSet,
        isHoliday,
        loadYear,
        ensureYears,
    };
});
