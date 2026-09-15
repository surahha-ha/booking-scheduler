import dayjs from 'dayjs';

// 현재 시각 기준 과거 여부 판단
export function hasPassedNow(
    dateTime?: string | Date | dayjs.Dayjs
) {
    if (!dateTime) return false;
    const d = dayjs(dateTime);
    if (!d.isValid()) return false;

    return d.isBefore(dayjs());
}

// 슬롯 종료시각 기준 과거 여부 판단
export function isPastSlot(endDate?: string | Date | dayjs.Dayjs | null): boolean {
    return endDate ? hasPassedNow(endDate) : false;
}

/* 월 스트립의 연도 라벨 — 1월 앞에만 연도를 붙인다('YYYY-MM' → 'YYYY' | null).
 * 줄달력(SchedulerDateStrip)과 운영일정 보기의 월 스트립이 함께 쓴다. 맨 앞 월에도 붙이는 안은
 * "보고 있는 연도가 늘 왼쪽에 떠 있어 거슬린다" 로 반려됐다 — 규칙을 바꾸면 두 화면이 같이 바뀐다. */
export function yearLabelFor(yearMonth: string): string | null {
    const d = dayjs(`${yearMonth}-01`);
    return d.month() === 0 ? String(d.year()) : null;
}
