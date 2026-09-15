import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'
import { getTreatmentSettings, type SiteDayHours, type SiteWorkHoursResponse, type StaffWorkHoursResponse } from '@/api/siteApi'
import { staffOffSettingsInput, offDayHorizon, useStaffStore } from '../staffStore'
import { useSchedulerRules } from '@/composables/useSchedulerRules'

/**
 * S6 — 담당자 휴무일이 보드(예약화면)에 실리는 경로.
 *
 * 계약(S1~S2)이 내려주는 담당자 휴무 원천은 네 갈래인데 표현이 사업장과 다르다.
 *   매주 휴무   = times 행의 시분 null      (사업장은 recurringOffRules(WEEKLY))
 *   매월 N번째  = monthlyOffRules            (사업장은 recurringOffRules(MONTHLY))
 *   특정일자    = overrides 행의 시분 null   (사업장은 offDates)
 *   공휴일      = holidayOpenYn 'N'             (사업장은 holidayClosedYn)
 * `staffOffSettingsInput` 이 그 차이만 흡수하고, 합성은 사업장과 **같은 buildHolidayClosure** 를 쓴다.
 *
 * 보드 반영은 "엔진 무변경 · store 만 채운다"(계획서 §2-4)가 전제였다. 이 파일이 그 전제를 실측으로 고정한다.
 */

const mocks = vi.hoisted(() => ({ getSiteWorkHours: vi.fn(), getStaffWorkHours: vi.fn() }))
vi.mock('@/api/staffApi', () => ({ getDoctors: vi.fn(), syncDoctors: vi.fn() }))
vi.mock('@/api/siteApi', () => ({
  getSiteWorkHours: mocks.getSiteWorkHours,
  getStaffWorkHours: mocks.getStaffWorkHours,
  getTeams: vi.fn(async () => ({ data: { code: 'succeed', payload: { teams: [] } } })),
  getTreatmentSettings: vi.fn(async () => ({ data: { code: 'succeed', payload: {} } })),
}))
const holidayMock = vi.hoisted(() => ({ fetchPublicHolidays: vi.fn(async () => [] as string[]) }))
vi.mock('@/api/publicHolidayApi', () => holidayMock)
vi.mock('notivue', () => ({ push: { error: vi.fn(), success: vi.fn() } }))

// 2026-08-24(월) · 2026-08-25(화). horizon(today ±1년) 안이라 MONTHLY expand 대상이다.
const MON = '2026-08-24'
const TUE = '2026-08-25'

function inst(dayCd: number, over: Partial<SiteDayHours> = {}): SiteDayHours {
  return {
    dayCd,
    openHm: '0900', closeHm: '1800',
    lunchStartHm: null, lunchEndHm: null,
    dinnerStartHm: null, dinnerEndHm: null,
    ...over,
  }
}

/** 기관은 월~토 09~18 전부 운영 — 차단이 나오면 그 출처는 담당자뿐이다. */
function siteResponse(): SiteWorkHoursResponse {
  return {
    site: [1, 2, 3, 4, 5, 6].map((d) => inst(d)),
    holidayHours: null,
    recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false,
  }
}

type StaffEntry = StaffWorkHoursResponse['staff'][number]
function staff(over: Partial<StaffEntry> = {}): StaffEntry {
  return {
    staffId: 101,
    staffName: '김담당',
    times: [
      { dayCd: 1, staffOpenHm: '0900', staffCloseHm: '1800' },
      { dayCd: 2, staffOpenHm: '0900', staffCloseHm: '1800' },
    ],
    monthlyOffRules: [],
    holidayOpenYn: null,
    ...over,
  }
}

async function loadWith(payload: StaffWorkHoursResponse) {
  mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: siteResponse() } })
  mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload } })
  const store = useStaffStore()
  await store.loadSchedule()
  return store
}

/** 보드와 같은 옵션(DOCTOR_FIRST · FALLBACK)으로 store 를 물려 차단 사유를 읽는다. */
function boardRules(store: ReturnType<typeof useStaffStore>) {
  return useSchedulerRules({
    hospitalRules: store.hospitalRules,
    doctorRules: store.doctorRules,
    blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
    selectedDoctors: new Set(['김담당']),
    cellDuration: 30,
    doctorsRef: [{ id: '김담당', text: '김담당' }],
    options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
  } as never)
}

