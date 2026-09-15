import dayjs from 'dayjs';
import {toDateType, toPeriodRange, toType} from '@/utils/schedulerSearchFilterUtils';
import type {SchedulerFilterState} from '@/stores/useSchedulerFilterStore';

// Scheduler filter -> API params mappers

/**
 * 약속장부 API Params
 * @param filter
 */
export function toBookApiParams(filter: SchedulerFilterState) {
    const type = toType(filter.dataType);
    const dateType = toDateType(filter.viewMode);
    // V3 조회 윈도우(가산) 우선 — [anchor, +days) 범위. 미설정 시 기존 viewMode/periodDate 경로(V2).
    // BE 조회는 startDate~endDate BETWEEN 만 사용(dateType 무관)이라 윈도우 범위로 안전 동작.
    const {startDate, endDate} = (filter.windowAnchorDate != null && filter.windowDays > 0)
        ? {
            startDate: dayjs(filter.windowAnchorDate).startOf('day').toDate(),
            endDate: dayjs(filter.windowAnchorDate).startOf('day').add(filter.windowDays - 1, 'day').toDate(),
        }
        : toPeriodRange(filter.periodDate, filter.viewMode);
    // const isMember = toIsMember(filter.memberType); // NOTE 통합회원 여부를 검색 필터로 사용할 경우 활성화
    const doctorName = filter.doctors ?? [];
    // ! externalStaffNo 변경
    // const externalStaffNo = filter.doctors ?? [];
    // 상태 필터는 보내지 않는다 — 목록은 모든 상태를 받고 화면(엔진 입력)에서 거른다. 상태 칩 숫자를
    // 화면 카드에서 세려면 숨긴 상태의 예약도 손에 있어야 한다(SchedulerV3Page.boardStatistics).

    return {
        type,
        dateType,
        startDate: dayjs(startDate).format('YYYYMMDD'),
        endDate: dayjs(endDate).format('YYYYMMDD'),
        // isMember,
        doctorName,
        // ! externalStaffNo 변경
        // externalStaffNo,
        keyword: filter.keyword ?? '',
    };
}

/**
 * 외부 연동 API Params
 * @param filter
 */
export function toMcsApiParams(_filter: any) {
    return {}
}

/**
 * 통합회원 API Params
 * @param filter
 */
export function toStaffApiParams(_filter: any) {
    return {}
}

/**
 * 고객 API Params
 * @param filter
 */
export function toCustomerApiParams(_filter: any) {
    return {}
}
