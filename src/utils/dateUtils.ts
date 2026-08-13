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