// ════════════════════════════════════════════════════════════
describe('staffOffSettingsInput — 담당자 휴무 원천 → buildHolidayClosure 입력', () => {
  it('매주 휴무는 times 의 시분 null 행이다 → WEEKLY 규칙으로 옮긴다', () => {
    const input = staffOffSettingsInput({
      times: [
        { dayCd: 0, staffOpenHm: null, staffCloseHm: null },
        { dayCd: 1, staffOpenHm: '0900', staffCloseHm: '1800' },
      ],
    })
    expect(input.recurringOffRules).toEqual([{ dayCd: 0, repeatTy: 'WEEKLY', monthlyNth: null }])
  })

  it('monthlyOffRules 는 MONTHLY 규칙으로, 차수를 그대로 옮긴다', () => {
    const input = staffOffSettingsInput({ monthlyOffRules: [{ dayCd: 3, monthlyNth: 2 }] })
    expect(input.recurringOffRules).toEqual([{ dayCd: 3, repeatTy: 'MONTHLY', monthlyNth: 2 }])
  })

  it('특정일자: 시분 없으면 휴무(offDates) · 있으면 운영(workDates=rescue)', () => {
    const input = staffOffSettingsInput({}, [
      { staffId: 101, date: MON, overrideOpenHm: null, overrideCloseHm: null },
      { staffId: 101, date: TUE, overrideOpenHm: '1000', overrideCloseHm: '1500' },
    ])
    expect(input.offDates).toEqual([MON])
    expect(input.workDates).toEqual([TUE])
  })

  it("공휴일은 'N' 만 휴무가다 — null(미설정)·'Y' 는 휴무로 만들지 않는다", () => {
    expect(staffOffSettingsInput({ holidayOpenYn: 'N' }).holidayClosedYn).toBe(true)
    expect(staffOffSettingsInput({ holidayOpenYn: null }).holidayClosedYn).toBe(false)
    expect(staffOffSettingsInput({ holidayOpenYn: 'Y' }).holidayClosedYn).toBe(false)
  })

  it('요일 범위 밖 코드는 버린다 (BE 가 CHECK 로 막지만 FE 도 통과시키지 않는다)', () => {
    const input = staffOffSettingsInput({
      times: [{ dayCd: 9, staffOpenHm: null, staffCloseHm: null }],
      monthlyOffRules: [{ dayCd: -1, monthlyNth: 1 }],
    })
    expect(input.recurringOffRules).toEqual([])
  })
})

describe('offDayHorizon — 기관·담당자가 같은 창을 쓴다', () => {
  it('기준일의 전년 1/1 ~ 익년 12/31', () => {
    const { startYmd, endYmd } = offDayHorizon(dayjs('2026-06-15'))
    expect(startYmd).toBe('2025-01-01')
    expect(endYmd).toBe('2027-12-31')
  })
})

