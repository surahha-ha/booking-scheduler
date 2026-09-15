/**
 * @vitest-environment happy-dom
 *
 * 휴무일 탭 — 담당자 컨트롤 (S5, 2026-08-20).
 *
 * 사업장에만 있던 요일별·특정일자·공휴일 컨트롤을 담당자에게도 준다. 이 파일이 지키는 것:
 *
 *  1) 컨트롤은 **선택된 대상 하나**에만 붙는다 — 두 패널이 함께 떠 있으면 우측 캘린더가
 *     어느 쪽을 그리는지 알 수 없다. 담당자 것은 그 담당자가 속한 팀 칩 리스트 아래에 붙는다.
 *
 *  2) 담당자의 **매주 휴무는 운영시간 표 그 자체**(entry = [])다 — 별도 상태를 두면
 *     운영시간 탭과 두 벌이 되어 서로를 덮어쓴다. 매월 N번째만 신규 상태가 담는다.
 *
 *  3) 공휴일은 체크박스 1개다. 미설정(null)은 사업장 값을 그대로 보여주고,
 *     만지는 순간 'Y'/'N' 으로 확정된다.
 *
 *  4) 우측 뷰어는 선택한 대상으로 판정하고, **정하지 않은 날은 사업장 판정을 상속**한다.
 *     달력에서 "그 날짜 운영"로 뒤집으면 운영시간을 FE 가 채운다(빈 지정은 휴무와 구분되지 않는다).
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

/* 공휴일 축을 검증해야 하므로 특정 날짜만 공휴일로 둔다 — 2026-08-15(토) 광복절 */
const HOLIDAY = '2026-08-15'
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({ isHoliday: (key: string) => key === HOLIDAY, ensureYears: vi.fn(async () => {}) }),
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

import dayjs from 'dayjs'
import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'
import { useStaffStore } from '@/stores/staffStore'

const SUN = 0, MON = 1, WED = 3, THU = 4, FRI = 5, SAT = 6
const DOC = 11
const OWNER = `STAFF:${DOC}`

/* 2026년 8월 — 월요일: 3·10·17·24·31 (1~5번째) / 수요일: 5·12·19·26 */
const MON_1ST = '2026-08-03'
const MON_3RD = '2026-08-17'

/* 사업장 — 월 10:00~17:00. ★기본값(09:00~18:00)과 일부러 다르게 둔다 —
 * 같으면 "기관 값을 끌어왔는지" 와 "기본값으로 때웠는지" 가 구분되지 않는다. */
const siteRows = [
  { dayCd: MON, openHm: '1000', closeHm: '1700', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
]

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

function setupMocks(staff: any[] = [], offRulesPayload: any = {}) {
  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { teams: [{ id: 1, name: '1팀', doctors: [{ staffId: DOC, staffName: '홍담당' }] }] },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: {
        site: siteRows, holidayHours: null,
        recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false,
        ...offRulesPayload,
      },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff, overrides: [] } } })
  mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
}

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** 저장 payload 의 그 담당자 staff 행 — 고친 것이 없으면 저장이 안 나가므로 undefined 로 본다. */
function savedStaffRow() {
  const call = mocks.saveTreatmentSettings.mock.calls[0]
  return call?.[0]?.workingHours?.staff?.find((m: any) => m.staffId === DOC)
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  const staff = useStaffStore()
  staff.doctors.push({ id: `${DOC}`, text: '홍담당', staffId: DOC } as any)
  setupMocks()
})

describe('컨트롤은 선택된 대상 하나에만 붙는다', () => {
  it('처음에는 사업장 아래에만 있다', async () => {
    const wrapper = await mountSetting()

    expect(wrapper.findAll('.schedulerTreatmentSetting__offPanel')).toHaveLength(1)
    expect(wrapper.find('.schedulerTreatmentSetting__section').find('.schedulerTreatmentSetting__offPanel').exists()).toBe(true)
  })

  it('★담당자를 고르면 사업장 패널이 닫히고 그 팀 아래 하나만 남는다', async () => {
    const wrapper = await mountSetting()

    await wrapper.find('.schedulerTreatmentSetting__chip--selectable').trigger('click')

    const panels = wrapper.findAll('.schedulerTreatmentSetting__offPanel')
    expect(panels, '패널은 언제나 하나뿐이다').toHaveLength(1)
    expect(wrapper.vm.$.setupState.selectedOffOwner).toBe(OWNER)
  })
})

