/**
 * @vitest-environment happy-dom
 *
 * 담당자 운영시간 — **요일 단위** 사업장 기본값 상속 (2026-08-18).
 *
 * 상속 판정은 요일마다 따로 선다. 월요일 1건만 등록된 담당자의 화~일은 여전히 미설정이므로
 * 사업장의 그 요일 운영시간을 보여준다.
 *
 * 예전에는 "요일을 하나라도 정했으면 그 담당자 전체가 상속 대상에서 빠지는" 담당자 단위 판정이라,
 * 월요일 1건 때문에 나머지 6일이 빈칸(= 휴무)으로 보였다. 보드(staffStore.loadWorkHours → doctorRules)와
 * 월 캘린더(formatListEntries)는 처음부터 요일 단위였어서 화면끼리 서로 어긋나 있었다.
 *
 * 세 상태는 요일마다 독립이다(BE SiteService.getStaffWorkHours 규약):
 *   행 없음 = 미설정(기관 값 상속) / 행 + 시각 = 운영 / 행 + 시각 null = 휴무(빈칸, 상속 안 함)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const dialogMock = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/http', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => dialogMock,
}))
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => dialogMock,
}))
vi.mock('notivue', () => ({
  push: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({ isHoliday: () => false, ensureYears: vi.fn(async () => {}) }),
}))

const mocks = vi.hoisted(() => ({
  getTeams: vi.fn(),
  getSiteWorkHours: vi.fn(),
  getStaffWorkHours: vi.fn(),
  saveTreatmentSettings: vi.fn(),
  getUnassignedReservations: vi.fn(),
  assignUnassigned: vi.fn(),
}))
vi.mock('@/api/siteApi', () => ({
  getTeams: mocks.getTeams,
  getSiteWorkHours: mocks.getSiteWorkHours,
  getStaffWorkHours: mocks.getStaffWorkHours,
  saveTreatmentSettings: mocks.saveTreatmentSettings,
}))
vi.mock('@/api/bookApi', () => ({
  getUnassignedReservations: mocks.getUnassignedReservations,
  assignUnassigned: mocks.assignUnassigned,
}))

import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'
import { useStaffStore } from '@/stores/staffStore'
import { DEFAULT_OPERATING_END, DEFAULT_OPERATING_START } from '@/constants/operatingHours'

const SUN = 0, MON = 1, TUE = 2, WED = 3, SAT = 6
const DOC = 11

/* 사업장 — 월~토 09:00~18:00, 휴게는 요일마다 다르다(월 13:00~14:00 / 화 12:30~13:30).
 * 요일마다 다른 값을 둬야 휴게 열이 요일별 실값을 싣는지 확인된다(예전 '요일별 상이' 요약의 자리). */
const siteRows = [
  { dayCd: MON, openHm: '0900', closeHm: '1800', lunchStartHm: '1300', lunchEndHm: '1400', dinnerStartHm: null, dinnerEndHm: null },
  { dayCd: TUE, openHm: '0900', closeHm: '1800', lunchStartHm: '1230', lunchEndHm: '1330', dinnerStartHm: '1800', dinnerEndHm: '1830' },
  { dayCd: WED, openHm: '1000', closeHm: '1700', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
  { dayCd: SAT, openHm: '0900', closeHm: '1300', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
]

/* 실제 stage 데이터 모양 — 이 담당자는 **월요일 1건**만 등록돼 있다. */
const staffMondayOnly = [
  { staffId: DOC, staffName: '홍담당', times: [{ dayCd: MON, staffOpenHm: '0900', staffCloseHm: '1300' }] },
]

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

function setupMocks(staff: any[]) {
  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { teams: [{ id: 1, name: '1팀', doctors: [{ staffId: DOC, staffName: '홍담당' }] }] },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code: 'succeed',
      payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff, overrides: [] } } })
  mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
}

/** 운영시간 탭으로 옮기고 그 담당자 패널을 펼친다(기본 탭은 'OFF' 라 표가 렌더되지 않는다). */
async function openStaffHours(wrapper: any) {
  wrapper.vm.$.setupState.activeLeftTab = 'WORKING_HOURS'
  wrapper.vm.$.setupState.expandedTreatmentKey = `staff:${DOC}`
  await wrapper.vm.$nextTick()
}

/** 저장 payload 의 그 담당자 times[] */
function savedTimes(staffNo = DOC) {
  const body = mocks.saveTreatmentSettings.mock.calls[0][0]
  return body.workingHours.staff.find((m: any) => m.staffId === staffNo)?.times ?? []
}