// ════════════════════════════════════════════════════════════
describe('loadWorkHours — 담당자 휴무일이 doctorRules 에 실린다', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    holidayMock.fetchPublicHolidays.mockReset()
    holidayMock.fetchPublicHolidays.mockResolvedValue([])
  })

  it('특정일자 휴무가 closedDates 에 들어간다', async () => {
    const store = await loadWith({
      staff: [staff()],
      overrides: [{ staffId: 101, date: MON, overrideOpenHm: null, overrideCloseHm: null }],
    })
    expect([...(store.doctorRules['김담당']!.closedDates as Set<string>)]).toContain(MON)
  })

  it('매주 휴무 요일이 closedWeekdays 에 들어간다 (weekly=null 과 별개로 가산)', async () => {
    const store = await loadWith({
      staff: [staff({ times: [{ dayCd: 1, staffOpenHm: null, staffCloseHm: null }] })],
      overrides: [],
    })
    const rule = store.doctorRules['김담당']!
    expect([...(rule.closedWeekdays as Set<number>)]).toEqual([1])
    expect(rule.weekly![1]).toBeNull()
  })

  it('매월 N번째 요일이 horizon 안에서 날짜로 전개된다 (2026-08-24 = 8월 넷째 월요일)', async () => {
    const store = await loadWith({
      staff: [staff({ monthlyOffRules: [{ dayCd: 1, monthlyNth: 4 }] })],
      overrides: [],
    })
    expect([...(store.doctorRules['김담당']!.closedDates as Set<string>)]).toContain(MON)
  })

  it("공휴일 'N' 이면 공휴일이 그 담당자 closedDates 에 합류한다", async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([TUE])
    const store = await loadWith({ staff: [staff({ holidayOpenYn: 'N' })], overrides: [] })
    expect([...(store.doctorRules['김담당']!.closedDates as Set<string>)]).toContain(TUE)
  })

  it('특정일자 운영(시분 있음)는 매월 휴무를 구제한다 — 일자 지정이 반복 규칙보다 구체적이다', async () => {
    const store = await loadWith({
      staff: [staff({ monthlyOffRules: [{ dayCd: 1, monthlyNth: 4 }] })],
      overrides: [{ staffId: 101, date: MON, overrideOpenHm: '1000', overrideCloseHm: '1500' }],
    })
    expect([...(store.doctorRules['김담당']!.closedDates as Set<string>)]).not.toContain(MON)
  })

  it('override 는 staffId 로 갈린다 — 남의 휴무일이 옮아붙지 않는다', async () => {
    const store = await loadWith({
      staff: [staff(), staff({ staffId: 102, staffName: '이담당' })],
      overrides: [{ staffId: 102, date: MON, overrideOpenHm: null, overrideCloseHm: null }],
    })
    expect([...(store.doctorRules['이담당']!.closedDates as Set<string>)]).toContain(MON)
    expect([...(store.doctorRules['김담당']!.closedDates as Set<string>)]).not.toContain(MON)
  })

  it('holidayOpenDates 는 담지 않는다 — 소비처(useSchedulerRules)가 사업장 값만 읽는다', async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([TUE])
    const store = await loadWith({ staff: [staff({ holidayOpenYn: 'Y' })], overrides: [] })
    expect(store.doctorRules['김담당']!.holidayOpenDates).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════
// ★S6 핵심 — "엔진 무변경 · store 만 채운다" 가정의 실측
describe('보드 반영 실측 — store 를 채우면 차단 사유가 담당자으로 잡힌다', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    holidayMock.fetchPublicHolidays.mockReset()
    holidayMock.fetchPublicHolidays.mockResolvedValue([])
  })

  it('담당자 특정일자 휴무 → "담당자(김담당) 휴무일(2026-08-24)"', async () => {
    const store = await loadWith({
      staff: [staff()],
      overrides: [{ staffId: 101, date: MON, overrideOpenHm: null, overrideCloseHm: null }],
    })
    const { getBlockedReason, explainBlockedReason } = boardRules(store)
    const at = `${MON}T10:00:00`
    expect(getBlockedReason(at, '김담당').reason).toBe('closedDate')
    expect(explainBlockedReason(at, '김담당')).toBe(`담당자(김담당) 휴무일(${MON})`)
  })

  it('담당자 매월 N번째 휴무 → 같은 경로로 휴무일 차단', async () => {
    const store = await loadWith({
      staff: [staff({ monthlyOffRules: [{ dayCd: 1, monthlyNth: 4 }] })],
      overrides: [],
    })
    const { explainBlockedReason } = boardRules(store)
    expect(explainBlockedReason(`${MON}T10:00:00`, '김담당')).toBe(`담당자(김담당) 휴무일(${MON})`)
  })

  it('담당자 매주 휴무 → "휴무" 가 아니라 "휴무요일(월)" 로 사유가 좁혀진다', async () => {
    const store = await loadWith({
      staff: [staff({ times: [{ dayCd: 1, staffOpenHm: null, staffCloseHm: null }] })],
      overrides: [],
    })
    const { explainBlockedReason } = boardRules(store)
    expect(explainBlockedReason(`${MON}T10:00:00`, '김담당')).toBe('담당자(김담당) 휴무요일(월)')
  })

  it('휴무일이 아닌 날은 열려 있다 (차단이 날짜 밖으로 번지지 않는다)', async () => {
    const store = await loadWith({
      staff: [staff()],
      overrides: [{ staffId: 101, date: MON, overrideOpenHm: null, overrideCloseHm: null }],
    })
    const { getBlockedReason } = boardRules(store)
    expect(getBlockedReason(`${TUE}T10:00:00`, '김담당').blocked).toBe(false)
  })

  it('담당자가 미설정인 요일은 사업장 휴무일을 그대로 상속한다', async () => {
    // 수요일(3)은 김담당가 운영시간을 정하지 않았다 → 기관 판정으로 내려간다.
    const WED = '2026-08-26'
    const store = await loadWith({ staff: [staff()], overrides: [] })
    /* 사업장 일자 지정 휴무 — buildHolidayClosure 가 채우는 두 자리를 같이 둔다.
     * designatedOffDates 는 그 휴무가 **일자 축**에서 왔음을 가리키고, 담당자는 그 축을 정한 적이
     * 없을 때만 상속한다(§4-2). closedDates 만 두면 출처를 알 수 없는 휴무가 된다. */
    store.hospitalRules.closedDates = new Set([WED])
    store.hospitalRules.designatedOffDates = new Set([WED])

    const { getBlockedReason } = boardRules(store)
    const r = getBlockedReason(`${WED}T10:00:00`, '김담당')
    expect(r.blocked).toBe(true)
    expect(r.source).toBe('hospital')
  })
})

// ════════════════════════════════════════════════════════════
/**
 * R11 — "사업장이 휴무인데 담당자가 휴무가 아니면 담당자를 따른다"(사용자 확정 2026-08-20).
 * 보드·운영시간 탭·휴무일 탭 뷰어가 모두 이 규칙을 쓴다. 담당자 축 안에서는 구체적인 것이 이긴다:
 *   자기 특정일자 휴무 > 자기 특정일자 운영 > 자기 매주 휴무 > 자기 운영 요일 > (미설정) 사업장 상속.
 */
