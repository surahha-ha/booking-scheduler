import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SiteDayHours, SiteWorkHoursResponse, StaffWorkHoursResponse, WorkHoursRow } from '@/api/siteApi'
import { institutionToWeekly, workHoursRowToDailySchedule, useStaffStore } from '../staffStore'

/**
 * 운영시간 신(新) 계약 (2026-07 · 운영시간 원천 전환)
 *  - 원천 분리 2조회: getSiteWorkHours(사업장, 사업장 strict) + getStaffWorkHours(담당자, 자체 TB).
 *  - 3세션(오전/오후/야간) 폐기 → 진료는 **시작~종료 단일 구간**. USE_YN 필드 없음.
 *    시작·종료가 null 이면 그 요일은 진료하지 않는다(= weekly 생략 → 상위 fallback).
 *  - 휴게(점심·저녁)는 **사업장(site)만 소유**한다. 담당자 행에는 휴게 필드가 없다.
 *    대신 같은 요일의 기관 휴게를 담당자 운영시간에 얹고(clamp), 의사 컬럼에도 음영을 그린다.
 *  - 세션 gap 이 사라졌으므로 CLOSED break 는 더 이상 생성되지 않는다.
 */

// staffStore 는 모듈 로드 시 useApi() 를 호출하는 api 모듈들을 import 한다 → 전부 stub.
const mocks = vi.hoisted(() => ({ getSiteWorkHours: vi.fn(), getStaffWorkHours: vi.fn() }))
vi.mock('@/api/staffApi', () => ({
  getDoctors: vi.fn(),
  addDoctors: vi.fn(),
  syncDoctors: vi.fn(),
}))
vi.mock('@/api/siteApi', () => ({
  getSiteWorkHours: mocks.getSiteWorkHours,
  getStaffWorkHours: mocks.getStaffWorkHours,
  getTeams: vi.fn(async () => ({ data: { code: '200', payload: { teams: [] } } })),
  // loadSchedule 은 운영시간과 휴무설정을 함께 부른다 — 휴무설정은 이 파일의 관심사가 아니므로 빈 payload.
  getTreatmentSettings: vi.fn(async () => ({ data: { code: '200', payload: {} } })),
}))
vi.mock('@/api/publicHolidayApi', () => ({ fetchPublicHolidays: vi.fn(async () => []) }))
vi.mock('notivue', () => ({ push: { error: vi.fn(), success: vi.fn() } }))

// ── fixtures ──────────────────────────────────────────────
/** 사업장 요일 1행 — 진료 시작~종료 + 휴게 1(점심)·2(저녁). 미설정은 null. */
function inst(dayCd: number, over: Partial<SiteDayHours> = {}): SiteDayHours {
  return {
    dayCd,
    openHm: null, closeHm: null,
    lunchStartHm: null, lunchEndHm: null,
    dinnerStartHm: null, dinnerEndHm: null,
    ...over,
  }
}

/** 담당자 요일 1행 — 진료 시작~종료만. 휴게 필드 없음. */
function row(over: Partial<WorkHoursRow> = {}): WorkHoursRow {
  return { dayCd: 1, staffOpenHm: null, staffCloseHm: null, ...over }
}

/** workHoursRowToDailySchedule 2번째 인자(기관 휴게) — "HH:MM" 구간. */
const lunch = (start: string, end: string) => ({ range: { start, end }, type: 'LUNCH' as const })
const dinner = (start: string, end: string) => ({ range: { start, end }, type: 'DINNER' as const })

/** site(사업장) strict 번들 응답 조립 — 운영시간 + (빈)휴무 규칙. */
function siteResponse(site: SiteDayHours[], holidayHours: SiteWorkHoursResponse['holidayHours'] = null): SiteWorkHoursResponse {
  return { site, holidayHours, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false }
}

