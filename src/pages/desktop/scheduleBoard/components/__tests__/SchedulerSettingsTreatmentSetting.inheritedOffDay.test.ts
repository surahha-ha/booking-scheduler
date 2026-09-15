/**
 * @vitest-environment happy-dom
 *
 * 휴무일 탭 — 사업장 휴무의 상속을 컨트롤에도 보여준다 (2026-08-28).
 *
 * 제보: 운영시간 탭은 미설정 담당자에게 사업장 휴무를 상속해 '휴무'으로 찍는데,
 * 휴무일 탭의 요일별 버튼에는 아무것도 체크되지 않아 두 탭이 어긋나 보였다.
 * 우측 달력은 상속을 그리고 있어서 "체크한 적 없는 날이 휴무로 칠해져 있다"가 된다.
 *
 * 그래서 요일·특정일자 컨트롤도 정하지 않은 것은 사업장 것을 상속해 보여준다.
 *
 * 상속은 **축 단위**다(2026-08-28 확정). 요일 축·일자 축 각각, 스스로 하나라도 정하면 그 축은
 * 더는 사업장을 따라가지 않는다. 그래서 상속으로 켜져 보이는 것을 누르면 언제나 "켜기"이고,
 * 그 순간 자기 값이 되면서 같은 축의 나머지 상속 표기가 사라진다. 자기 값을 전부 지우면 다시 상속이다.
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

import dayjs from 'dayjs'
import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'

const MON = 1, FRI = 5
const DOC = 11
const OWNER = `STAFF:${DOC}`

/* 2026년 8월 — 금요일: 7·14·21·28 (1~4번째) */
const FRI_1ST = '2026-08-07'
const FRI_3RD = '2026-08-21'

/* 사업장 — 월 10:00~17:00 만 등록. 금요일은 운영시간이 없다(매주 휴무가므로).
 * ★기본값(09:00~18:00)과 일부러 다르게 둔다 — 어느 쪽을 끌어왔는지 구분하기 위해서다. */
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
      payload: { teams: [{ id: 1, name: '1진료팀', doctors: [{ staffId: DOC, staffName: '홍의사' }] }] },
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

/** 그 담당자 행만 있는 staff 응답 한 건 */
function staffRow(times: any[] = [], monthlyOffRules: any[] = []) {
  return { staffId: DOC, staffName: '홍의사', times, monthlyOffRules, holidayOpenYn: 'N' }
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
})