describe('R11 — 담당자 설정이 사업장 휴무를 덮는다', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    holidayMock.fetchPublicHolidays.mockReset()
    holidayMock.fetchPublicHolidays.mockResolvedValue([])
  })

  it('운영시간을 정해 둔 요일이면 사업장 특정일자 휴무를 덮는다', async () => {
    const store = await loadWith({ staff: [staff()], overrides: [] })
    store.hospitalRules.closedDates = new Set([TUE])   // 기관 임시휴무

    expect(boardRules(store).getBlockedReason(`${TUE}T10:00:00`, '김담당').blocked).toBe(false)
  })

  it('운영시간을 정해 둔 요일이면 사업장 매주 휴무 요일도 덮는다', async () => {
    const store = await loadWith({ staff: [staff()], overrides: [] })
    store.hospitalRules.closedWeekdays = new Set([1])  // 기관은 월요일 매주 휴무

    expect(boardRules(store).getBlockedReason(`${MON}T10:00:00`, '김담당').blocked).toBe(false)
  })

  it("공휴일 'Y' 는 사업장 공휴일 휴무를 덮는다", async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([TUE])
    const store = await loadWith({ staff: [staff({ holidayOpenYn: 'Y' })], overrides: [] })
    store.hospitalRules.closedDates = new Set([TUE])

    expect(boardRules(store).getBlockedReason(`${TUE}T10:00:00`, '김담당').blocked).toBe(false)
  })

  it('특정일자 운영은 운영시간 미설정 요일에도 사업장 휴무를 덮는다', async () => {
    const WED = '2026-08-26'
    const store = await loadWith({
      staff: [staff()],
      overrides: [{ staffId: 101, date: WED, overrideOpenHm: '1000', overrideCloseHm: '1500' }],
    })
    store.hospitalRules.closedDates = new Set([WED])

    expect(boardRules(store).getBlockedReason(`${WED}T10:00:00`, '김담당').blocked).toBe(false)
  })

  it('★자기 휴무가 먼저다 — 매주 휴무 요일에는 사업장 휴무를 덮지 않는다', async () => {
    const store = await loadWith({
      staff: [staff({ times: [{ dayCd: 1, staffOpenHm: null, staffCloseHm: null }] })],
      overrides: [],
    })
    store.hospitalRules.closedDates = new Set([MON])

    expect(boardRules(store).getBlockedReason(`${MON}T10:00:00`, '김담당').blocked).toBe(true)
  })

  it('★자기 특정일자 휴무가 자기 운영 요일보다 먼저다', async () => {
    const store = await loadWith({
      staff: [staff()],   // 월요일 09~18 운영
      overrides: [{ staffId: 101, date: MON, overrideOpenHm: null, overrideCloseHm: null }],
    })
    store.hospitalRules.closedDates = new Set([MON])

    const r = boardRules(store).getBlockedReason(`${MON}T10:00:00`, '김담당')
    expect(r.blocked).toBe(true)
    expect(r.source).toBe('doctor')
  })

  it('덮더라도 운영시간 밖은 여전히 막힌다 — 휴무 판정만 덮지 시간을 늘리지 않는다', async () => {
    const store = await loadWith({ staff: [staff()], overrides: [] })
    store.hospitalRules.closedDates = new Set([TUE])

    const r = boardRules(store).getBlockedReason(`${TUE}T20:00:00`, '김담당')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('outsideHours')
  })
})

// ════════════════════════════════════════════════════════════
/**
 * 특정일자 운영의 **시각**이 보드에 실린다 (2026-08-27).
 * 종전에는 override 를 "그날 운영한다"(workDates) 로만 접어 값을 버렸고, 그 날짜는 요일 시각(또는 기관 폴백)으로
 * 열렸다 — 10~15 로 저장했는데 09~18 이 열리는 상태. 또 담당자 소스에서 자기 특정일자 운영이 자기 매주 휴무를
 * 덮지 못해(일자 > 요일 미준수) 매주 휴무 요일의 특정일자 운영이 '휴무'으로 나왔다.
 */