describe('담당자 운영시간 — 요일 단위 사업장 기본값 상속', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    setupMocks(staffMondayOnly)
  })

  it('★월요일만 등록된 담당자의 화·수·토는 사업장의 그 요일 운영시간을 보여준다', async () => {
    const wrapper = await mountSetting()
    const { fetchStaffWorkHours } = wrapper.vm.$.setupState

    // 등록된 요일은 그 사람 값
    expect(fetchStaffWorkHours(DOC, MON, 'start')).toBe('09:00')
    expect(fetchStaffWorkHours(DOC, MON, 'end')).toBe('13:00')

    // 미설정 요일은 기관 값 — 요일마다 다른 기관 값을 각각 따라간다
    expect(fetchStaffWorkHours(DOC, TUE, 'start')).toBe('09:00')
    expect(fetchStaffWorkHours(DOC, TUE, 'end')).toBe('18:00')
    expect(fetchStaffWorkHours(DOC, WED, 'start')).toBe('10:00')
    expect(fetchStaffWorkHours(DOC, WED, 'end')).toBe('17:00')
    expect(fetchStaffWorkHours(DOC, SAT, 'end')).toBe('13:00')
  })

  /* 2026-09-02 규약 변경 — 아무도 정하지 않은 요일은 **예약장부 보드·타임라인이 실제로 여는 시간**을
   * 빌려 보여준다. 종전에는 빈칸이었는데, 사업장이 매주 쉬는 요일에는 기관 운영시간 행 자체가 없어
   * 기관 휴무를 상속하지 않는 담당자(휴무일 탭에서 자기 휴무를 정한 사람)의 칸이 통째로 비었다 —
   * 설정 화면에는 아무것도 없는데 보드에서는 09:00~18:00 로 예약을 받는 상태였다. */
  // 기대값 출처: 정책 결정(2026-09-02, 네 계층 폴백 통일 c75bde3·157cbb9). 종전 "빈칸이다" 단언은 그 결함을 규범처럼 봉인하고 있었다.
  it('★사업장도 그 요일을 정하지 않았으면 보드가 여는 기본 운영시간을 빌린다', async () => {
    const wrapper = await mountSetting()
    const { fetchStaffWorkHours, showsInheritedStaffTime } = wrapper.vm.$.setupState

    expect(fetchStaffWorkHours(DOC, SUN, 'start')).toBe(DEFAULT_OPERATING_START)
    expect(fetchStaffWorkHours(DOC, SUN, 'end')).toBe(DEFAULT_OPERATING_END)
    expect(showsInheritedStaffTime(DOC, SUN), '자기 값이 아니라 빌린 값이다').toBe(true)
  })

  /* 없는 값을 지어내지 않는다는 규범은 여기로 옮겨 왔다 — "정한 것이 없다"와 "모른다"는 다르다. */
  // 기대값 출처: 정책 결정(2026-09-02, 위 폴백 통일과 함께 — 조회 실패는 미설정과 다르다).
  it('★사업장 운영시간을 못 불러왔으면 빈칸이다 — 모르는 것을 기본값으로 지어내지 않는다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'failed', message: '조회 실패' } })
    const wrapper = await mountSetting()
    const { fetchStaffWorkHours } = wrapper.vm.$.setupState

    expect(fetchStaffWorkHours(DOC, SUN, 'start')).toBe('')
    expect(fetchStaffWorkHours(DOC, SUN, 'end')).toBe('')
  })

  it('★명시적 휴무(행 있음 + 시각 null)인 요일은 빈칸 — 기관 값을 상속하지 않는다', async () => {
    setupMocks([{
      staffId: DOC, staffName: '홍담당',
      times: [
        { dayCd: MON, staffOpenHm: '0900', staffCloseHm: '1300' },
        { dayCd: TUE, staffOpenHm: null, staffCloseHm: null },   // 화요일은 쉬기로 정했다
      ],
    }])
    const wrapper = await mountSetting()
    const { fetchStaffWorkHours } = wrapper.vm.$.setupState

    expect(fetchStaffWorkHours(DOC, TUE, 'start'), '휴무는 미설정이 아니다').toBe('')
    expect(fetchStaffWorkHours(DOC, WED, 'start'), '수요일은 여전히 미설정 → 기관 값').toBe('10:00')
  })

  it('기관 운영시간을 화면에서 고치면 미설정 요일 표기가 즉시 따라온다 (읽는 시점 참조)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.institutionWeeklyDayMap = new Map([[WED, [{ kind: 'WORK', start: '11:00', end: '15:00' }]]])
    await wrapper.vm.$nextTick()

    expect(state.fetchStaffWorkHours(DOC, WED, 'start')).toBe('11:00')
    expect(state.fetchStaffWorkHours(DOC, MON, 'start'), '등록된 요일은 영향 없다').toBe('09:00')
  })
})