describe('담당자 반복 휴무 — 매주는 운영시간 표가, 매월은 신규 상태가 갖는다', () => {
  it('★매주 휴무를 켜면 그 요일 운영시간 entry 가 빈 배열이 된다 (운영시간 탭이 그 요일을 잠근다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.selectOffOwner(OWNER)

    state.toggleOptionFor(OWNER, WED, 'WEEKLY')

    expect(state.workingHoursByOwner.get(OWNER).get(WED)).toEqual([])
    expect(state.isWeekdayClosed(WED, OWNER), '운영시간 탭에서 그 요일이 잠긴다').toBe(true)
    expect(state.staffMonthlyOffs.get(OWNER), '매주는 매월 상태를 만들지 않는다').toBeUndefined()
  })

  it('매주를 끄면 미설정으로 돌아간다 — 휴무가 아니라 사업장 값을 다시 따른다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, WED, 'WEEKLY')
    state.toggleOptionFor(OWNER, WED, 'WEEKLY')

    expect(state.workingHoursByOwner.get(OWNER).has(WED)).toBe(false)
    expect(state.isWeekdayClosed(WED, OWNER)).toBe(false)
  })

  it('매월 N번째는 여러 개 고를 수 있고, 매주를 켜면 함께 비워진다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, MON, 'MONTHLY_1')
    state.toggleOptionFor(OWNER, MON, 'MONTHLY_3')
    expect([...state.staffMonthlyOffs.get(OWNER).get(MON)]).toEqual(['MONTHLY_1', 'MONTHLY_3'])

    state.toggleOptionFor(OWNER, MON, 'WEEKLY')
    expect(state.staffMonthlyOffs.get(OWNER), '매주와 매월은 배타다').toBeUndefined()
  })

  it('매주가 켜져 있으면 매월은 고를 수 없다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, MON, 'WEEKLY')
    state.toggleOptionFor(OWNER, MON, 'MONTHLY_2')

    expect(state.staffMonthlyOffs.get(OWNER)).toBeUndefined()
  })

  it('칩은 매주·매월을 한 목록으로 보여준다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, WED, 'WEEKLY')
    state.toggleOptionFor(OWNER, MON, 'MONTHLY_3')

    expect(state.recurringChipsFor(OWNER).map((c: any) => c.label))
      .toEqual(['매월 3번째 월요일', '매주 수요일'])
  })
})

describe('공휴일 — 체크박스 1개, 미설정은 사업장 값을 상속해 표시한다', () => {
  it('★한 번도 만지지 않으면 사업장 체크 상태를 그대로 보여준다', async () => {
    setupMocks([], { holidayClosedYn: true })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.holidayOffFor(OWNER), '상속 표시').toBe(true)
    expect(state.staffHolidayOff.get(OWNER), '표시일 뿐 값이 생기지는 않는다').toBeUndefined()
  })

  it('만지는 순간 Y/N 으로 확정된다', async () => {
    setupMocks([], { holidayClosedYn: true })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setHolidayOffFor(OWNER, false)
    expect(state.staffHolidayOff.get(OWNER)).toBe('Y')

    state.setHolidayOffFor(OWNER, true)
    expect(state.staffHolidayOff.get(OWNER)).toBe('N')
  })

  it('사업장이 공휴일에 운영해도 담당자만 휴무로 정할 수 있다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.setHolidayOffFor(OWNER, true)

    expect(state.isDisplayedOffFor('INSTITUTION', dayjs(HOLIDAY))).toBe(false)
    expect(state.isDisplayedOffFor(OWNER, dayjs(HOLIDAY))).toBe(true)
  })
})

