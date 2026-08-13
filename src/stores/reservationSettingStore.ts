// ============================================================================
// 예약장부 설정 store (전체 칸 갯수 / 시간단위 / 표시정보)
// ----------------------------------------------------------------------------
// getReservationSettings(reservationSettingsApi) 응답을 캐시. V3 스케줄러가 "전체 칸 갯수"를
// 설정값 기준으로 소비(방문 장부는 라이브 zoom 무시·설정 전체칸 따름).
//  - 가산(additive) store: V2 SchedulerPage(zoomState 별도)는 미소비 → 무영향.
//  - 현재 totalColumns 만 layout 에 주입. timeUnit/displayInfo 반영은 후속 단계.
// ============================================================================
import {defineStore} from 'pinia';
import {ref} from 'vue';
import {
    getReservationSettings,
    type DisplayInfoCode,
    type ReservationSettingsPayload,
    type RowHeightLevel,
    type TimeUnitMinute,
} from '@/api/reservationSettingsApi';

// 예약장부 설정 "전체 칸 개수" 허용 범위 (SchedulerSettingsReservationSetting 과 동일)
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 20;
const DEFAULT_TOTAL_COLUMNS = 8;
// 카드 높이 단계 기본값 — 서버 기본값 3 과 일치. BE 조회 실패(에러) 시에만 fallback.
const DEFAULT_ROW_HEIGHT_LEVEL: RowHeightLevel = 3;

function clampColumns(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_TOTAL_COLUMNS;
    return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.trunc(n)));
}

// 카드 높이 단계를 1~5 로 방어 clamp (임의값 유입 대비)
function clampRowHeightLevel(n: unknown): RowHeightLevel {
    if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_ROW_HEIGHT_LEVEL;
    return Math.max(1, Math.min(5, Math.trunc(n))) as RowHeightLevel;
}

export const useReservationSettingStore = defineStore('reservationSettingStore', () => {
    const timeUnit = ref<TimeUnitMinute>(30);
    const totalColumns = ref<number>(DEFAULT_TOTAL_COLUMNS);
    const displayInfo = ref<DisplayInfoCode[]>(['NAME']);
    // 카드 높이 단계(1~5). 서버 구현 — 응답값 우선, 미응답(에러) 시 fallback(3).
    const rowHeightLevel = ref<RowHeightLevel>(DEFAULT_ROW_HEIGHT_LEVEL);
    const loaded = ref(false);
    const loading = ref(false);

    async function load(force = false) {
        if (loaded.value && !force) return;
        if (loading.value) return;
        loading.value = true;
        try {
            const res = await getReservationSettings();
            const payload = res?.data?.payload as ReservationSettingsPayload | undefined;
            if (payload) {
                if (typeof payload.slotUnitMinutes === 'number') timeUnit.value = payload.slotUnitMinutes;
                if (typeof payload.totalColumnCount === 'number') totalColumns.value = clampColumns(payload.totalColumnCount);
                // displayInfo = 표시 항목 + 표시 순서(NAME 선두 고정). 응답 순서를 그대로 보관.
                if (Array.isArray(payload.displayInfo) && payload.displayInfo.length) displayInfo.value = payload.displayInfo;
                // 서버 응답 cardHeightLevel 반영. 미응답(구버전/에러) 시 기본값 유지.
                if (payload.cardHeightLevel != null) rowHeightLevel.value = clampRowHeightLevel(payload.cardHeightLevel);
            }
            loaded.value = true;
        } catch (e) {
            // 조회 실패 시 기본값(8) 유지 — 화면 차단하지 않음. 다음 진입에서 재시도(loaded=false).
            console.warn('[reservationSettingStore] 예약장부 설정 조회 실패 — 기본값 사용', e);
        } finally {
            loading.value = false;
        }
    }

    function invalidate() {
        loaded.value = false;
    }

    // 서버가 카드높이를 저장·응답함. 저장 시 optimistic 즉시 반영 →
    // load(true) 리로드에서 BE 응답값으로 hydrate(정합). 응답 없으면(에러) 가드로 보존.
    // BE 컬럼 추가 시 응답으로 일원화되며 이 setter 는 무해(동일 값).
    function setLocalRowHeightLevel(level: unknown) {
        rowHeightLevel.value = clampRowHeightLevel(level);
    }

    return {
        // state
        timeUnit,
        totalColumns,
        displayInfo,
        rowHeightLevel,
        loaded,
        loading,
        // actions
        load,
        invalidate,
        setLocalRowHeightLevel,
    };
});
