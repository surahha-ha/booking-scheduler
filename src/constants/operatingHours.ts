/**
 * 사업장 표준 운영시간 09:00~18:00 — **아무도 그 요일을 정하지 않은 칸**의 기본값.
 *
 * 이 값은 두 계층이 함께 쓴다. 갈리면 화면이 자기모순에 빠지므로 여기 한 곳에서만 정의한다.
 *   - 예약검증: `useSchedulerRules` 의 `DEFAULT_OPEN_DAILY` (HH:mm 문자열로 판정)
 *   - 타임라인 밴드: `layoutPipeline` 의 `DEFAULT_UNIT_HOURS` · 시간축 최소 창 (분 단위로 배치)
 *
 * ★두 값이 갈리면 **밴드는 열려 있는데 클릭하면 "운영시간 밖"이라고 막히는** 화면이 된다.
 *  실제로 손으로 맞춰 두다가 한쪽만 고쳐 어긋난 적이 있어, 문자열 하나에서 분을 파생시킨다 —
 *  숫자를 따로 적어 두면 다음 사람이 또 한쪽만 고친다.
 *
 * ★"정하지 않음"과 "휴무로 정함"은 다르다. 이 기본값은 **전자에만** 쓴다.
 *  휴무로 정한 요일은 빈 값이 그대로 답이라 여기로 내려오지 않는다.
 */

/** 'HH:mm' → 자정 기준 분. 이 파일 안에서만 쓰는 파생용 헬퍼다. */
function toMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

/** 기본 운영 시작 시각 (HH:mm) */
export const DEFAULT_OPERATING_START = '09:00';

/** 기본 운영 종료 시각 (HH:mm) */
export const DEFAULT_OPERATING_END = '18:00';

/** 기본 운영 시작 — 자정 기준 분 (540) */
export const DEFAULT_OPERATING_START_MIN = toMinutes(DEFAULT_OPERATING_START);

/** 기본 운영 종료 — 자정 기준 분 (1080) */
export const DEFAULT_OPERATING_END_MIN = toMinutes(DEFAULT_OPERATING_END);