describe('우측 뷰어 — 선택한 대상으로 판정하고 미설정은 사업장을 상속한다', () => {
  it('★정하지 않은 날은 사업장 판정을 그대로 따른다', async () => {
    setupMocks([], { offDates: [MON_1ST] })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_1ST)), '기관 휴무일을 상속').toBe(true)
    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_3RD))).toBe(false)
  })

  it('매월 N번째 규칙은 그 날짜만 휴무로 만든다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, MON, 'MONTHLY_3')

    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_3RD))).toBe(true)
    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_1ST))).toBe(false)
  })

  /* S3 에서 확정된 판정이다(offDayRules §4-2 3단계): 담당자가 그 요일 운영시간을 갖고 있으면
   *   '운영으로 정한 것'으로 보아 상속 단계로 내려가지 않는다. 그래서 사업장이 임시휴무로
   *   지정한 날에도 그 담당자는 운영으로 표시된다.
   *   ✅R11 확정(2026-08-20) — **사업장이 휴무가어도 담당자가 휴무가 아니면 담당자를 따른다.**
   *   운영시간 탭 잠금(isWeekdayClosed)과 보드(useSchedulerRules)도 이 규칙으로 맞췄다. 셋이 같은 답을 낸다. */
  it('담당자가 그 요일 운영시간을 갖고 있으면 사업장 임시휴무를 상속하지 않는다 (S3 판정)', async () => {
    setupMocks(
      [{
        staffId : DOC,
        staffName         : '홍담당',
        times          : [{ dayCd: MON, staffOpenHm: '1300', staffCloseHm: '1900' }],
        monthlyOffRules: [],
        holidayOpenYn     : null,
      }],
      { offDates: [MON_1ST] },
    )
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.isDisplayedOffFor('INSTITUTION', dayjs(MON_1ST))).toBe(true)
    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_1ST))).toBe(false)
  })

  /* R11 — 운영시간 탭 잠금도 같은 규칙을 쓴다. 종전에는 사업장 매주 휴무를 전 담당자에게
   * 무조건 상속시켜, 같은 요일이 이 탭에선 "휴무(잠김)" · 휴무일 탭 뷰어에선 "운영"로 갈렸다. */
  it('★사업장 매주 휴무 요일이어도 그 담당자가 운영시간을 정해 뒀으면 잠기지 않는다 (R11)', async () => {
    setupMocks(
      [{
        staffId : DOC,
        staffName         : '홍담당',
        times          : [{ dayCd: MON, staffOpenHm: '1300', staffCloseHm: '1900' }],
        monthlyOffRules: [],
        holidayOpenYn     : null,
      }],
      { recurringOffRules: [{ dayCd: MON, repeatTy: 'WEEKLY', monthlyNth: null }] },
    )
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.isWeekdayClosed(MON), '사업장 자신은 그 요일 휴무가다').toBe(true)
    expect(state.isWeekdayClosed(MON, OWNER), '담당자는 운영으로 정했으므로 잠기지 않는다').toBe(false)
  })

  it('사업장 매주 휴무 요일에 담당자가 미설정이면 그대로 상속해 잠근다', async () => {
    setupMocks(
      [{ staffId: DOC, staffName: '홍담당', times: [], monthlyOffRules: [], holidayOpenYn: null }],
      { recurringOffRules: [{ dayCd: MON, repeatTy: 'WEEKLY', monthlyNth: null }] },
    )
    const wrapper = await mountSetting()

    expect(wrapper.vm.$.setupState.isWeekdayClosed(MON, OWNER)).toBe(true)
  })

  /* 제보(2026-09-02): 목요일만 쉬기로 한 담당자의 운영시간 표에 사업장 휴무요일(일·금)까지
   * '휴무'으로 잠겨 있었다. 상속은 항목이 아니라 **축 단위**다 — 요일 축을 스스로 정하기 시작하면
   * 사업장 요일 규칙은 더는 따라가지 않는다. 같은 화면의 월 캘린더는 이미 그렇게 그리고 있어
   * 한 화면 안에서 좌측 표와 우측 달력이 갈렸다. */
  it('★자기 매주 휴무를 정한 담당자는 사업장 휴무요일을 더는 상속하지 않는다 (축 단위)', async () => {
    setupMocks(
      [{
        staffId : DOC,
        staffName         : '홍담당',
        times          : [{ dayCd: THU, staffOpenHm: null, staffCloseHm: null }],   // 목요일 매주 휴무
        monthlyOffRules: [],
        holidayOpenYn     : null,
      }],
      {
        recurringOffRules: [
          { dayCd: SUN, repeatTy: 'WEEKLY', monthlyNth: null },
          { dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null },
        ],
      },
    )
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.isWeekdayClosed(THU, OWNER), '자기가 정한 휴무요일').toBe(true)
    expect(state.isWeekdayClosed(SUN, OWNER), '사업장 휴무요일은 상속하지 않는다').toBe(false)
    expect(state.isWeekdayClosed(FRI, OWNER), '사업장 휴무요일은 상속하지 않는다').toBe(false)
    expect(state.isWeekdayClosed(SUN), '사업장 자신은 그대로 휴무가다').toBe(true)
    /* 우측 월 캘린더와 같은 답이어야 한다 — 2026-08-07 은 금요일 */
    expect(state.isDisplayedOffFor(OWNER, dayjs('2026-08-07')), '달력도 그 금요일을 운영으로 그린다').toBe(false)
  })

  it('매월 N번째 휴무만 정한 담당자도 사업장 휴무요일에서 벗어난다', async () => {
    setupMocks(
      [{
        staffId : DOC,
        staffName         : '홍담당',
        times          : [],
        monthlyOffRules: [{ dayCd: WED, monthlyNth: 3 }],
        holidayOpenYn     : null,
      }],
      { recurringOffRules: [{ dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null }] },
    )
    const wrapper = await mountSetting()

    expect(wrapper.vm.$.setupState.isWeekdayClosed(FRI, OWNER)).toBe(false)
  })

  it('12개월 뷰어가 선택 대상을 따라간다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.toggleOptionFor(OWNER, MON, 'MONTHLY_3')

    const cellOf = (key: string) => state.yearMonths
      .flatMap((m: any) => m.cells)
      .find((c: any) => c.key === key && c.isCurrentMonth)

    expect(cellOf(MON_3RD).isOff, '사업장 선택 중에는 기관 규칙만 그린다').toBe(false)

    state.selectOffOwner(OWNER)
    await wrapper.vm.$nextTick()

    expect(cellOf(MON_3RD).isOff).toBe(true)
  })
})