// ════════════════════════════════════════════════════════════
describe('institutionToWeekly — 기관 운영시간 요일별 N행 → weekly', () => {
  it('진료 09~18 + 점심 13~14 → open 단일구간 + LUNCH break', () => {
    const w = institutionToWeekly([inst(1, {
      openHm: '0900', closeHm: '1800',
      lunchStartHm: '1300', lunchEndHm: '1400',
    })])
    const d = w[1]!
    expect(d.open).toEqual({ start: '09:00', end: '18:00' })
    expect(d.breaks).toHaveLength(1)
    expect(d.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
    expect(d.dayOffYn).toBe('N')
    // 목록에 없는 요일은 weekly 에 들어가지 않는다
    expect(w[0]).toBeUndefined()
  })

  it('요일마다 다른 운영시간이 각 요일에 그대로 보존된다 (접기 금지의 핵심)', () => {
    // 월 09~18 / 토 09~13 — 접어서 균일화하면 토요일 오후가 열려버린다.
    const w = institutionToWeekly([
      inst(1, { openHm: '0900', closeHm: '1800' }),
      inst(6, { openHm: '0900', closeHm: '1300' }),
    ])
    expect(w[1]!.open).toEqual({ start: '09:00', end: '18:00' })
    expect(w[6]!.open).toEqual({ start: '09:00', end: '13:00' })
    // 운영시간이 없는 요일(화~금, 일)은 생략 → 상위 fallback
    expect(w[2]).toBeUndefined()
  })

  it('휴게시간도 요일별로 다르게 적용된다', () => {
    const w = institutionToWeekly([
      inst(1, { openHm: '0900', closeHm: '1800', lunchStartHm: '1300', lunchEndHm: '1400' }),
      inst(2, { openHm: '0900', closeHm: '1800', lunchStartHm: '1230', lunchEndHm: '1330' }),
    ])
    expect(w[1]!.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
    expect(w[2]!.breaks![0]).toMatchObject({ start: '12:30', end: '13:30', type: 'LUNCH' })
  })

  it('휴게시간1(점심) + 휴게시간2(저녁) → break 2개, 시작 시각 순', () => {
    const w = institutionToWeekly([inst(1, {
      openHm: '0900', closeHm: '2100',
      lunchStartHm: '1300', lunchEndHm: '1400',
      dinnerStartHm: '1800', dinnerEndHm: '1830',
    })])
    const d = w[1]!
    expect(d.open).toEqual({ start: '09:00', end: '21:00' })
    expect(d.breaks).toHaveLength(2)
    expect(d.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
    expect(d.breaks![1]).toMatchObject({ start: '18:00', end: '18:30', type: 'DINNER' })
  })

  it('운영시간 밖 휴게는 잘린다 — 진료 09~13, 점심 13~14 → 휴게 없음 / 진료 09~13:30 이면 13:00~13:30 만', () => {
    const outside = institutionToWeekly([inst(1, {
      openHm: '0900', closeHm: '1300', lunchStartHm: '1300', lunchEndHm: '1400',
    })])[1]!
    expect(outside.open).toEqual({ start: '09:00', end: '13:00' })
    expect(outside.breaks).toBeNull()

    const partial = institutionToWeekly([inst(1, {
      openHm: '0900', closeHm: '1330', lunchStartHm: '1300', lunchEndHm: '1400',
    })])[1]!
    expect(partial.breaks).toHaveLength(1)
    expect(partial.breaks![0]).toMatchObject({ start: '13:00', end: '13:30', type: 'LUNCH' })
  })

  it('CLOSED break 는 더 이상 만들어지지 않는다 (세션 gap 개념 소멸)', () => {
    const d = institutionToWeekly([inst(1, {
      openHm: '0900', closeHm: '2100',
      lunchStartHm: '1300', lunchEndHm: '1400',
      dinnerStartHm: '1800', dinnerEndHm: '1830',
    })])[1]!
    expect(d.breaks!.every(b => b.type !== 'CLOSED')).toBe(true)
  })

  it('진료 시작/종료가 null 인 요일 → weekly 에서 생략 (그 요일 휴무 → 상위 fallback)', () => {
    // 휴게만 있고 진료 구간이 없는 행도 마찬가지(진료 안 함)
    expect(institutionToWeekly([inst(1)])).toEqual({})
    expect(institutionToWeekly([inst(1, { lunchStartHm: '1300', lunchEndHm: '1400' })])).toEqual({})
    expect(institutionToWeekly([inst(1, { openHm: '0900' })])).toEqual({}) // 한쪽만 있는 중간 상태도 휴무
  })

  it('빈 배열/null/undefined → {} (한 번도 등록 안 한 거래처)', () => {
    expect(institutionToWeekly([])).toEqual({})
    expect(institutionToWeekly(null)).toEqual({})
    expect(institutionToWeekly(undefined)).toEqual({})
  })
})

// ════════════════════════════════════════════════════════════
describe('workHoursRowToDailySchedule — 담당자 요일 1행 + 기관 휴게 얹기', () => {
  it('의사 09~18 + 기관 점심 13~14 → 의사 daily.breaks 에 LUNCH 13~14 (의사 컬럼에도 휴게가 그려진다)', () => {
    const d = workHoursRowToDailySchedule(
      row({ staffOpenHm: '0900', staffCloseHm: '1800' }),
      [lunch('13:00', '14:00')],
    )!
    expect(d.open).toEqual({ start: '09:00', end: '18:00' })
    expect(d.breaks).toHaveLength(1)
    expect(d.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
    expect(d.dayOffYn).toBe('N')
  })

  it('기관 점심+저녁 → 둘 다 의사 daily 에 얹힌다 (시작 시각 순)', () => {
    const d = workHoursRowToDailySchedule(
      row({ staffOpenHm: '0900', staffCloseHm: '2100' }),
      [lunch('13:00', '14:00'), dinner('18:00', '18:30')],
    )!
    expect(d.breaks).toHaveLength(2)
    expect(d.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
    expect(d.breaks![1]).toMatchObject({ start: '18:00', end: '18:30', type: 'DINNER' })
  })

  it('의사 운영시간 밖 기관 휴게는 잘린다 — 의사 09~13 + 점심 13~14 → 휴게 없음', () => {
    const d = workHoursRowToDailySchedule(
      row({ staffOpenHm: '0900', staffCloseHm: '1300' }),
      [lunch('13:00', '14:00')],
    )!
    expect(d.open).toEqual({ start: '09:00', end: '13:00' })
    expect(d.breaks).toBeNull()
  })

  it('부분 겹침 휴게는 겹치는 만큼만 — 의사 09~13:30 + 점심 13~14 → 13:00~13:30', () => {
    const d = workHoursRowToDailySchedule(
      row({ staffOpenHm: '0900', staffCloseHm: '1330' }),
      [lunch('13:00', '14:00')],
    )!
    expect(d.breaks).toHaveLength(1)
    expect(d.breaks![0]).toMatchObject({ start: '13:00', end: '13:30', type: 'LUNCH' })
  })

  it('기관 휴게가 없으면 의사도 휴게 없음 — 단일 구간 통짜', () => {
    const noBreaks = workHoursRowToDailySchedule(row({ staffOpenHm: '0900', staffCloseHm: '1800' }), [])!
    expect(noBreaks.open).toEqual({ start: '09:00', end: '18:00' })
    expect(noBreaks.breaks).toBeNull()

    // 인자 자체를 안 넘긴 경우(기관 행 없는 요일)도 동일
    const noArg = workHoursRowToDailySchedule(row({ staffOpenHm: '0900', staffCloseHm: '1800' }))!
    expect(noArg.breaks).toBeNull()
  })

  it('시작/종료 null → undefined (그 요일 미진료 → 기관 site fallback)', () => {
    expect(workHoursRowToDailySchedule(row())).toBeUndefined()
    // 기관 휴게가 있어도 진료 구간이 없으면 daily 자체가 없다(휴게만 있는 요일은 만들지 않는다)
    expect(workHoursRowToDailySchedule(row(), [lunch('13:00', '14:00')])).toBeUndefined()
    // 한쪽만 있는 중간 상태도 미진료
    expect(workHoursRowToDailySchedule(row({ staffOpenHm: '0900' }))).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════
// loadWorkHours 배선 — site/staff 원천 분리 2조회 + "기관 휴게를 요일별로 뽑아 담당자 daily 에 얹는다".
describe('loadWorkHours — site(기관) + staff(담당자, 기관 휴게 병합)', () => {
  const site: SiteDayHours[] = [
    // 월~금 09~18 (점심 13~14), 토 09~13 (휴게 없음), 일요일 행 없음 = 매주 휴무(recurringOffRules)
    inst(1, { openHm: '0900', closeHm: '1800', lunchStartHm: '1300', lunchEndHm: '1400' }),
    inst(6, { openHm: '0900', closeHm: '1300' }),
  ]
  const staffPayload: StaffWorkHoursResponse = {
    staff: [
      {
        staffId: 101,
        staffName: '김의사',
        // 월 09~18(기관과 동일), 토 09~13, 일 휴무
        times: [
          row({ dayCd: 0 }),
          row({ dayCd: 1, staffOpenHm: '0900', staffCloseHm: '1800' }),
          row({ dayCd: 6, staffOpenHm: '0900', staffCloseHm: '1300' }),
        ],
      },
      {
        staffId: 102,
        staffName: '이의사',
        // 월 오전만(09~13) → 기관 점심(13~14)이 운영시간 밖이라 잘려 사라진다
        times: [row({ dayCd: 1, staffOpenHm: '0900', staffCloseHm: '1300' })],
      },
    ],
    overrides: [],
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: siteResponse(site) } })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: staffPayload } })
  })

  it('기관 weekly: 요일별 open + 휴게, 미등록 요일(일)은 생략', async () => {
    const store = useStaffStore()
    await store.loadSchedule()

    const weekly = store.hospitalRules.weekly!
    expect(weekly[1]!.open).toEqual({ start: '09:00', end: '18:00' })
    expect(weekly[1]!.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
    expect(weekly[6]!.open).toEqual({ start: '09:00', end: '13:00' })
    expect(weekly[6]!.breaks).toBeNull()
    expect(weekly[0]).toBeUndefined()
  })

  it('담당자 weekly: 같은 요일 기관 휴게가 의사 daily 에 병합된다 (의사 컬럼 휴게 음영의 근거)', async () => {
    const store = useStaffStore()
    await store.loadSchedule()

    const kim = store.doctorRules['김의사']!.weekly!
    expect(kim[1]!.open).toEqual({ start: '09:00', end: '18:00' })
    expect(kim[1]!.breaks).toHaveLength(1)
    expect(kim[1]!.breaks![0]).toMatchObject({ start: '13:00', end: '14:00', type: 'LUNCH' })
  })

  it('담당자 weekly: 기관 휴게 없는 요일(토)은 의사도 휴게 없음 / 운영시간 밖이면 잘려 사라진다', async () => {
    const store = useStaffStore()
    await store.loadSchedule()

    // 토요일: 기관에 휴게 자체가 없음
    expect(store.doctorRules['김의사']!.weekly![6]!.breaks).toBeNull()
    // 이의사 월요일 09~13 → 기관 점심(13~14)이 운영시간 밖 → 휴게 없음
    const lee = store.doctorRules['이의사']!.weekly!
    expect(lee[1]!.open).toEqual({ start: '09:00', end: '13:00' })
    expect(lee[1]!.breaks).toBeNull()
  })

  /**
   * ★2026-07-29 정정. 예전엔 시각 null 행을 버려(키 없음) 미설정과 같이 취급했는데,
   * times 에는 **정한 요일만** 실려 오므로 그 행은 미설정이 아니라 **명시적 휴무**이다.
   * 버리면 쉬는 의사 컬럼이 기관 운영시간으로 열린다 → null 로 담아 fallback 을 막는다.
   */
  it('담당자 휴무 요일(시작/종료 null)은 weekly 에 null 로 담긴다 — 미설정(키 없음)과 구분', async () => {
    const store = useStaffStore()
    await store.loadSchedule()

    // 김의사 일요일(dayCd 0): 행은 있고 시각만 null → 명시적 휴무
    expect(store.doctorRules['김의사']!.weekly![0]).toBeNull()
    // 이의사: 월요일 행 하나만 → 나머지 요일은 행 자체가 없다(미설정 → 기관 fallback)
    expect(Object.keys(store.doctorRules['이의사']!.weekly!)).toEqual(['1'])
    expect(store.doctorRules['이의사']!.weekly![0]).toBeUndefined()
  })

  it('시간축(min/max)은 7요일 전체의 최소~최대 (요일별 편차 흡수, 30분 스냅)', async () => {
    const store = useStaffStore()
    await store.loadSchedule()

    expect(store.treatmentMinHour).toBe(9)   // 09:00
    expect(store.treatmentMaxHour).toBe(18)  // 월~금 18:00 (토 13:00 아님)
  })

  it('원천 분리 — site 와 staff 를 각각 1콜씩 병렬 호출한다', async () => {
    const store = useStaffStore()
    await store.loadSchedule()
    expect(mocks.getSiteWorkHours).toHaveBeenCalledTimes(1)
    expect(mocks.getStaffWorkHours).toHaveBeenCalledTimes(1)
  })

  // STEP8 — 공휴일 운영시간은 요일 축이 없는 별도 한 세트라 weekly 에 섞지 않고 holiday 로 따로 싣는다.
  it('공휴일 운영시간(holidayHours) → hospitalRules.holiday, weekly 에는 섞이지 않는다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: siteResponse(site, {
          openHm: '1000', closeHm: '1500',
          lunchStartHm: '1200', lunchEndHm: '1230',
          dinnerStartHm: null, dinnerEndHm: null,
        }),
      },
    })
    const store = useStaffStore()
    await store.loadSchedule()

    const holiday = store.hospitalRules.holiday!
    expect(holiday.open).toEqual({ start: '10:00', end: '15:00' })
    expect(holiday.breaks![0]).toMatchObject({ start: '12:00', end: '12:30', type: 'LUNCH' })
    // 요일 맵은 그대로 (특수 키가 끼어들면 weekly 를 통째로 순회하는 소비처가 오작동한다)
    expect(Object.keys(store.hospitalRules.weekly!).sort()).toEqual(['1', '6'])
    // 시간축은 요일 기준 유지 — 공휴일 10:00 시작이 전역 min 을 끌어내리지 않는다
    expect(store.treatmentMinHour).toBe(9)
  })

  it('holidayHours=null(미설정) → holiday 는 null (공휴일 휴무와 다르다)', async () => {
    const store = useStaffStore()
    await store.loadSchedule()
    expect(store.hospitalRules.holiday).toBeNull()
  })

  it('site 조회 장애(reject) 는 화면을 통째로 날리지 않는다 — weekly 는 비고 예외로 터지지 않는다', async () => {
    mocks.getSiteWorkHours.mockRejectedValueOnce(new Error('service unavailable'))
    const store = useStaffStore()
    await expect(store.loadSchedule()).resolves.toBeDefined()
    // 실패 시 weekly 는 채워지지 않는다(빈 객체) — fallback(09~18)은 스케줄러 룰이 담당.
    expect(store.hospitalRules.weekly ?? {}).toEqual({})
  })
})