describe('요일별 — 사업장 매주 휴무의 상속', () => {
  it('★정하지 않은 요일은 사업장 매주 휴무가 체크로 보인다', async () => {
    setupMocks([staffRow()], { recurringOffRules: [{ dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null }] })
    const state = (await mountSetting()).vm.$.setupState

    expect([...state.offOptionsFor(OWNER, FRI)], '기관 금요일 휴무를 상속').toContain('WEEKLY')
  })

  it('★운영시간 탭의 휴무 표기와 답이 같다 — 두 탭이 어긋나지 않는다', async () => {
    setupMocks([staffRow()], { recurringOffRules: [{ dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null }] })
    const state = (await mountSetting()).vm.$.setupState

    for (const wd of [MON, FRI]) {
      expect(state.offOptionsFor(OWNER, wd).has('WEEKLY'), `요일 ${wd}`)
        .toBe(state.isWeekdayClosed(wd, OWNER))
    }
  })

  it('자기 값을 정해 뒀으면 상속하지 않는다 — 진료로 정한 요일은 체크가 없다', async () => {
    setupMocks(
      [staffRow([{ dayCd: FRI, staffOpenHm: '1300', staffCloseHm: '1900' }])],
      { recurringOffRules: [{ dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null }] },
    )
    const state = (await mountSetting()).vm.$.setupState

    expect(state.offOptionsFor(OWNER, FRI).has('WEEKLY')).toBe(false)
  })

  it('매월 N번째 휴무도 상속해 보여준다 — 표시만이라 칩에 × 가 없다', async () => {
    setupMocks([staffRow()], { recurringOffRules: [{ dayCd: FRI, repeatTy: 'MONTHLY', monthlyNth: 2 }] })
    const state = (await mountSetting()).vm.$.setupState

    expect([...state.offOptionsFor(OWNER, FRI)]).toContain('MONTHLY_2')

    const chip = state.recurringChipsFor(OWNER).find((c: any) => c.option === 'MONTHLY_2')
    expect(chip.locked, '상속된 매월 규칙은 잠긴다').toBe(true)

    // 눌러도 상태가 바뀌지 않는다 — 담을 자리가 없어 표시만 하기로 한 사양(§4-5-7)
    state.toggleStaffOption(OWNER, FRI, 'MONTHLY_2')
    expect([...state.offOptionsFor(OWNER, FRI)]).toContain('MONTHLY_2')
  })

  it('★상속으로 켜진 체크를 누르면 그 요일이 자기 값이 되고, 같은 축의 나머지 상속 표기가 사라진다', async () => {
    setupMocks([staffRow()], { recurringOffRules: [
      { dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null },
      { dayCd: MON, repeatTy: 'WEEKLY', monthlyNth: null },
    ] })
    const state = (await mountSetting()).vm.$.setupState

    expect(state.offOptionsFor(OWNER, MON).has('WEEKLY'), '누르기 전에는 둘 다 상속으로 보인다').toBe(true)

    // 사용자가 드롭다운·칩에서 실제로 부르는 경로
    state.toggleStaffOption(OWNER, FRI, 'WEEKLY')

    expect(state.offOptionsFor(OWNER, FRI).has('WEEKLY'), '누른 요일은 자기 휴무가 된다').toBe(true)
    expect(state.isInheritedOffWeekday(OWNER, FRI), '더는 상속이 아니다').toBe(false)
    expect(state.offOptionsFor(OWNER, MON), '요일 축 상속이 끊겨 나머지 표기가 사라진다')
      .not.toContain('WEEKLY')
  })

  it('★자기 값을 전부 지우면 그 축은 다시 사업장을 따라간다', async () => {
    setupMocks([staffRow()], { recurringOffRules: [
      { dayCd: FRI, repeatTy: 'WEEKLY', monthlyNth: null },
      { dayCd: MON, repeatTy: 'WEEKLY', monthlyNth: null },
    ] })
    const state = (await mountSetting()).vm.$.setupState

    state.toggleStaffOption(OWNER, FRI, 'WEEKLY')   // 자기 값이 생긴다
    state.setStaffWeekdayOff(OWNER, FRI, false)     // 그 하나를 지운다

    expect(state.workingHoursByOwner.get(OWNER).has(FRI), '행이 사라진다 = 미설정').toBe(false)
    for (const wd of [MON, FRI]) {
      expect(state.isInheritedOffWeekday(OWNER, wd), `요일 ${wd} 는 다시 상속`).toBe(true)
      expect(state.offOptionsFor(OWNER, wd).has('WEEKLY'), `요일 ${wd} 표기가 돌아온다`).toBe(true)
    }
  })

  it('사업장이 쉬지 않는 요일에서 끄면 종전대로 미설정으로 되돌아간다', async () => {
    setupMocks([staffRow([{ dayCd: MON, staffOpenHm: null, staffCloseHm: null }])])
    const state = (await mountSetting()).vm.$.setupState

    state.setStaffWeekdayOff(OWNER, MON, false)

    expect(state.workingHoursByOwner.get(OWNER).has(MON), '행이 사라진다 = 미설정').toBe(false)
    expect(state.offOptionsFor(OWNER, MON).has('WEEKLY')).toBe(false)
  })
})