describe('달력 드래그 — 담당자 일자 지정은 운영시간 override 로 담긴다', () => {
  it('휴무로 지정하면 빈 blocks 가 된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleRangeOffFor(OWNER, MON_3RD, MON_3RD)

    expect(state.workingHoursOverridesByOwner.get(OWNER).get(MON_3RD)).toEqual([])
    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_3RD))).toBe(true)
  })

  it('★운영으로 뒤집으면 운영시간이 채워진다 — 빈 지정은 휴무와 구분되지 않는다', async () => {
    setupMocks([], { offDates: [MON_1ST] })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleRangeOffFor(OWNER, MON_1ST, MON_1ST)

    expect(state.workingHoursOverridesByOwner.get(OWNER).get(MON_1ST), '사업장의 그 요일 운영시간을 끌어온다')
      .toEqual([{ kind: 'WORK', start: '10:00', end: '17:00' }])
    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_1ST))).toBe(false)
  })

  it('채울 값은 담당자 자신의 그 요일 운영시간이 먼저다', async () => {
    /* 공휴일 휴무 상태에서 운영으로 뒤집는다 —
     * 담당자가 그 요일(토) 운영시간을 갖고 있으므로 그 값이 채워져야 한다.
     * ★공휴일 휴무는 담당자 자신의 값('N')으로 만든다 — 사업장 공휴일 휴무는 상속되지 않는다(§4-2). */
    setupMocks(
      [{
        staffId : DOC,
        staffName         : '홍담당',
        times          : [{ dayCd: SAT, staffOpenHm: '1300', staffCloseHm: '1900' }],
        monthlyOffRules: [],
        holidayOpenYn     : 'N',
      }],
      { holidayClosedYn: true },
    )
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.isDisplayedOffFor(OWNER, dayjs(HOLIDAY)), '공휴일 휴무를 상속한 상태').toBe(true)
    state.toggleRangeOffFor(OWNER, HOLIDAY, HOLIDAY)

    expect(state.workingHoursOverridesByOwner.get(OWNER).get(HOLIDAY))
      .toEqual([{ kind: 'WORK', start: '13:00', end: '19:00' }])
  })

  it('그 요일 운영시간이 아무 데도 없으면 기본값 09:00~18:00 을 넣는다', async () => {
    setupMocks([], { offDates: [HOLIDAY] })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleRangeOffFor(OWNER, HOLIDAY, HOLIDAY)

    expect(state.workingHoursOverridesByOwner.get(OWNER).get(HOLIDAY))
      .toEqual([{ kind: 'WORK', start: '09:00', end: '18:00' }])
  })

  it('★되돌려도 지정은 남는다 — 자연 상태와 같아도 누른 날은 자기 값이다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleRangeOffFor(OWNER, MON_3RD, MON_3RD)   // 휴무 지정
    state.toggleRangeOffFor(OWNER, MON_3RD, MON_3RD)   // 되돌리기

    /* 종전에는 자연 상태와 같아지면 지정을 지웠다. 일자 축 상속이 축 단위가 되면서 지울 수 없다 —
     * 지정을 만들지 않고 넘어간 날만 사업장 지정으로 되살아나 같은 드래그의 결과가 갈린다.
     * 지우는 조작은 칩의 × 하나로 둔다. */
    expect(state.workingHoursOverridesByOwner.get(OWNER).has(MON_3RD), '지정이 남는다').toBe(true)
    expect(state.isDisplayedOffFor(OWNER, dayjs(MON_3RD)), '운영으로 되돌아간다').toBe(false)
  })
})

