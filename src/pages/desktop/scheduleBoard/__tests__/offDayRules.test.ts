/**
 * 담당자 축 휴무 판정(계획서 §4-2) 단위테스트.
 *
 * 이 규칙의 핵심은 **"휴무로 정함"과 "아직 정하지 않음"이 다른 상태**라는 것이다.
 * 둘 다 운영 구간이 없지만, 미설정은 사업장 값을 따라야 하고 휴무는 그 자체가 답이다.
 * 여기서 미설정을 휴무로 접으면 사업장이 운영하는 날에도 담당자가 통째로 쉬는 것으로 표시된다.
 *
 * 구체적인 지정이 일반 규칙을 이긴다 — 날짜 지정 > 공휴일 휴무 > 매월 N번째 > 요일.
 * ★공휴일 운영('Y')는 "공휴일이라는 이유로는 쉬지 않는다"는 뜻일 뿐이라 아래 판정을 덮지 않는다.
 */

import dayjs from 'dayjs';
import {describe, expect, it} from 'vitest';

import {
    inheritedInstitutionOffOn,
    isEveryWeekOff,
    isInstitutionRecurringOff,
    isStaffOffOn,
    matchesMonthlyOffRule,
    monthlyOccurrenceOf,
    resolveStaffDayState,
} from '../offDayRules';

// 2026-08-12(수) = 그 달 2번째 수요일 / 2026-08-26(수) = 4번째 수요일
const WED_2ND = dayjs('2026-08-12');
const WED_4TH = dayjs('2026-08-26');
const WORK = {kind: 'WORK', start: '09:00', end: '18:00'};

describe('monthlyOccurrenceOf', () => {
    it('1~7일은 1번째, 8~14일은 2번째로 센다', () => {
        expect(monthlyOccurrenceOf(dayjs('2026-08-01'))).toBe(1);
        expect(monthlyOccurrenceOf(dayjs('2026-08-07'))).toBe(1);
        expect(monthlyOccurrenceOf(dayjs('2026-08-08'))).toBe(2);
        expect(monthlyOccurrenceOf(WED_2ND)).toBe(2);
    });

    it('29~31일은 5번째다', () => {
        expect(monthlyOccurrenceOf(dayjs('2026-08-29'))).toBe(5);
        expect(monthlyOccurrenceOf(dayjs('2026-08-31'))).toBe(5);
    });
});

describe('matchesMonthlyOffRule', () => {
    it('요일과 차수가 모두 맞아야 해당한다', () => {
        const rules = [{dayCd: 3, monthlyNth: 2}];

        expect(matchesMonthlyOffRule(WED_2ND, rules)).toBe(true);
        expect(matchesMonthlyOffRule(WED_4TH, rules)).toBe(false);          // 차수가 다르다
        expect(matchesMonthlyOffRule(dayjs('2026-08-11'), rules)).toBe(false); // 2번째지만 화요일
    });

    it('같은 요일에 여러 차수를 정할 수 있다', () => {
        const rules = [{dayCd: 3, monthlyNth: 2}, {dayCd: 3, monthlyNth: 4}];

        expect(matchesMonthlyOffRule(WED_2ND, rules)).toBe(true);
        expect(matchesMonthlyOffRule(WED_4TH, rules)).toBe(true);
    });

    it('규칙이 없으면 해당하지 않는다', () => {
        expect(matchesMonthlyOffRule(WED_2ND, [])).toBe(false);
        expect(matchesMonthlyOffRule(WED_2ND, undefined)).toBe(false);
    });
});