describe('특정일자 운영 시각 → doctorRules.dailyByDate (일자 > 요일 > 사업장)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    holidayMock.fetchPublicHolidays.mockReset()
    holidayMock.fetchPublicHolidays.mockResolvedValue([])
  })

  const WED = '2026-08-26'
  const override = { staffId: 101, date: WED, overrideOpenHm: '1000', overrideCloseHm: '1500' }

  it('시분 있는 override 는 dailyByDate 에 시각으로 담긴다 · 시분 없는 override 는 담지 않는다', async () => {
    const store = await loadWith({
      staff: [staff()],
      overrides: [override, { staffId: 101, date: MON, overrideOpenHm: null, overrideCloseHm: null }],
    })
    const byDate = store.doctorRules['김담당']!.dailyByDate!
    expect(byDate[WED]?.open).toEqual({ start: '10:00', end: '15:00' })
    expect(byDate[MON]).toBeUndefined()
  })

  it('★그 날짜는 저장한 시각(10~15)으로 열린다 — 요일 시각·기관 폴백으로 넓히지 않는다', async () => {
    const store = await loadWith({ staff: [staff()], overrides: [override] })   // 수요일은 요일 미설정 → 종전엔 기관 09~18
    store.hospitalRules.closedDates = new Set([WED])

    const rules = boardRules(store)
    expect(rules.getBlockedReason(`${WED}T09:30:00`, '김담당').blocked, '10:00 전').toBe(true)
    expect(rules.getBlockedReason(`${WED}T12:00:00`, '김담당').blocked, '안').toBe(false)
    const late = rules.getBlockedReason(`${WED}T16:00:00`, '김담당')
    expect(late.blocked, '15:00 후').toBe(true)
    expect(late.reason).toBe('outsideHours')
  })

  it('★일자 > 요일: 매주 휴무 요일의 특정일자 운영은 운영이다 — 셀·뱃지 모두', async () => {
    const monOverride = { ...override, date: MON }
    const store = await loadWith({
      staff: [staff({ times: [{ dayCd: 1, staffOpenHm: null, staffCloseHm: null }] })],   // 월 매주 휴무
      overrides: [monOverride],
    })
    store.hospitalRules.closedDates = new Set([MON])

    const rules = boardRules(store)
    expect(rules.getBlockedReason(`${MON}T12:00:00`, '김담당').blocked).toBe(false)
    expect(rules.isClosedDayForHeader(MON, '김담당')).toBe(false)
    expect(rules.isHospitalClosedDayForDoctor(MON, '김담당')).toBe(false)
    // 다음 주 월요일은 그대로 매주 휴무가다.
    const nextMon = dayjs(MON).add(7, 'day').format('YYYY-MM-DD')
    expect(rules.getBlockedReason(`${nextMon}T12:00:00`, '김담당').blocked).toBe(true)
  })

  it('★제보 재현: 사업장 휴무 + 담당자 특정일자 운영 → 담당자 칸 뱃지는 휴무가 아니다 (날짜 행은 휴무)', async () => {
    const store = await loadWith({ staff: [staff()], overrides: [override] })
    store.hospitalRules.closedDates = new Set([WED])

    const rules = boardRules(store)
    expect(rules.isHospitalClosedDayForHeader(WED), '날짜 행(담당자 무관)').toBe(true)
    expect(rules.isHospitalClosedDayForDoctor(WED, '김담당'), '담당자 칸').toBe(false)
    expect(rules.isClosedDayForHeader(WED, '김담당')).toBe(false)
  })

  it('override 가 없는 담당자 칸은 사업장 휴무 뱃지를 그대로 받는다', async () => {
    const store = await loadWith({ staff: [staff(), staff({ staffId: 102, staffName: '박담당' })], overrides: [override] })
    store.hospitalRules.closedDates = new Set([WED])
    store.hospitalRules.designatedOffDates = new Set([WED])

    const rules = boardRules(store)
    expect(rules.isHospitalClosedDayForDoctor(WED, '박담당')).toBe(true)
    expect(rules.getBlockedReason(`${WED}T12:00:00`, '박담당').reason).toBe('closedDate')
  })
})

// ════════════════════════════════════════════════════════════
/**
 * 공휴일 운영 'Y' 인데 그 공휴일이 자기 매주 휴무 요일 — **그날은 휴무가다** (계획서 §4-2 2단계, 2026-08-28 확정).
 * 'Y' 는 "공휴일이라는 이유로는 쉬지 않는다"는 뜻일 뿐이라 요일 판정을 덮지 않는다 —
 * 매주 금요일 쉬는 담당자가 금요일 공휴일에 나온다는 결론은 성립하지 않는다.
 *
 * ★한때 store 가 기관 공휴일 시간·요일 시간을 dailyByDate 에 채워 그날을 열었다. 되돌렸다.
 */