describe('저장 payload — 신규 두 필드가 staff[] 에 실린다', () => {
  it('★운영시간을 한 번도 정하지 않은 담당자도 매월 휴무만으로 실린다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, MON, 'MONTHLY_3')
    state.toggleOptionFor(OWNER, SUN, 'MONTHLY_1')
    await state.onSave()

    expect(savedStaffRow().monthlyOffRules, '요일·차수 오름차순으로 고정한다')
      .toEqual([{ dayCd: SUN, monthlyNth: 1 }, { dayCd: MON, monthlyNth: 3 }])
    expect(savedStaffRow().times).toEqual([])
  })

  it('미설정 공휴일은 null 로 나간다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.toggleOptionFor(OWNER, MON, 'MONTHLY_3')
    await state.onSave()

    expect(savedStaffRow().holidayOpenYn).toBeNull()
  })

  it('공휴일만 고쳐도 저장이 나간다 (dirty 판정에 신규 상태가 들어 있다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setHolidayOffFor(OWNER, true)
    await state.onSave()

    expect(mocks.saveTreatmentSettings).toHaveBeenCalled()
    expect(savedStaffRow().holidayOpenYn).toBe('N')
  })
})

describe('조회 — 서버 값이 그대로 컨트롤 상태가 된다', () => {
  it('monthlyOffRules · holidayOpenYn 이 되접혀 들어온다', async () => {
    setupMocks([
      {
        staffId : DOC,
        staffName         : '홍담당',
        times          : [],
        monthlyOffRules: [{ dayCd: MON, monthlyNth: 3 }, { dayCd: MON, monthlyNth: 1 }],
        holidayOpenYn     : 'N',
      },
    ])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect([...state.staffMonthlyOffs.get(OWNER).get(MON)].sort())
      .toEqual(['MONTHLY_1', 'MONTHLY_3'])
    expect(state.staffHolidayOff.get(OWNER)).toBe('N')
    expect(state.holidayOffFor(OWNER)).toBe(true)
  })

  it('조회 직후에는 변경이 없다 — baseline 이 신규 필드까지 포함한다', async () => {
    setupMocks([
      {
        staffId : DOC,
        staffName         : '홍담당',
        times          : [],
        monthlyOffRules: [{ dayCd: MON, monthlyNth: 3 }],
        holidayOpenYn     : 'Y',
      },
    ])
    const wrapper = await mountSetting()

    expect(wrapper.vm.$.setupState.isDirty()).toBe(false)
  })
})


