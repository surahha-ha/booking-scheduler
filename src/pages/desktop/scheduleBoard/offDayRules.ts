import type {Dayjs} from 'dayjs';
import type {StaffMonthlyOffRule, StaffHolidayOpenYn} from '@/api/siteApi';
import {RECURRING_OPTIONS} from './offDayOptions';

/**
 * 담당자 축 휴무 판정 — 계획서 §4-2 의 우선순위를 순수함수로 옮긴 것.
 *
 * 화면(`SchedulerSettingsTreatmentSetting.vue`)이 이미 4,800줄이 넘어 여기에 판정까지 넣으면
 * 규칙을 테스트로 고정할 수 없다. 그래서 "무엇이 휴무인가"만 이 파일에 두고,
 * 상태 보관·렌더링은 화면이 갖는다.
 *
 * 판정 순서(구체적인 지정이 일반 규칙을 이긴다):
 *   1. 그 날짜 지정   → 있으면 그것이 답 (빈 blocks = 휴무 / blocks 있음 = 진료)
 *   2. 공휴일 휴무    → 담당자 공휴일 진료여부가 'N' 이면 휴무
 *   3. 요일 규칙      → 매월 N번째 규칙 해당 = 휴무, 그다음 그 요일 설정(빈 blocks = 매주 휴무)
 *   4. 아무것도 없음  → 미설정. 사업장 판정을 상속
 *
 * ★공휴일 진료('Y')는 "공휴일이라는 이유로는 쉬지 않는다"는 뜻일 뿐, 아래 요일 판정을 덮지 않는다.
 * 매주 금요일 쉬는 담당자가 금요일 공휴일에 나온다는 결론은 성립하지 않는다. 그래서 2단계는
 * 휴무만 확정하고 진료는 확정하지 않는다.
 *
 * ★상속({@link isStaffOffOn} 의 inheritedOff)에 **사업장의 공휴일 판정은 넣지 않는다.**
 * 공휴일은 담당자가 자기 값(holidayOpenYn)으로 따로 관리하므로 기관에서 내려받을 것이 없다 —
 * 넣으면 "공휴일에도 진료"로 정해 둔 담당자가 기관 공휴일 휴무를 상속해 휴무가 된다.
 */
export type StaffDayState = 'OFF' | 'WORK' | 'INHERIT';

/** 진료 구간 1건. 판정은 "구간이 있는가"만 보므로 시각 형식은 상관하지 않는다. */
export type TimeBlockLike = {kind?: string; start?: string | null; end?: string | null};

export type StaffOffContext = {
    /** 그 날짜 지정. `undefined` = 지정 없음 / `[]` = 그 날짜 휴무 / 구간 있음 = 그 날짜 진료 */
    dateBlocks?: TimeBlockLike[];
    /** 그 요일 설정. `undefined` = 미설정 / `[]` = 매주 휴무 / 구간 있음 = 진료 */
    weekdayBlocks?: TimeBlockLike[];
    /** 매월 N번째 O요일 휴무 규칙 목록. 목록에 있는 조합이 곧 휴무가다. */
    monthlyOffRules?: StaffMonthlyOffRule[];
    /** 공휴일 진료여부. 값이 없는 것은 조회 전 과도 상태뿐이며, 그때는 사업장 판정을 상속한다. */
    holidayOpenYn?: StaffHolidayOpenYn;
    /** 그 날짜가 국가 공휴일인가 (공휴일 스위치가 아니라 날짜 자체의 성질) */
    isHoliday?: boolean;
};

/**
 * 그 달의 몇 번째 같은 요일인가 (1~5).
 * 날짜를 7로 나눠 올림한다 — 1~7일이 1번째, 8~14일이 2번째다. 요일과 무관하게 성립한다.
 */
export function monthlyOccurrenceOf(date: Dayjs): number {
    return Math.ceil(date.date() / 7);
}

/** 그 날짜가 "매월 N번째 O요일" 규칙 중 하나에 해당하는가. */
export function matchesMonthlyOffRule(date: Dayjs, rules?: StaffMonthlyOffRule[]): boolean {
    if (!rules || rules.length === 0) return false;

    const weekday = date.day();
    const occurrence = monthlyOccurrenceOf(date);
    return rules.some(rule => rule.dayCd === weekday && rule.monthlyNth === occurrence);
}

/**
 * 사업장의 **반복 휴무**(요일 축)이 그 날짜에 걸리는가 — 매주 휴무가거나, 매월 N번째 그 요일이거나.
 *
 * 화면이 보관하는 형태를 그대로 받는다: `Map<weekday, Set<'WEEKLY' | 'MONTHLY_1'…'MONTHLY_5'>>`.
 * 설정 화면과 뷰어가 같은 7줄을 각자 갖고 있던 것을 여기로 올렸다 — 매월 전개식(`monthlyOccurrenceOf`)이
 * 세 벌이 되면 한 곳만 고쳐도 드러나지 않는다.
 */
export function isInstitutionRecurringOff(
    date: Dayjs,
    weekdayOffs: Map<number, Set<string>> | undefined,
): boolean {
    const options = weekdayOffs?.get(date.day());
    if (!options || options.size === 0) return false;
    if (options.has('WEEKLY')) return true;
    return options.has(`MONTHLY_${monthlyOccurrenceOf(date)}`);
}

/** 매월 N번째 옵션 키 전부 — 같은 요일은 한 달에 최대 다섯 번이라 이 다섯이면 빠지는 주가 없다. */
const MONTHLY_OPTION_KEYS = RECURRING_OPTIONS.map(o => o.value).filter(v => v !== 'WEEKLY');

