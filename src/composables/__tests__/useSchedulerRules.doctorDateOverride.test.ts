import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { useSchedulerRules } from '../useSchedulerRules'

/**
 * 담당자 특정일자 운영 — 사업장 휴무일에 담당자가 그 날짜를 운영으로 정한 경우 (2026-08-27).
 *
 * 우선순위(계획서 §3-1-1, R11 사용자 확정):
 *   자기 특정일자 휴무 > 자기 특정일자 운영 > 자기 매주 휴무 > 자기 운영 요일 > (미설정) 사업장 상속
 *
 * 제보: 사업장 8/13 휴무 + 담당자 8/13 운영인데 스케줄러가 '휴무'으로 표기.
 * 원인 둘 —
 *   ① 헤더 뱃지가 쓰는 사업장 휴무 판정(isHospitalClosedDayForHeader)이 담당자를 안 봐 셀은 열리는데
 *      뱃지만 '휴무'이었다 → isHospitalClosedDayForDoctor 신설.
 *   ② 특정일자 운영의 **시각**이 어디서도 소비되지 않아(workDates 플래그만) 요일 시각·기관 폴백으로 열렸고,
 *      담당자 소스에서는 자기 특정일자 운영이 자기 매주 휴무를 덮지 못했다 → doctorRules.dailyByDate 신설.
 *
 * ⚠️ 타임라인 밴드(layoutPipeline.resolveUnitHours)도 같은 규칙 — 한쪽만 고치면 "밴드는 요일 시간으로
 *    열렸는데 클릭하면 운영종료"가 된다. 밴드 쪽은 layoutPipeline.test 가 고정한다.
 */

const D = '2026-08-13' // 목요일
const WD = dayjs(D).day()

function daily(start: string, end: string, breaks: { start: string; end: string; type: string }[] | null = null) {
  return { dayOffYn: 'N' as const, open: { start, end }, breaks, blocks: null }
}
function weekly7() {
  const w: Record<number, ReturnType<typeof daily>> = {}
  for (let wd = 0; wd <= 6; wd++) w[wd] = daily('09:00', '18:00')
  return w
}
const DATE_DAILY = daily('10:00', '14:00') // 담당자가 그 날짜에 저장한 시각

/* 담당자 네 명이 담당자 축의 상태를 덮는다 — 전부 사업장 8/13 휴무 위에 놓인다.
 *   kim  = 목 09~17 운영 + 8/13 특정일자 운영 10~14
 *   lee  = 목 매주 휴무 + 8/13 특정일자 운영 10~14   (일자 > 요일)
 *   park = 목 미설정 + 8/13 특정일자 운영 10~14      (기관 폴백 대신 그 시각)
 *   choi = 아무 설정 없음                             (사업장 휴무 상속) */
function makeDoctorRules() {
  return {
    kim: {
      weekly: { [WD]: daily('09:00', '17:00') },
      closedDates: new Set<string>(), closedWeekdays: new Set<number>(),
      workDates: new Set([D]), workWeekdays: new Set([WD]),
      dailyByDate: { [D]: DATE_DAILY },
    },
    lee: {
      weekly: { [WD]: null },
      closedDates: new Set<string>(), closedWeekdays: new Set([WD]),
      workDates: new Set([D]), workWeekdays: new Set<number>(),
      dailyByDate: { [D]: DATE_DAILY },
    },
    park: {
      weekly: {},
      closedDates: new Set<string>(), closedWeekdays: new Set<number>(),
      workDates: new Set([D]), workWeekdays: new Set<number>(),
      dailyByDate: { [D]: DATE_DAILY },
    },
    choi: {
      weekly: {},
      closedDates: new Set<string>(), closedWeekdays: new Set<number>(),
      workDates: new Set<string>(), workWeekdays: new Set<number>(),
      dailyByDate: {},
    },
  }
}

function setup(hospitalOverrides: Record<string, unknown> = {}, doctorRules: Record<string, unknown> = makeDoctorRules()) {
  return useSchedulerRules({
    hospitalRules: {
      closedDates: new Set([D]),          // 사업장 8/13 임시휴무
      closedWeekdays: new Set<number>(),
      holidayWorkDates: new Set<string>(),
      holidayOpenDates: new Set<string>(),
      weekly: weekly7(),
      holiday: undefined,
      dailyByDate: {},
      ...hospitalOverrides,
    } as any,
    doctorRules: doctorRules as any,
    blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
    selectedDoctors: new Set(['kim', 'lee', 'park', 'choi']),
    cellDuration: 30,
    doctorsRef: [
      { id: 'kim', text: '김담당' }, { id: 'lee', text: '이담당' },
      { id: 'park', text: '박담당' }, { id: 'choi', text: '최담당' },
    ],
    options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
  })
}