describe('resolveStaffDayState — 우선순위', () => {
    it('★아무것도 정하지 않으면 휴무가 아니라 미설정이다', () => {
        expect(resolveStaffDayState(WED_2ND, {})).toBe('INHERIT');
    });

    it('날짜 지정이 있으면 그것이 답이다 — 빈 목록은 그 날짜 휴무', () => {
        expect(resolveStaffDayState(WED_2ND, {dateBlocks: []})).toBe('OFF');
        expect(resolveStaffDayState(WED_2ND, {dateBlocks: [WORK]})).toBe('WORK');
    });

    it('★날짜 지정은 매주 휴무·매월 규칙을 모두 덮는다', () => {
        const context = {
            dateBlocks      : [WORK],
            weekdayBlocks   : [],                          // 매주 수요일 휴무
            monthlyOffRules : [{dayCd: 3, monthlyNth: 2}],  // 2번째 수요일도 휴무
        };

        expect(resolveStaffDayState(WED_2ND, context)).toBe('WORK');
    });

    it('요일 설정은 빈 목록이면 매주 휴무, 구간이 있으면 운영다', () => {
        expect(resolveStaffDayState(WED_2ND, {weekdayBlocks: []})).toBe('OFF');
        expect(resolveStaffDayState(WED_2ND, {weekdayBlocks: [WORK]})).toBe('WORK');
    });

    it('★매월 N번째 규칙은 그 요일 운영 설정보다 구체적이라 그 날짜만 이긴다', () => {
        const context = {
            weekdayBlocks   : [WORK],                      // 수요일은 운영
            monthlyOffRules : [{dayCd: 3, monthlyNth: 2}],  // 단, 2번째 수요일은 휴무
        };

        expect(resolveStaffDayState(WED_2ND, context)).toBe('OFF');
        expect(resolveStaffDayState(WED_4TH, context)).toBe('WORK');
    });
});

describe('resolveStaffDayState — 공휴일', () => {
    it('공휴일 휴무(N)이면 그날은 휴무가다', () => {
        expect(resolveStaffDayState(WED_2ND, {isHoliday: true, holidayOpenYn: 'N'})).toBe('OFF');
    });

    it("★공휴일 운영(Y)는 운영을 확정하지 않는다 — '공휴일이라는 이유로는 쉬지 않는다'는 뜻이다", () => {
        // 요일도 매월도 정한 것이 없으면 미설정으로 내려간다.
        expect(resolveStaffDayState(WED_2ND, {isHoliday: true, holidayOpenYn: 'Y'})).toBe('INHERIT');
        // 그 요일을 운영으로 정해 뒀으면 운영다.
        expect(resolveStaffDayState(WED_2ND, {isHoliday: true, holidayOpenYn: 'Y', weekdayBlocks: [WORK]})).toBe('WORK');
    });

    it('★공휴일 운영 여부가 null 이면 미설정이다 — 휴무로 단정하지 않는다', () => {
        expect(resolveStaffDayState(WED_2ND, {isHoliday: true, holidayOpenYn: null})).toBe('INHERIT');
    });

    it('★공휴일에도 요일 규칙은 산다 — 매주 쉬는 요일이 공휴일이라고 나오지 않는다', () => {
        // 매주 수요일 휴무
        expect(resolveStaffDayState(WED_2ND, {
            isHoliday: true, holidayOpenYn: 'Y', weekdayBlocks: [],
        })).toBe('OFF');

        // 매월 2번째 수요일 휴무
        expect(resolveStaffDayState(WED_2ND, {
            isHoliday: true, holidayOpenYn: 'Y', monthlyOffRules: [{dayCd: 3, monthlyNth: 2}],
        })).toBe('OFF');
    });

    it('공휴일이라도 날짜 지정이 있으면 지정이 이긴다', () => {
        expect(resolveStaffDayState(WED_2ND, {isHoliday: true, holidayOpenYn: 'Y', dateBlocks: []})).toBe('OFF');
    });
});

describe('isStaffOffOn — 사업장 상속', () => {
    it('★미설정이면 사업장 판정을 그대로 따른다', () => {
        expect(isStaffOffOn(WED_2ND, {}, true)).toBe(true);
        expect(isStaffOffOn(WED_2ND, {}, false)).toBe(false);
    });

    it('담당자가 정했으면 사업장 판정과 무관하게 그 값이 이긴다', () => {
        expect(isStaffOffOn(WED_2ND, {weekdayBlocks: []}, false)).toBe(true);   // 기관은 운영, 담당자만 휴무
        expect(isStaffOffOn(WED_2ND, {weekdayBlocks: [WORK]}, true)).toBe(false); // 기관은 휴무, 담당자만 운영
    });
});

/* 설정 화면과 뷰어가 각자 갖고 있던 골격을 여기로 올렸다(2026-08-31).
 * 두 화면이 같은 판정 순서를 쓰는지 이 파일이 고정한다 — 갈리면 같은 날 같은 담당자가
 * 보기와 설정에서 다르게 보인다. */