describe('편집 — 고친 요일만 확정되고 나머지는 미설정으로 남는다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    setupMocks(staffMondayOnly)
  })

  it('★한 요일을 고쳐도 다른 요일은 payload 에 실리지 않는다 (기관 값이 굳지 않는다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(DOC, WED, 'end', '16:00')
    await state.onSave()

    const times = savedTimes()
    expect(times.map((t: any) => t.dayCd).sort(), '월(기존) + 수(방금 고침) 뿐').toEqual([MON, WED])

    const wed = times.find((t: any) => t.dayCd === WED)
    expect(wed.staffOpenHm, '보이던 기관 시작시각이 기준이 된다').toBe('1000')
    expect(wed.staffCloseHm).toBe('1600')
  })

  /**
   * ★2026-08-20 규약 변경 — 운영시간 탭은 더 이상 휴무를 만들지 않는다(탭 책임 분리).
   * 종전에는 × 버튼이 그 요일을 휴무(행 + 시각 null)으로 확정했다. 그런데 같은 상태를 휴무일 탭도
   * 만들게 되면서 두 화면이 한 데이터를 두고 다투게 됐다 — 휴무일 탭이 잠근 요일을 운영시간 탭이 다시 여는 식이다.
   * 이제 시간을 모두 비우면 **미설정**이다: 행이 나가지 않고 그 요일은 사업장 값을 다시 따라간다.
   * 휴무는 휴무일 탭에서만 정한다.
   */
  it('★시간을 모두 비운 요일은 행이 나가지 않는다 — 휴무가 아니라 미설정이다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(DOC, MON, 'start', '')
    state.setStaffWorkHours(DOC, MON, 'end', '')
    await state.onSave()

    expect(savedTimes(), '비운 요일은 휴무 행이 아니라 아무 행도 아니다').toEqual([])
  })

  // 기관도 정하지 않은 요일은 화면이 보드 기본값(DEFAULT_OPERATING_*)을 빌려 보여 준다 — 그 빌린 값이
  // 다른 요일을 고쳐 저장하는 김에 실려 나가면 "기본값"이 그 담당자의 자기 값으로 굳는다.
  // 기대값 출처: 위 표기 테스트(SUN = 빌린 값) + 저장 규약(고친 요일만 확정).
  it('★기본값을 빌린 요일(기관도 없는 SUN)은 다른 요일을 고쳐 저장해도 payload 에 굳지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    expect(state.showsInheritedStaffTime(DOC, SUN), '전제: SUN 은 빌린 값으로 보인다').toBe(true)

    state.setStaffWorkHours(DOC, WED, 'end', '16:00')
    await state.onSave()

    expect(savedTimes().find((t: any) => t.dayCd === SUN)).toBeUndefined()
    expect(state.showsInheritedStaffTime(DOC, SUN), '저장 뒤에도 빌린 값 그대로').toBe(true)
  })

  /* 변경이 없으면 onSave 는 아예 저장을 호출하지 않으므로(dirty 게이트) payload 빌더를 직접 본다. */
  it('아무것도 고치지 않으면 기존 요일 그대로다 (화면에 보이던 기관 값이 섞이지 않는다)', async () => {
    const wrapper = await mountSetting()
    const { buildWorkingHoursPayload } = wrapper.vm.$.setupState

    const times = buildWorkingHoursPayload().staff.find((m: any) => m.staffId === DOC).times
    expect(times.map((t: any) => t.dayCd)).toEqual([MON])
  })
})

describe('휴게시간 열 — 사업장 값을 요일별로 읽기 전용 표기', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    setupMocks(staffMondayOnly)
  })

  it('★요일마다 기관 휴게 실값을 싣는다 (요약 한 줄의 "요일별 상이" 대체)', async () => {
    const wrapper = await mountSetting()
    const { staffBreakText } = wrapper.vm.$.setupState

    expect(staffBreakText(DOC, MON, 'LUNCH')).toBe('13:00~14:00')
    expect(staffBreakText(DOC, TUE, 'LUNCH'), '월과 다른 값이 그대로 보인다').toBe('12:30~13:30')
    expect(staffBreakText(DOC, TUE, 'DINNER')).toBe('18:00~18:30')
    expect(staffBreakText(DOC, WED, 'LUNCH'), '기관이 그 요일 휴게를 안 가짐').toBe('-')
  })

  it('운영이 없는 요일은 휴게도 의미가 없어 "-" 다', async () => {
    const wrapper = await mountSetting()
    const { staffBreakText } = wrapper.vm.$.setupState

    expect(staffBreakText(DOC, SUN, 'LUNCH'), '기관·담당자 모두 일요일 운영 없음').toBe('-')
  })

  it('표에 휴게시간 열이 렌더된다 (요약 줄은 사라졌다)', async () => {
    const wrapper = await mountSetting()
    await openStaffHours(wrapper)

    expect(wrapper.find('.schedulerTreatmentSetting__staffBreakRow').exists(), '요약 줄 제거됨').toBe(false)

    /* 열 머리글은 두지 않는다 — 라벨이 그 자리에서 무슨 값인지 밝힌다(사업장 패널 표와 같은 모양).
     * 그래서 번호만 줄인 축약형이 아니라 전체 표기여야 한다. */
    expect(wrapper.find('.schedulerTreatmentSetting__staffHoursTable thead').exists()).toBe(false)

    const cell = wrapper.find('.schedulerTreatmentSetting__staffBreakCell').text()
    expect(cell).toContain('휴게시간1')
    expect(cell).toContain('휴게시간2')
  })
})