describe("공휴일 'Y' + 매주 휴무 요일의 공휴일 → 요일 휴무가 이긴다", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    holidayMock.fetchPublicHolidays.mockReset()
    holidayMock.fetchPublicHolidays.mockResolvedValue([])
  })

  const FRI_HOLIDAY = '2026-10-09' // 한글날(금)
  const friOffY = () => staff({ times: [{ dayCd: 5, staffOpenHm: null, staffCloseHm: null }], holidayOpenYn: 'Y' })

  async function loadWithSite(site: SiteWorkHoursResponse, payload: StaffWorkHoursResponse) {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: site } })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload } })
    const store = useStaffStore()
    await store.loadSchedule()
    return store
  }

  it('기관 공휴일 시간이 있어도 채우지 않는다 — 요일 휴무가 이긴다', async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([FRI_HOLIDAY])
    const store = await loadWithSite(
      { ...siteResponse(), holidayHours: { openHm: '1000', closeHm: '1600', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null } },
      { staff: [friOffY()], overrides: [] },
    )
    expect(store.doctorRules['김담당']!.dailyByDate![FRI_HOLIDAY]).toBeUndefined()
  })

  it('기관 그 요일 시간이 있어도 채우지 않는다', async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([FRI_HOLIDAY])
    const store = await loadWith({ staff: [friOffY()], overrides: [] })   // siteResponse: 금 09~18 · holidayHours null
    expect(store.doctorRules['김담당']!.dailyByDate![FRI_HOLIDAY]).toBeUndefined()
  })

  it('★보드도 그날 휴무가다 — 휴무일 탭 뷰어와 같은 답. 다음 주 같은 요일도 그대로 휴무', async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([FRI_HOLIDAY])
    const store = await loadWith({ staff: [friOffY()], overrides: [] })

    const rules = boardRules(store)
    expect(rules.getBlockedReason(`${FRI_HOLIDAY}T11:00:00`, '김담당').blocked).toBe(true)
    expect(rules.isClosedDayForHeader(FRI_HOLIDAY, '김담당')).toBe(true)
    const nextFri = dayjs(FRI_HOLIDAY).add(7, 'day').format('YYYY-MM-DD')
    expect(rules.getBlockedReason(`${nextFri}T11:00:00`, '김담당').blocked).toBe(true)
  })

  it("'N' 이거나 운영 요일이면 채우지 않는다 — 기존 공휴일 경로 그대로", async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([FRI_HOLIDAY])
    const n = await loadWith({ staff: [staff({ times: [{ dayCd: 5, staffOpenHm: null, staffCloseHm: null }], holidayOpenYn: 'N' })], overrides: [] })
    expect(n.doctorRules['김담당']!.dailyByDate![FRI_HOLIDAY]).toBeUndefined()

    setActivePinia(createPinia())
    const y = await loadWith({ staff: [staff({ times: [{ dayCd: 5, staffOpenHm: '0900', staffCloseHm: '1300' }], holidayOpenYn: 'Y' })], overrides: [] })
    expect(y.doctorRules['김담당']!.dailyByDate![FRI_HOLIDAY]).toBeUndefined()
  })

  it('채울 기관 시간이 하나도 없으면 담지 않는다 — 요일 휴무가 남는다 (적용할 시간이 없으면 휴무)', async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([FRI_HOLIDAY])
    const store = await loadWithSite({ ...siteResponse(), site: [1, 2, 3, 4].map((d) => inst(d)) }, { staff: [friOffY()], overrides: [] })
    expect(store.doctorRules['김담당']!.dailyByDate![FRI_HOLIDAY]).toBeUndefined()
    expect(boardRules(store).getBlockedReason(`${FRI_HOLIDAY}T11:00:00`, '김담당').blocked).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════
/**
 * 축 단위 상속 (2026-08-28 확정) — 담당자는 **스스로 정하지 않은 축만** 사업장을 따라간다.
 * 요일 축과 일자 축이 따로 끊기고, 공휴일은 애초에 담당자 자기 축(holidayOpenYn)이라 상속 대상이 아니다.
 *
 * 이 판정은 휴무일 탭(SchedulerSettingsTreatmentSetting.inheritedInstitutionOff)과 **같은 답**이어야 한다.
 * 갈리면 설정에서 운영으로 보이는 날에 보드가 예약을 막거나, 그 반대가 된다.
 */
describe('축 단위 상속 — 보드가 휴무일 탭과 같은 답을 낸다', () => {
  const HOLIDAY = '2026-10-09'   // 한글날(금)

  function settings(over: Record<string, unknown> = {}) {
    return { offDates: [], workDates: [], recurringOffRules: [], holidayClosedYn: false, ...over }
  }

  async function loadWithSettings(over: Record<string, unknown>, payload: StaffWorkHoursResponse) {
    vi.mocked(getTreatmentSettings).mockResolvedValue(
      { data: { code: 'succeed', payload: settings(over) } } as never)
    return loadWith(payload)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getSiteWorkHours.mockReset()
    mocks.getStaffWorkHours.mockReset()
    holidayMock.fetchPublicHolidays.mockReset()
    holidayMock.fetchPublicHolidays.mockResolvedValue([])
    vi.mocked(getTreatmentSettings).mockResolvedValue(
      { data: { code: 'succeed', payload: settings() } } as never)
  })

  /* ★수요일로 본다 — staff() 기본값은 월·화에만 운영시간이 있어, 그 두 요일은 R11(운영으로 정한 요일이
   *  사업장 휴무를 이긴다)이 먼저 걸려 상속 여부가 드러나지 않는다. 수요일은 양쪽 다 미설정이다. */
  const WED = '2026-08-26'

  it('★요일 축을 스스로 정한 담당자는 사업장 매주 휴무를 따라가지 않는다', async () => {
    // 김담당는 화요일 하나만 휴무로 정했다 → 요일 축이 자기 것이 된다. 박담당는 아무것도 정하지 않았다.
    const store = await loadWithSettings(
      { recurringOffRules: [{ dayCd: 3, repeatTy: 'WEEKLY', monthlyNth: null }] },   // 기관 수요일 휴무
      {
        staff: [
          staff({ times: [{ dayCd: 2, staffOpenHm: null, staffCloseHm: null }] }),
          staff({ staffId: 102, staffName: '박담당' }),
        ],
        overrides: [],
      },
    )
    const rules = boardRules(store)

    expect(rules.getBlockedReason(`${WED}T10:00:00`, '김담당').blocked, '기관 수요일 휴무를 안 따른다').toBe(false)
    expect(rules.getBlockedReason(`${TUE}T10:00:00`, '김담당').blocked, '자기 화요일 휴무는 그대로').toBe(true)
    expect(rules.getBlockedReason(`${WED}T10:00:00`, '박담당').blocked, '정한 것이 없으면 상속').toBe(true)
  })

  it('★요일 축을 소유한 담당자의 미설정 요일에는 어느 휴무 배지도 붙지 않는다', async () => {
    /* 제보: 화요일만 휴무로 정한 담당자의 일요일 칸에 사업장 '휴무' 배지(회색)가 떴다.
     * 기관 일요일은 매주 휴무라 **운영시간 행 자체가 없고**(siteResponse 는 월~토만),
     * pickDailySchedule 의 마지막 폴백이 "아무도 안 정함"을 명시적 휴무(null)로 접어 휴무처럼 보였다.
     * 시간이 없는 것은 휴무가 아니다 — 정한 적 없는 휴무를 화면이 지어내면 안 된다. */
    const SUN = '2026-08-30'
    const store = await loadWithSettings(
      { recurringOffRules: [{ dayCd: 0, repeatTy: 'WEEKLY', monthlyNth: null }] },   // 기관 일요일 휴무
      {
        staff: [
          staff({ times: [{ dayCd: 2, staffOpenHm: null, staffCloseHm: null }] }),
          staff({ staffId: 102, staffName: '박담당' }),   // 아무것도 정하지 않음 → 기관 상속
        ],
        overrides: [],
      },
    )
    const rules = boardRules(store)

    expect(rules.isHospitalClosedDayForDoctor(SUN, '김담당'), '기관 휴무를 안 따르니 회색 배지 없음').toBe(false)
    expect(rules.isClosedDayForHeader(SUN, '김담당'), '담당자 휴무 배지도 없음').toBe(false)
    /* 정한 것이 없으면 기본 09:00~18:00 으로 연다 — 기관 휴무 요일이라 운영시간 행이 없다는 이유로
     * 막으면, 축을 끊어 놓고도 결과가 그대로라 규칙이 무력해진다(사용자 확정 2026-08-28). */
    expect(rules.getBlockedReason(`${SUN}T10:00:00`, '김담당').blocked, '기본 운영시간으로 열린다').toBe(false)
    expect(rules.isClosedDayForHeader(TUE, '김담당'), '자기가 정한 화요일은 그대로 휴무').toBe(true)

    expect(rules.getBlockedReason(`${SUN}T10:00:00`, '박담당').blocked, '상속하는 담당자는 그대로 휴무').toBe(true)
    expect(rules.isHospitalClosedDayForDoctor(SUN, '박담당'), '그 칸에는 회색 배지가 뜬다').toBe(true)
    expect(rules.isHospitalClosedDayForHeader(SUN), '날짜 행은 사업장 휴무 그대로').toBe(true)
  })

  it('★일자 축을 스스로 정한 담당자는 사업장 일자 지정을 따라가지 않는다', async () => {
    const OTHER = '2026-08-27'
    const store = await loadWithSettings(
      { offDates: [WED] },                                                  // 기관 수요일 임시휴무
      {
        staff: [staff(), staff({ staffId: 102, staffName: '박담당' })],
        // 김담당만 다른 날짜에 자기 지정이 있다 → 일자 축이 자기 것이 된다
        overrides: [{ staffId: 101, date: OTHER, overrideOpenHm: null, overrideCloseHm: null }],
      },
    )
    const rules = boardRules(store)

    expect(rules.getBlockedReason(`${WED}T10:00:00`, '김담당').blocked, '기관 지정을 안 따른다').toBe(false)
    expect(rules.getBlockedReason(`${WED}T10:00:00`, '박담당').blocked, '정한 것이 없으면 상속').toBe(true)
  })

  it('★사업장 일자 임시휴무는 공휴일 운영 담당자도 덮는다 — 뷰어와 같은 답', async () => {
    /* 한때 store 가 공휴일 운영 'Y' 인 담당자의 workDates 에 공휴일 전부를 담았다. 그래서 그 날짜가
     * 통째로 "담당자가 운영으로 정한 날"이 되어 **사업장이 콕 집어 지정한 임시휴무까지** 덮었고,
     * 뷰어는 휴무 · 보드는 운영으로 갈렸다. 'Y' 는 요일도 일자 지정도 덮지 않는다. */
    holidayMock.fetchPublicHolidays.mockResolvedValue([HOLIDAY])
    const store = await loadWithSettings(
      { offDates: [HOLIDAY] },
      { staff: [staff({ holidayOpenYn: 'Y' })], overrides: [] },
    )
    const r = boardRules(store).getBlockedReason(`${HOLIDAY}T11:00:00`, '김담당')

    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('closedDate')
    expect(r.source).toBe('hospital')
  })

  it('★사업장 공휴일 휴무는 담당자에게 상속되지 않는다 — 공휴일은 늘 자기 값이다', async () => {
    /* HOLIDAY_OPEN_YN 은 NOT NULL 2상태고(DEFAULT 'Y'), 기관 값은 팀 배치 시점에 이미 복사된다(계획서 §3-2).
     * 런타임으로 또 내려받으면 "공휴일에도 운영('Y')"로 정해 둔 담당자가 기관 휴무를 상속해 휴무가 된다. */
    holidayMock.fetchPublicHolidays.mockResolvedValue([HOLIDAY])
    const store = await loadWithSettings(
      { holidayClosedYn: true },
      { staff: [staff({ holidayOpenYn: 'Y' })], overrides: [] },
    )
    const rules = boardRules(store)

    expect(rules.getBlockedReason(`${HOLIDAY}T11:00:00`, '김담당').blocked, '셀').toBe(false)
    expect(rules.isHospitalClosedDayForDoctor(HOLIDAY, '김담당'), '뱃지').toBe(false)
    expect(rules.isHospitalClosedDayForHeader(HOLIDAY), '날짜 행은 그대로 휴무').toBe(true)
  })

  it("★공휴일에는 사업장 요일 휴무를 상속하지 않는다 — 기관 축도 공휴일이면 요일을 보지 않는다", async () => {
    // 2026-10-09(한글날)은 금요일. 기관은 금요일 매주 휴무 + 공휴일 휴무 둘 다 걸어 둔다.
    holidayMock.fetchPublicHolidays.mockResolvedValue([HOLIDAY])
    const store = await loadWithSettings(
      { holidayClosedYn: true, recurringOffRules: [{ dayCd: 5, repeatTy: 'WEEKLY', monthlyNth: null }] },
      { staff: [staff({ holidayOpenYn: 'Y' })], overrides: [] },
    )
    const rules = boardRules(store)

    /* 공휴일 축은 자기 값('Y')이라 안 따르고, 요일 축은 미설정이지만 **공휴일이라 보지 않는다.**
     * 여기서 요일 휴무가 대신 들어오면 기관이 쉬는 공휴일에 'Y' 로 정한 담당자만 못 나온다. */
    expect(rules.getBlockedReason(`${HOLIDAY}T11:00:00`, '김담당').blocked).toBe(false)
    // 같은 요일이지만 공휴일이 아닌 날은 종전대로 상속한다
    const plainFri = dayjs(HOLIDAY).add(7, 'day').format('YYYY-MM-DD')
    expect(rules.getBlockedReason(`${plainFri}T11:00:00`, '김담당').blocked, '평소 금요일은 상속').toBe(true)
  })

  it("담당자가 공휴일 휴무 'N' 이면 그 날은 자기 값으로 휴무가다", async () => {
    holidayMock.fetchPublicHolidays.mockResolvedValue([HOLIDAY])
    const store = await loadWithSettings({}, { staff: [staff({ holidayOpenYn: 'N' })], overrides: [] })

    expect(boardRules(store).getBlockedReason(`${HOLIDAY}T11:00:00`, '김담당').blocked).toBe(true)
  })
})