describe('isInstitutionRecurringOff — 사업장 반복 휴무(요일 축)', () => {
    it('매주 휴무 요일이면 그 요일의 모든 날이 휴무', () => {
        const offs = new Map([[3, new Set(['WEEKLY'])]]);
        expect(isInstitutionRecurringOff(WED_2ND, offs)).toBe(true);
        expect(isInstitutionRecurringOff(WED_4TH, offs)).toBe(true);
    });

    it('매월 N번째는 그 회차에만 걸린다', () => {
        const offs = new Map([[3, new Set(['MONTHLY_2'])]]);
        expect(isInstitutionRecurringOff(WED_2ND, offs)).toBe(true);
        expect(isInstitutionRecurringOff(WED_4TH, offs)).toBe(false);
    });

    it('규칙이 없거나 비어 있으면 휴무가 아니다', () => {
        expect(isInstitutionRecurringOff(WED_2ND, undefined)).toBe(false);
        expect(isInstitutionRecurringOff(WED_2ND, new Map([[3, new Set<string>()]]))).toBe(false);
    });
});

describe('inheritedInstitutionOffOn — 상속은 축 단위', () => {
    const base = {
        hasOwnDateOverrides: false,
        isHoliday: false,
        holidayOff: false,
        hasOwnRecurringOff: false,
        institutionRecurringOff: false,
    };

    it('정한 것이 없으면 기관 일자 지정을 따른다', () => {
        expect(inheritedInstitutionOffOn({...base, institutionDateOverride: 'OFF'})).toBe(true);
        expect(inheritedInstitutionOffOn({...base, institutionDateOverride: 'WORK'})).toBe(false);
    });

    it('★일자 축을 스스로 정했으면 기관 일자 지정을 더는 따라가지 않는다', () => {
        expect(inheritedInstitutionOffOn({
            ...base, hasOwnDateOverrides: true, institutionDateOverride: 'OFF',
        })).toBe(false);
    });

    it('★요일 축을 스스로 정했으면 기관 반복 휴무를 더는 따라가지 않는다', () => {
        expect(inheritedInstitutionOffOn({...base, institutionRecurringOff: true})).toBe(true);
        expect(inheritedInstitutionOffOn({
            ...base, hasOwnRecurringOff: true, institutionRecurringOff: true,
        })).toBe(false);
    });

    it('★축은 따로 끊긴다 — 일자 축을 정해도 요일 축 상속은 살아 있다', () => {
        expect(inheritedInstitutionOffOn({
            ...base, hasOwnDateOverrides: true, institutionRecurringOff: true,
        })).toBe(true);
    });

    it('★공휴일에는 기관 요일 휴무를 보지 않고 공휴일 축이 답을 낸다', () => {
        expect(inheritedInstitutionOffOn({
            ...base, isHoliday: true, holidayOff: false, institutionRecurringOff: true,
        })).toBe(false);
        expect(inheritedInstitutionOffOn({...base, isHoliday: true, holidayOff: true})).toBe(true);
    });

    it('공휴일이라도 상속받는 기관 일자 지정이 먼저다', () => {
        expect(inheritedInstitutionOffOn({
            ...base, isHoliday: true, holidayOff: true, institutionDateOverride: 'WORK',
        })).toBe(false);
    });
});

/* '매주'와 '매월 1~5번째 전부'는 같은 결과(그 요일에 쉬지 않는 주가 없다)라 화면이 같게 말해야 한다.
 * 설정 화면의 휴무 표기·요일 잠금·운영시간 필수 판정이 이 함수 하나를 본다. */
describe('isEveryWeekOff', () => {
    const monthly = (...ns: number[]) => new Set(ns.map(n => `MONTHLY_${n}`));

    it('매주를 골랐으면 매주다', () => {
        expect(isEveryWeekOff(new Set(['WEEKLY']))).toBe(true);
    });

    it('매월 1~5번째를 전부 골랐으면 매주와 같다', () => {
        expect(isEveryWeekOff(monthly(1, 2, 3, 4, 5))).toBe(true);
    });

    it('하나라도 빠지면 매주가 아니다 — 그 주에는 운영한다', () => {
        expect(isEveryWeekOff(monthly(1, 2, 3, 4))).toBe(false);
        expect(isEveryWeekOff(monthly(3))).toBe(false);
    });

    it('정한 것이 없으면 매주가 아니다', () => {
        expect(isEveryWeekOff(new Set())).toBe(false);
        expect(isEveryWeekOff(undefined)).toBe(false);
    });
});