describe('특정일자 — 사업장 일자 지정의 상속', () => {
  it('★정하지 않은 날짜는 사업장 지정이 칩으로 보인다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST] })
    const state = (await mountSetting()).vm.$.setupState

    expect(state.dateOverridesFor(OWNER).get(FRI_1ST)).toBe('OFF')
    expect(state.ownsDateOverride(OWNER, FRI_1ST), '자기 것은 아니다').toBe(false)
  })

  it('자기 지정이 사업장 지정을 덮는다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST] })
    const state = (await mountSetting()).vm.$.setupState

    state.toggleRangeOffFor(OWNER, FRI_1ST, FRI_1ST)   // 진료로 뒤집는다

    expect(state.dateOverridesFor(OWNER).get(FRI_1ST)).toBe('WORK')
    expect(state.ownsDateOverride(OWNER, FRI_1ST)).toBe(true)
  })

  it('★상속분 칩에는 × 가 없다 — 지울 것이 없어 눌러도 사라지지 않는다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST] })
    const state = (await mountSetting()).vm.$.setupState

    state.selectOffOwner(OWNER)
    const chip = state.specificDates.find((r: any) => r.startKey === FRI_1ST)
    expect(chip.locked, '상속분은 잠긴다').toBe(true)
  })

  it('자기 지정으로 뒤집으면 그 칩은 × 를 갖는다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST] })
    const state = (await mountSetting()).vm.$.setupState

    state.selectOffOwner(OWNER)
    state.toggleRangeOffFor(OWNER, FRI_1ST, FRI_1ST)   // 달력에서 진료로 뒤집는다

    expect(state.specificDates.find((r: any) => r.startKey === FRI_1ST).locked).toBe(false)
  })

  it('자기 지정을 지우면 종전대로 사업장으로 되돌아간다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST] })
    const state = (await mountSetting()).vm.$.setupState

    const d = dayjs(FRI_1ST)
    state.selectOffOwner(OWNER);
    state.toggleRangeOffFor(OWNER, FRI_1ST, FRI_1ST)   // 자기 지정(진료)을 만든다
    state.removeSpecificRange({ startDate: d, endDate: d })

    expect(state.ownsDateOverride(OWNER, FRI_1ST), '자기 지정이 사라진다').toBe(false)
    expect(state.dateOverridesFor(OWNER).get(FRI_1ST), '다시 기관 휴무를 상속').toBe('OFF')
  })

  it('★일자 지정을 하나라도 만들면 나머지 기관 지정은 더는 따라가지 않는다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST, FRI_3RD] })
    const state = (await mountSetting()).vm.$.setupState

    state.toggleRangeOffFor(OWNER, FRI_1ST, FRI_1ST)   // 첫 자기 지정

    expect(state.dateOverridesFor(OWNER).has(FRI_3RD), '일자 축 상속이 끊긴다').toBe(false)
    expect(state.isDisplayedOffFor(OWNER, dayjs(FRI_3RD)), '그 날은 휴무가 아니다').toBe(false)
  })

  it('★기관 임시휴무일을 가로질러 휴무로 끌면 그 날도 함께 휴무로 남는다', async () => {
    setupMocks([staffRow()], { offDates: [FRI_1ST] })
    const state = (await mountSetting()).vm.$.setupState

    /* 종전에는 FRI_1ST 만 "어차피 상속으로 휴무"이라며 지정을 만들지 않고 넘어갔고,
     * 같은 드래그가 앞뒤 날에 지정을 만들면서 일자 축이 넘어가 그 하루만 진료로 되살아났다. */
    state.toggleRangeOffFor(OWNER, '2026-08-06', '2026-08-08')

    for (const key of ['2026-08-06', FRI_1ST, '2026-08-08']) {
      expect(state.ownsDateOverride(OWNER, key), `${key} 자기 지정`).toBe(true)
      expect(state.isDisplayedOffFor(OWNER, dayjs(key)), `${key} 휴무`).toBe(true)
    }
  })
})
