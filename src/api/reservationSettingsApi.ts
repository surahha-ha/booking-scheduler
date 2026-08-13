// ============================================================================
// 예약장부 설정 API
// ============================================================================
import {useApi} from '@/lib/http';
import {withCredentialsUtils} from '@/utils/withCredentialsUtils';

const baseUrl = '/api/booking/v2/reservation-settings';
const api = useApi();

export type ApiResponse<T> = {
    code: string;
    message?: string;
    status?: string;
    payload?: T;
};

/* 예약 카드에 표시할 항목 코드 — NAME 은 항상 포함(응답에서 항상 첫 번째 고정).
 * 배열 순서 = 카드 표시 순서. BE: DISP_ITEM_ORD(NAME 제외 콤마 저장) + 항목별 Y/N 동시 관리. */
export type DisplayInfoCode = 'NAME' | 'BIRTH' | 'AGE' | 'GENDER' | 'TREATMENT' | 'PHONE';

/* 허용값: 10 / 15 / 20 / 30 / 45 / 60 (분) */
export type TimeUnitMinute = 10 | 15 | 20 | 30 | 45 | 60;

/* 카드 높이 단계 1~5 (작을수록 낮음). 엔진 RowHeightLevel 과 동일 도메인. */
export type RowHeightLevel = 1 | 2 | 3 | 4 | 5;

export type ReservationSettingsPayload = {
    slotUnitMinutes: TimeUnitMinute; // 예약 시간단위(분)
    totalColumnCount: number;         // 전체 칸 개수 1 ~ 20
    /** 카드 표시 항목 — 배열 순서 = 표시 순서. NAME 은 응답에서 항상 [0] 고정. */
    displayInfo: DisplayInfoCode[];
    /**
     * 카드 높이 단계(1~5). 서버 기본값 3.
     * 조회: 응답값 사용(없으면 store fallback). 저장: payload 에 포함 → BE 영속. optional 은 구버전 응답 호환용.
     */
    cardHeightLevel?: RowHeightLevel;
};

/**
 * 예약장부 설정 조회
 */
export function getReservationSettings() {
    return api.get<ApiResponse<ReservationSettingsPayload>>(
        `${baseUrl}/settings`,
        withCredentialsUtils()
    );
}

/**
 * 예약장부 설정 저장
 */
export function saveReservationSettings(payload: ReservationSettingsPayload) {
    return api.post<ApiResponse<null>>(
        `${baseUrl}/settings/save`,
        payload,
        withCredentialsUtils()
    );
}
