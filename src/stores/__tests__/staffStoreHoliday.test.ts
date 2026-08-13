import { describe, expect, it, vi } from 'vitest'
import dayjs from 'dayjs'
import { buildHolidayClosure, dayCodeToWeekday } from '../staffStore'
import { fetchPublicHolidays } from '@/api/publicHolidayApi'

// fetchPublicHolidays 는 getHolidays(/book/v1/holidays) 실호출 → 테스트에선 mock 으로 샘플 공휴일 반환.
const SAMPLE_HOLIDAYS = [
  { date: '2026-01-01', name: '신정' },
  { date: '2026-03-01', name: '삼일절' },
  { date: '2026-06-06', name: '현충일' },
]
vi.mock('@/api/bookApi', () => ({
  getHolidays: vi.fn(async () => ({ data: { payload: SAMPLE_HOLIDAYS } })),
}))

/**
 * 휴무 합성 회귀 가드. SSOT = 설정화면 isDisplayedOff.
 * WEEKLY→closedWeekdays / MONTHLY→horizon expand→closedDates / offDates→closedDates /
 * workDates→holidayWorkDates+rescue / holidayClosedYn 게이팅.
 */
describe('dayCodeToWeekday — 외부 일정 조회 요일코드 → Weekday (휴무 union)', () => {
  it('SUN~SAT → 0~6 매핑', () => {
    expect(dayCodeToWeekday('SUN')).toBe(0)
    expect(dayCodeToWeekday('MON')).toBe(1)
    expect(dayCodeToWeekday('THU')).toBe(4)
    expect(dayCodeToWeekday('SAT')).toBe(6)
  })
  it('알 수 없는/빈 코드 → null (휴무 union 에서 제외)', () => {
    expect(dayCodeToWeekday('XXX')).toBeNull()
    expect(dayCodeToWeekday(undefined)).toBeNull()
    expect(dayCodeToWeekday('')).toBeNull()
  })
})

describe('buildHolidayClosure — 자체 휴무 설정 → 휴무 필드', () => {
  it('WEEKLY 반복 → closedWeekdays (expand 안 함)', () => {
    const r = buildHolidayClosure(
      { recurringOffRules: [{ dayCd: 0, repeatTy: 'WEEKLY', monthlyNth: null }] },
      [], '2026-01-01', '2026-12-31',
    )
    expect(r.closedWeekdays.has(0)).toBe(true)
    expect(r.closedDates.size).toBe(0)
  })

  it('MONTHLY(매월 2번째 X요일) → horizon 구체 날짜 expand (2번째만, 3번째 제외)', () => {
    const target = '2026-06-09'
    const wd = dayjs(target).day()
    const r = buildHolidayClosure(
      { recurringOffRules: [{ dayCd: wd, repeatTy: 'MONTHLY', monthlyNth: 2 }] },
      [], '2026-06-01', '2026-06-30',
    )
    expect(r.closedDates.has(target)).toBe(true)          // 2번째 (ceil(9/7)=2)
    expect(r.closedDates.has('2026-06-16')).toBe(false)   // 3번째 (ceil(16/7)=3)
    expect(r.closedWeekdays.size).toBe(0)
  })

  it('offDates → closedDates', () => {
    const r = buildHolidayClosure({ offDates: ['2026-06-15'] }, [], '2026-06-01', '2026-06-30')
    expect(r.closedDates.has('2026-06-15')).toBe(true)
  })

  it('workDates → holidayWorkDates + closedDates 에서 rescue', () => {
    const r = buildHolidayClosure(
      { offDates: ['2026-06-15'], workDates: ['2026-06-15'] },
      [], '2026-06-01', '2026-06-30',
    )
    expect(r.holidayWorkDates.has('2026-06-15')).toBe(true)
    expect(r.closedDates.has('2026-06-15')).toBe(false)
  })

  it('holidayClosedYn=false → 공휴일 미합류 / true → 합류', () => {
    const off = buildHolidayClosure({ holidayClosedYn: false }, ['2026-01-01'], '2026-01-01', '2026-12-31')
    expect(off.closedDates.has('2026-01-01')).toBe(false)
    const on = buildHolidayClosure({ holidayClosedYn: true }, ['2026-01-01'], '2026-01-01', '2026-12-31')
    expect(on.closedDates.has('2026-01-01')).toBe(true)
  })

  it('공휴일이 workDate면 rescue (휴일근무 우선)', () => {
    const r = buildHolidayClosure(
      { holidayClosedYn: true, workDates: ['2026-01-01'] },
      ['2026-01-01'], '2026-01-01', '2026-12-31',
    )
    expect(r.closedDates.has('2026-01-01')).toBe(false)
  })

  it('빈 설정 → 전부 비어있음(안전)', () => {
    const r = buildHolidayClosure({}, [], '2026-01-01', '2026-12-31')
    expect(r.closedDates.size).toBe(0)
    expect(r.closedWeekdays.size).toBe(0)
    expect(r.holidayWorkDates.size).toBe(0)
    expect(r.holidayOpenDates.size).toBe(0)
  })
})