describe('useSchedulerRules — 담당자 특정일자 운영이 사업장 휴무를 덮는다', () => {
  it('★제보 재현: 사업장 휴무일에 담당자가 특정일자 운영면 뱃지·셀 모두 운영다', () => {
    const { getBlockedReason, isClosedDayForHeader, isHospitalClosedDayForDoctor, isHospitalClosedDayForHeader } = setup()

    expect(getBlockedReason(`${D}T11:00:00`, 'kim').blocked, '셀').toBe(false)
    expect(isClosedDayForHeader(D, 'kim'), '담당자 휴무 뱃지').toBe(false)
    expect(isHospitalClosedDayForDoctor(D, 'kim'), '사업장 휴무 뱃지(담당자 칸)').toBe(false)
    // 날짜 행(담당자 무관)은 여전히 사업장 휴무가다.
    expect(isHospitalClosedDayForHeader(D), '날짜 행').toBe(true)
  })

  it('아무것도 정하지 않은 담당자는 사업장 휴무를 상속한다 — 뱃지·셀 모두 휴무', () => {
    const { getBlockedReason, isClosedDayForHeader, isHospitalClosedDayForDoctor } = setup()

    const r = getBlockedReason(`${D}T11:00:00`, 'choi')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('closedDate')
    expect(r.source).toBe('hospital')
    expect(isClosedDayForHeader(D, 'choi')).toBe(true)
    expect(isHospitalClosedDayForDoctor(D, 'choi')).toBe(true)
  })

  it('★열리는 시간은 특정일자 시각(10~14)이다 — 요일 시각(09~17)으로 넓히지 않는다', () => {
    const { getBlockedReason } = setup()

    expect(getBlockedReason(`${D}T09:30:00`, 'kim').blocked, '요일 09:00 안이지만 특정일자 10:00 전').toBe(true)
    expect(getBlockedReason(`${D}T13:30:00`, 'kim').blocked, '특정일자 안').toBe(false)
    const late = getBlockedReason(`${D}T15:00:00`, 'kim')
    expect(late.blocked, '요일 17:00 안이지만 특정일자 14:00 후').toBe(true)
    expect(late.reason).toBe('outsideHours')
    expect(late.range).toEqual({ start: '10:00', end: '14:00' })
  })

  it('요일 미설정 담당자도 기관 폴백(09~18)이 아니라 특정일자 시각으로 연다', () => {
    const { getBlockedReason } = setup()

    expect(getBlockedReason(`${D}T11:00:00`, 'park').blocked).toBe(false)
    expect(getBlockedReason(`${D}T15:00:00`, 'park').blocked, '기관 18:00 안이지만 특정일자 14:00 후').toBe(true)
  })

  it('★일자 > 요일: 매주 휴무 요일이어도 특정일자 운영면 그날은 운영다', () => {
    const { getBlockedReason, isClosedDayForHeader, isHospitalClosedDayForDoctor } = setup()

    const r = getBlockedReason(`${D}T11:00:00`, 'lee')
    expect(r.blocked).toBe(false)
    expect(isClosedDayForHeader(D, 'lee')).toBe(false)
    expect(isHospitalClosedDayForDoctor(D, 'lee')).toBe(false)
    // 그 요일의 다른 날은 여전히 매주 휴무가다 — 특정일자가 요일 규칙을 지우지 않는다.
    const nextWeek = dayjs(D).add(7, 'day').format('YYYY-MM-DD')
    expect(getBlockedReason(`${nextWeek}T11:00:00`, 'lee').blocked).toBe(true)
  })

  it('자기 특정일자 휴무가 가장 먼저다 — 시각이 함께 실려 와도 휴무', () => {
    // 저장 규약상 한 날짜에 휴무와 운영이 공존하지 않지만, 순서 자체를 고정한다.
    const rules = makeDoctorRules()
    rules.kim.closedDates = new Set([D])
    const { getBlockedReason, isClosedDayForHeader } = setup({}, rules)

    const r = getBlockedReason(`${D}T11:00:00`, 'kim')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('closedDate')
    expect(r.source).toBe('doctor')
    expect(isClosedDayForHeader(D, 'kim')).toBe(true)
  })

  it('휴게는 그 날짜의 사업장 값을 쓴다 — 기관 지정일자 휴게가 있으면 그것', () => {
    // 사업장이 8/13 을 임시운영(09~18, 휴게 12:00~12:30)로 저장한 경우 — 휴무 아님.
    const { getBlockedReason } = setup({
      closedDates: new Set<string>(),
      dailyByDate: { [D]: daily('09:00', '18:00', [{ start: '12:00', end: '12:30', type: 'LUNCH' }]) },
    })

    const r = getBlockedReason(`${D}T12:00:00`, 'kim')
    expect(r.reason).toBe('lunch')
    expect(r.range).toEqual({ start: '12:00', end: '12:30' })
    // 운영 시작·종료는 여전히 담당자 특정일자 값이다.
    expect(getBlockedReason(`${D}T15:00:00`, 'kim').blocked).toBe(true)
  })

  it('특정일자가 없는 날은 종전대로 요일 규칙이다 (회귀 가드)', () => {
    const other = dayjs(D).add(7, 'day').format('YYYY-MM-DD')
    const { getBlockedReason } = setup()

    expect(getBlockedReason(`${other}T16:00:00`, 'kim').blocked, '요일 09~17 안').toBe(false)
    expect(getBlockedReason(`${other}T17:30:00`, 'kim').blocked, '요일 17:00 후').toBe(true)
  })
})

