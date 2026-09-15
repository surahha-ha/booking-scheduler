/**
 * 휴무일 탭 컨트롤이 공유하는 표기 상수.
 *
 * 요일 라벨과 반복 옵션은 사업장 패널(부모 화면)과 담당자 패널(`SchedulerSettingsOffDayControls.vue`)이
 * 똑같이 쓴다. 파일마다 따로 적으면 "매월 5번째" 를 한쪽에만 추가하는 식으로 갈라진다.
 */

/** 0=일 ~ 6=토. 인덱스가 곧 dayCd 라 순서를 바꾸면 저장값이 어긋난다. */
export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

/** 반복 휴무 옵션 — 매주 하나 + 매월 N번째 다섯. 매주와 매월은 배타다(토글 함수가 강제). */
export const RECURRING_OPTIONS = [
    {value: 'WEEKLY', label: '매주'},
    {value: 'MONTHLY_1', label: '매월 1번째'},
    {value: 'MONTHLY_2', label: '매월 2번째'},
    {value: 'MONTHLY_3', label: '매월 3번째'},
    {value: 'MONTHLY_4', label: '매월 4번째'},
    {value: 'MONTHLY_5', label: '매월 5번째'},
];

/** 매월 N번째 옵션 키 → N. 매주면 null. */
export function monthlyOptionValue(option: string): number | null {
    return option === 'WEEKLY' ? null : Number(option.split('_')[1]);
}

/** 반복 휴무 칩 라벨 — "매주 수요일" / "매월 3번째 수요일" */
export function recurringChipLabel(weekday: number, option: string): string {
    const n = monthlyOptionValue(option);
    return n === null
        ? `매주 ${WEEKDAY_LABELS[weekday]}요일`
        : `매월 ${n}번째 ${WEEKDAY_LABELS[weekday]}요일`;
}