/* '매주'와 '매월 1~5번째 전부'는 같은 결과(쉬지 않는 주가 없다)라 화면이 같게 말해야 한다 — 사업장 축은
 * 표기·잠금·저장(운영행 제외)이 함께 가는 것을 dayState 테스트가 고정했다. 담당자 축은 잠금까지만 고정돼 있어
 * 저장 표현을 여기서 잰다. 담당자의 "휴무"은 행 제외가 아니라 null 행이다(제외 = 미설정 = 기관 상속). */
describe('담당자 — 매월 1~5번째 전부인 요일의 저장 표현', () => {
  const wedTimes = [{ dayCd: WED, staffOpenHm: '0900', staffCloseHm: '1300' }]
  const staffWithWed = () => [{ staffId: DOC, staffName: '홍담당', times: wedTimes, monthlyOffRules: [], holidayOpenYn: null }]

  // 기대값 출처: 잠금·규칙 5행은 isEveryWeekOff 정책(offDayRules) — 고른 대로 저장, 매주로 바꿔 쓰지 않는다.
  it('운영시간이 있는 요일에 다섯 개를 전부 걸면 잠기고, 규칙은 다섯 행 그대로 나간다', async () => {
    setupMocks(staffWithWed())
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    for (const n of [1, 2, 3, 4, 5]) state.toggleOptionFor(OWNER, WED, `MONTHLY_${n}`)
    expect(state.isWeekdayClosed(WED, OWNER), '다섯 개 전부 = 매주 잠금').toBe(true)
    await state.onSave()

    expect(savedStaffRow().monthlyOffRules)
      .toEqual([1, 2, 3, 4, 5].map(monthlyNth => ({ dayCd: WED, monthlyNth })))
  })

  // 기대값 출처: 정책 결정(2026-09-07) — 매주 휴무는 그 요일 운영행을 null 로, 매월 N번째 휴무는 다섯 개를
  // 전부 골랐어도 운영행을 그대로 보낸다. 잠금·표기는 같지만 저장 표현은 다른 것이 맞다: 매월 규칙은
  // 운영시간 위에 얹힌 휴무라 규칙을 풀면 시간이 그대로 살아나야 하고, 매주는 그 요일 자체를 비운 것이다.
  it('운영행은 시간을 실은 채 나간다 — 매주 경로(null 행)와 다르게 두는 것이 규칙이다', async () => {
    setupMocks(staffWithWed())
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    for (const n of [1, 2, 3, 4, 5]) state.toggleOptionFor(OWNER, WED, `MONTHLY_${n}`)
    await state.onSave()
    expect(savedStaffRow().times).toEqual([{ dayCd: WED, staffOpenHm: '0900', staffCloseHm: '1300' }])

    // 대조군 — 같은 픽스처에서 매주를 켜면 null 행
    vi.clearAllMocks()
    setupMocks(staffWithWed())
    const w2 = await mountSetting()
    w2.vm.$.setupState.toggleOptionFor(OWNER, WED, 'WEEKLY')
    await w2.vm.$.setupState.onSave()
    expect(savedStaffRow().times).toEqual([{ dayCd: WED, staffOpenHm: null, staffCloseHm: null }])
  })
})