/**
 * 사업장 임시운영 지정은 담당자 매주 휴무를 덮지 못한다 — §3-1-1 `자기 매주 휴무 > 사업장 상속` (2026-08-28).
 * 종전에는 기관 `holidayWorkDates` 가 담당자 `closedWeekdays` 검사를 건너뛰고 `pickDailySchedule` 이 `weekly=null` 을
 * 기관 지정 시각으로 열어, 휴무일 탭 뷰어(`isStaffOffOn` → 휴무)와 보드(열림)가 같은 날짜에 다른 답을 냈다.
 */
describe('useSchedulerRules — 사업장 임시운영 지정 vs 담당자 매주 휴무', () => {
  // 사업장: 목요일 매주 휴무인데 8/13 만 임시운영(09~18, BE applyDefaultTime 이 채운 시각).
  const hospital = {
    closedDates: new Set<string>(),
    closedWeekdays: new Set([WD]),
    holidayWorkDates: new Set([D]),
    dailyByDate: { [D]: daily('09:00', '18:00') },
  }
  // lee = 매주 목 휴무(특정일자 없음) · choi = 아무 설정 없음
  function rules() {
    const r = makeDoctorRules()
    r.lee.workDates = new Set<string>()
    r.lee.dailyByDate = {}
    return r
  }

  it('★매주 휴무 담당자는 그날도 휴무가다 — 셀·뱃지 모두 (휴무일 탭 뷰어와 같은 답)', () => {
    const { getBlockedReason, isClosedDayForHeader, isHospitalClosedDayForDoctor } = setup(hospital, rules())

    const r = getBlockedReason(`${D}T11:00:00`, 'lee')
    expect(r.blocked, '기관 지정 시각 안이지만 담당자 휴무').toBe(true)
    expect(r.source).toBe('doctor')
    expect(r.reason).toBe('closedWeekday')
    expect(isClosedDayForHeader(D, 'lee'), '담당자 휴무 뱃지').toBe(true)
    expect(isHospitalClosedDayForDoctor(D, 'lee'), '사업장은 그날 운영라 기관 휴무 뱃지는 아니다').toBe(false)
  })

  it('미설정 담당자는 사업장을 따라 그날 운영다 — 기관 요일 휴무는 기관 임시운영이 덮는다 (회귀 가드)', () => {
    const { getBlockedReason, isClosedDayForHeader } = setup(hospital, rules())

    expect(getBlockedReason(`${D}T11:00:00`, 'choi').blocked).toBe(false)
    expect(isClosedDayForHeader(D, 'choi')).toBe(false)
    expect(getBlockedReason(`${D}T18:30:00`, 'choi').blocked, '지정일자 시각 밖').toBe(true)
  })

  it('closedWeekdays 없이 weekly=null 만 있어도 같은 답이다 — pickDailySchedule 도 담당자 휴무를 지킨다', () => {
    const r = rules()
    r.lee.closedWeekdays = new Set<number>()
    const { getBlockedReason, isClosedDayForHeader } = setup(hospital, r)

    const b = getBlockedReason(`${D}T11:00:00`, 'lee')
    expect(b.blocked).toBe(true)
    expect(b.source).toBe('doctor')
    expect(b.reason).toBe('outsideHours')
    expect(isClosedDayForHeader(D, 'lee')).toBe(true)
  })
})