/**
 * STEP8 — 공휴일 운영시간 적용 대상 산출.
 * 규칙 한 줄: holidayOpenDates = 공휴일 ∧ ¬휴무(최종). 어느 경로로 진료가 됐든 공휴일 시간을 쓴다.
 */
describe('buildHolidayClosure — holidayOpenDates (공휴일인데 진료하는 날)', () => {
  it('holidayClosedYn=false(공휴일 진료) → 공휴일 전부가 대상', () => {
    const r = buildHolidayClosure(
      { holidayClosedYn: false }, ['2026-01-01', '2026-03-01'], '2026-01-01', '2026-12-31',
    )
    expect(r.holidayOpenDates.has('2026-01-01')).toBe(true)
    expect(r.holidayOpenDates.has('2026-03-01')).toBe(true)
  })

  it('holidayClosedYn=true(공휴일 휴무) → 대상 없음', () => {
    const r = buildHolidayClosure(
      { holidayClosedYn: true }, ['2026-01-01'], '2026-01-01', '2026-12-31',
    )
    expect(r.holidayOpenDates.size).toBe(0)
  })

  it('holidayClosedYn=true 여도 workDates 로 구제한 공휴일은 대상 (rescue 이후에 산출)', () => {
    const r = buildHolidayClosure(
      { holidayClosedYn: true, workDates: ['2026-01-01'] },
      ['2026-01-01', '2026-03-01'], '2026-01-01', '2026-12-31',
    )
    expect(r.holidayOpenDates.has('2026-01-01')).toBe(true)   // 구제됨 → 진료
    expect(r.holidayOpenDates.has('2026-03-01')).toBe(false)  // 여전히 휴무
  })

  it('공휴일 진료여도 그 날을 offDates 로 따로 쉬면 제외', () => {
    const r = buildHolidayClosure(
      { holidayClosedYn: false, offDates: ['2026-01-01'] },
      ['2026-01-01'], '2026-01-01', '2026-12-31',
    )
    expect(r.holidayOpenDates.has('2026-01-01')).toBe(false)
  })

  it('매주 휴무 요일과 겹쳐도 공휴일 진료 판정이 남는다 (요일휴무는 rules 가 무시)', () => {
    const wd = dayjs('2026-01-01').day()
    const r = buildHolidayClosure(
      { holidayClosedYn: false, recurringOffRules: [{ dayCd: wd, repeatTy: 'WEEKLY', monthlyNth: null }] },
      ['2026-01-01'], '2026-01-01', '2026-12-31',
    )
    expect(r.closedWeekdays.has(wd)).toBe(true)
    expect(r.holidayOpenDates.has('2026-01-01')).toBe(true)
  })
})

describe('공휴일 adapter(stub) → 휴무 반영 통합', () => {
  it('fetchPublicHolidays 샘플이 비어있지 않고, holidayClosedYn=true 면 closedDates 에 반영', async () => {
    const holidays = await fetchPublicHolidays()
    expect(holidays.length).toBeGreaterThan(0)

    const r = buildHolidayClosure(
      { holidayClosedYn: true },
      holidays, '2026-01-01', '2026-12-31',
    )
    // 샘플 전부 closedDates 에 반영
    for (const d of holidays) expect(r.closedDates.has(d)).toBe(true)
  })

  it('holidayClosedYn=false 면 어댑터 샘플이 있어도 미반영', async () => {
    const holidays = await fetchPublicHolidays()
    const r = buildHolidayClosure(
      { holidayClosedYn: false },
      holidays, '2026-01-01', '2026-12-31',
    )
    expect(r.closedDates.size).toBe(0)
  })
})