/**
 * 그 요일의 반복 휴무 옵션이 **매주 쉬는 것과 같은가** — '매주'를 골랐거나, 매월 1~5번째를 전부 골랐거나.
 *
 * 두 표현은 같은 결과를 내므로 화면도 같게 말해야 한다: 운영시간 탭의 '휴무' 표기·요일 잠금·
 * 운영시간 필수 판정이 모두 이 함수를 본다. 저장 표현은 바꾸지 않는다 — 사용자가 고른 다섯 개는
 * 다섯 행 그대로 나간다(자체 가 정규화하면 사업장 설정 쪽 표시가 바뀐다).
 */
export function isEveryWeekOff(options: Set<string> | undefined): boolean {
    if (!options || options.size === 0) return false;
    if (options.has('WEEKLY')) return true;
    return MONTHLY_OPTION_KEYS.every(key => options.has(key));
}

/**
 * 정한 것이 없는 담당자가 사업장에서 **상속하는 휴무** — 상속은 항목이 아니라 **축 단위**다(계획서 §4-2).
 *
 * 축은 따로 끊긴다. 그 축에서 스스로 하나라도 정했으면 그 축은 더는 사업장을 따라가지 않는다.
 *   - 일자 축: `hasOwnDateOverrides` 면 기관 일자 지정을 보지 않는다
 *   - 요일 축: `hasOwnRecurringOff` 면 기관 반복 휴무를 보지 않는다
 *   - 공휴일 축: 상속 대상이 아니다 — 담당자가 자기 값(`HOLIDAY_OPEN_YN`, NOT NULL 2상태)으로 갖는다.
 *     그래서 `holidayOff` 는 호출자가 **자기 축으로 계산해** 넘긴다.
 *
 * ★공휴일에는 기관 **요일** 휴무도 보지 않는다 — 기관 축도 공휴일이면 반복 휴무를 보지 않고 공휴일
 *  스위치로만 가르기 때문이다. 그래서 공휴일 분기에서 곧바로 답이 나가고 아래로 내려가지 않는다.
 *
 * 자료구조 접근은 호출자(설정 화면·뷰어)가 하고 **판정 순서만 여기서 소유한다** — 두 화면이 같은 골격을
 * 각자 갖고 있다가 갈리면, 같은 날 같은 담당자가 보기와 설정에서 다르게 보인다.
 */
export type InstitutionInheritContext = {
    /** 이 담당자가 일자 축을 스스로 하나라도 정했는가 */
    hasOwnDateOverrides: boolean;
    /** 사업장의 그 날짜 지정 — 없으면 `undefined` */
    institutionDateOverride?: 'OFF' | 'WORK';
    /** 그 날짜가 국가 공휴일인가 */
    isHoliday: boolean;
    /** 공휴일일 때의 판정 — 담당자 공휴일 축(`holidayOpenYn`)으로 호출자가 계산해 넘긴다 */
    holidayOff: boolean;
    /** 이 담당자가 요일 축을 스스로 하나라도 정했는가 */
    hasOwnRecurringOff: boolean;
    /** 사업장의 반복 휴무가 그 날짜에 걸리는가 ({@link isInstitutionRecurringOff}) */
    institutionRecurringOff: boolean;
};

export function inheritedInstitutionOffOn(ctx: InstitutionInheritContext): boolean {
    if (!ctx.hasOwnDateOverrides) {
        if (ctx.institutionDateOverride === 'OFF') return true;
        if (ctx.institutionDateOverride === 'WORK') return false;
    }
    if (ctx.isHoliday) return ctx.holidayOff;
    if (ctx.hasOwnRecurringOff) return false;
    return ctx.institutionRecurringOff;
}

/**
 * 담당자가 그 날짜를 어떻게 정했는가 — 휴무(OFF) / 진료(WORK) / 정하지 않음(INHERIT).
 *
 * `INHERIT` 를 `OFF` 로 접지 않는 이유는 "정하지 않음"과 "휴무로 정함"이 다른 상태이기 때문이다.
 * 미설정이면 사업장 값을 따라야 하고, 저장할 때도 행을 만들지 않는다.
 */
export function resolveStaffDayState(date: Dayjs, context: StaffOffContext): StaffDayState {
    // 1. 그 날짜를 직접 지정했으면 그것이 답이다.
    if (context.dateBlocks !== undefined) {
        return context.dateBlocks.length === 0 ? 'OFF' : 'WORK';
    }

    // 2. 공휴일 휴무만 여기서 확정한다. 'Y'(공휴일에도 진료)는 요일 판정을 덮지 않고 아래로 내려간다.
    if (context.isHoliday && context.holidayOpenYn === 'N') return 'OFF';

    // 3. 매월 N번째 규칙이 그 요일 설정보다 구체적이다 — 매주 진료여도 그 날짜만 쉰다.
    if (matchesMonthlyOffRule(date, context.monthlyOffRules)) return 'OFF';

    if (context.weekdayBlocks !== undefined) {
        return context.weekdayBlocks.length === 0 ? 'OFF' : 'WORK';
    }

    // 4. 아무것도 정하지 않았다.
    return 'INHERIT';
}

/**
 * 그 날짜에 이 담당자가 쉬는가 — 정하지 않은 것만 사업장 판정({@code inheritedOff})을 상속한다.
 *
 * ★{@code inheritedOff} 는 **공휴일 축을 뺀** 사업장 판정이다(일자 지정 > 반복 휴무).
 * 화면이 그렇게 계산해 넘긴다 — 공휴일은 담당자가 자기 값으로 따로 관리하므로 상속 대상이 아니다.
 */
export function isStaffOffOn(date: Dayjs, context: StaffOffContext, inheritedOff: boolean): boolean {
    const state = resolveStaffDayState(date, context);
    if (state === 'OFF') return true;
    if (state === 'WORK') return false;
    return inheritedOff;
}
