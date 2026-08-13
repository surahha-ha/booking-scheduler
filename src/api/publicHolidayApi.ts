/**
 * 공휴일(범용 national calendar) 조회 어댑터.
 *
 * ⚠️ 휴무일(getHoliday dayOff / 자체 offDates)과 **완전히 다른 데이터**다.
 *   - 휴무일 = 거래처가 설정한 휴무일(자체 getTreatmentSettings.offDates/recurringOffRules).
 *   - 공휴일 = 신정/설날/추석 등 범용 국가 공휴일(거래처 무관).
 *
 * 소스 = `getHolidays(year)` (BOOK `/book/v1/holidays`, 원천 사업장 설정 + Redis 캐시).
 * `includePublicHolidays` 설정이 true 일 때만 staffStore 가 이 값을 휴무에 합류시킨다.
 * (표시용 여부 조회는 holidayStore.isHoliday — 동일 엔드포인트 캐시. 공휴일명은 사업장 설정이 주지 않는다.)
 */

import dayjs from 'dayjs';
import {getHolidays} from '@/api/bookApi';

/**
 * 공휴일 날짜('YYYY-MM-DD') 목록 조회.
 * MONTHLY expand horizon(today ±1년, staffStore.loadHolidaySettings 의 윈도우)와 맞춰 3개 연도 로드.
 * 한 해 실패해도 나머지는 반영(부분 실패 허용).
 * ⚠️ 원천(사업장 설정) 커버리지는 원천 기동일 기준 ~ +2년이라 작년은 빈 목록이 정상이다 — 결손이 아니다.
 */
export async function fetchPublicHolidays(): Promise<string[]> {
    const y = dayjs().year();
    const years = [y - 1, y, y + 1];
    const results = await Promise.all(
        years.map(year =>
            getHolidays(year)
                .then(res => (res?.data ?? res)?.payload ?? [])
                .catch((e) => {
                    console.error('[BOOK > 공휴일 > 조회] 실패', year, e);
                    return [];
                }),
        ),
    );
    return results.flat().map(h => h?.date).filter((d): d is string => !!d);
}
