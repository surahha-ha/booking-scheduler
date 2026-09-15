/**
 * @vitest-environment happy-dom
 *
 * 빌려온 운영시간의 표기 구분 (2026-08-28).
 *
 * 담당자가 그 요일을 정하지 않았으면 화면은 사업장 운영시간을 참조해 그린다. 그런데 그 값이
 * 자기 값과 똑같이 생겨서, 사업장 운영시간을 지웠을 때 표기가 함께 사라지는 것을
 * "담당자 운영시간이 삭제됐다"고 읽는 오해가 났다.
 *
 * 이 파일이 지키는 두 가지:
 *  1. 빌린 값과 자기 값은 화면에서 갈린다 (showsInheritedStaffTime · entry.isInherited)
 *  2. 사업장 운영시간을 지워도 **자기 값을 가진 담당자의 행은 저장 payload 에 그대로 남는다**
 *     — 상속은 표기 규약일 뿐 삭제 경로가 아니다
 *
 * ★빌린 값을 담당자 행으로 확정 저장하지 않는 이유는 dayMapToTimes 주석에 있다(원천 이원성:
 *  사업장 = 사업장 설정 사업장 운영시간 테이블 / 담당자 = 자체 담당자 운영시간 테이블).
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
import { useStaffStore } from '@/stores/staffStore'

const MON = 1, TUE = 2
const DOC = 11

/* 2026-08-03 = 월요일 */
const MON_DATE = '2026-08-03'

/* 사업장 — 월 10:00~17:00. ★기본값(09:00~18:00)과 일부러 다르게 둔다:
 * 같으면 "기관에서 빌려왔는지"와 "기본값으로 때웠는지"가 구분되지 않는다. */
const INSTITUTION_MON = {
  dayCd: MON, openHm: '1000', closeHm: '1700',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}

const UNSET_STAFF = { staffId: DOC, staffName: '홍담당', times: [], monthlyOffRules: [], holidayOpenYn: 'Y' }

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

function setupMocks(siteRows: any[], staff: any[] = []) {
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

/** 저장 payload 의 그 담당자 행 */
function savedStaffRow() {
  const call = mocks.saveTreatmentSettings.mock.calls[0]
  return call?.[0]?.workingHours?.staff?.find((m: any) => m.staffId === DOC)
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  // 셀 entry 는 이름을 staffStore.doctors 에서 찾는다 — 없으면 그 줄이 렌더되지 않는다
  useStaffStore().doctors.push({ id: `${DOC}`, text: '홍담당', staffId: DOC } as any)
})

describe('빌려온 시각과 자기 시각은 화면에서 갈린다', () => {
  it('★미설정 담당자의 7행 표 시각은 기관 값이고, 빌려온 것으로 표시된다', async () => {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.fetchStaffWorkHours(DOC, MON, 'start'), '기관 값을 빌려 그린다').toBe('10:00')
    expect(state.showsInheritedStaffTime(DOC, MON), '빌려온 값으로 표시').toBe(true)
  })

  it('그 요일을 고치면 자기 값으로 확정돼 빌림 표시가 꺼진다', async () => {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(DOC, MON, 'start', '09:00')
    await wrapper.vm.$nextTick()

    expect(state.showsInheritedStaffTime(DOC, MON), '건드린 요일은 자기 값').toBe(false)
  })

  /* 2026-09-02 규약 변경 — 기관도 그 요일을 정하지 않았으면 **보드·타임라인이 여는 기본 운영시간**을
   * 빌린다(종전에는 빈칸 + 빌림 표시 없음). 빌린 값이라는 점은 그대로라 흐림 표기는 켜진다. */
  it('★기관도 그 요일을 모르면 보드가 여는 기본 운영시간을 빌린다 — 빌림 표시도 켜진다', async () => {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.fetchStaffWorkHours(DOC, TUE, 'start'), '화요일은 기관 값이 없어 기본값을 빌린다').toBe('09:00')
    expect(state.fetchStaffWorkHours(DOC, TUE, 'end')).toBe('18:00')
    expect(state.showsInheritedStaffTime(DOC, TUE)).toBe(true)
  })

  /* 좌측 표와 우측 달력이 같은 폴백을 써야 한 화면 안에서 답이 갈리지 않는다. */
  it('★달력 셀도 같은 폴백 — 기관이 그 요일을 모르면 기본 운영시간을 빌린 줄로 그린다', async () => {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const TUE_DATE = '2026-08-04'   // 화요일 — 사업장 값이 없는 요일
    const entries = state.formatListEntries([DOC], dayjs(TUE_DATE), TUE_DATE)
    expect(entries[0].label).toBe('홍담당 09:00 ~ 18:00')
    expect(entries[0].isInherited, '기관이 아니라 기본값이어도 빌린 줄이다').toBe(true)
    expect(entries[0].isOwn, '빌린 줄은 굵게 그리지 않는다').toBeUndefined()
  })

  it('달력 셀 줄도 같은 규약으로 갈린다 — 빌린 줄만 isInherited', async () => {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const borrowed = state.formatListEntries([DOC], dayjs(MON_DATE), MON_DATE)
    expect(borrowed[0].label).toBe('홍담당 10:00 ~ 17:00')
    expect(borrowed[0].isInherited, '기관에서 빌린 줄').toBe(true)
    expect(borrowed[0].isOwn, '빌린 줄은 굵게 그리지 않는다').toBeUndefined()

    state.setStaffWorkHours(DOC, MON, 'start', '09:00')
    state.setStaffWorkHours(DOC, MON, 'end', '13:00')
    await wrapper.vm.$nextTick()

    const own = state.formatListEntries([DOC], dayjs(MON_DATE), MON_DATE)
    expect(own[0].label).toBe('홍담당 09:00 ~ 13:00')
    expect(own[0].isInherited, '자기 값 줄은 빌린 것이 아니다').toBeUndefined()
    expect(own[0].isOwn, '저장된 값은 굵게 그린다').toBe(true)
  })

  it('저장된 시간이 있는 줄만 굵어진다 — 휴무 줄은 아니다', async () => {
    setupMocks([INSTITUTION_MON], [{
      staffId : DOC, staffName: '홍담당',
      times          : [{ dayCd: MON, staffOpenHm: null, staffCloseHm: null }],  // 명시적 휴무
      monthlyOffRules: [], holidayOpenYn: 'Y',
    }])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const entry = state.formatListEntries([DOC], dayjs(MON_DATE), MON_DATE)[0]
    expect(entry.time).toBe('(휴무)')
    expect(entry.isOwn, '휴무는 시간이 아니라 굵게 그리지 않는다').toBeUndefined()
  })
})

describe('달력 범례 — 색·굵기의 뜻을 화면이 밝힌다', () => {
  /** ★기본 탭은 'OFF'(휴무일)다 — 월 달력을 보려면 운영시간 탭으로 옮겨야 한다. */
  async function openMonthCalendar() {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    wrapper.vm.$.setupState.activeLeftTab = 'WORKING_HOURS'
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('월 달력에는 두 줄짜리 범례가 붙는다 — 셀의 색이 무엇을 뜻하는지 밝힌다', async () => {
    const wrapper = await openMonthCalendar()

    const items = wrapper.findAll('.schedulerTreatmentSetting__legendItem')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toBe('특정일자 운영')
    expect(items[0].classes()).toContain('is-designated')
    expect(items[1].text()).toBe('요일별 운영시간')
    expect(items[1].classes()).toContain('is-own')
  })

  it('휴무일 탭(12개월 미니 캘린더)으로 옮기면 사라진다 — 그 표기가 없는 화면이다', async () => {
    const wrapper = await openMonthCalendar()
    expect(wrapper.findAll('.schedulerTreatmentSetting__legendItem')).toHaveLength(2)

    wrapper.vm.$.setupState.activeLeftTab = 'OFF'
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.schedulerTreatmentSetting__legendItem')).toHaveLength(0)
  })
})

describe('★사업장 운영시간을 지워도 담당자 자기 행은 삭제되지 않는다', () => {
  it('자기 값을 가진 담당자의 행은 기관 요일을 비운 뒤에도 payload 에 그대로 나간다', async () => {
    setupMocks([INSTITUTION_MON], [{
      staffId : DOC, staffName: '홍담당',
      times          : [{ dayCd: MON, staffOpenHm: '0900', staffCloseHm: '1300' }],
      monthlyOffRules: [], holidayOpenYn: 'Y',
    }])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.showsInheritedStaffTime(DOC, MON), '자기 값이 있으니 빌린 것이 아니다').toBe(false)

    // 사업장 월요일 운영시간을 지운다 (마이페이지에서 지운 것과 같은 상태)
    state.institutionWeeklyDayMap = new Map()
    await wrapper.vm.$nextTick()

    expect(state.fetchStaffWorkHours(DOC, MON, 'start'), '담당자 자기 값은 그대로 보인다').toBe('09:00')

    await state.onSave()
    await flushPromises()

    const row = savedStaffRow()
    expect(row, '그 담당자 행이 저장에서 빠지지 않는다').toBeTruthy()
    expect(row.times).toEqual([{ dayCd: MON, staffOpenHm: '0900', staffCloseHm: '1300' }])
  })

  it('미설정 담당자는 건드린 요일만 저장된다 — 기관 값 7행 박제 금지', async () => {
    setupMocks([INSTITUTION_MON], [UNSET_STAFF])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(DOC, TUE, 'start', '14:00')
    state.setStaffWorkHours(DOC, TUE, 'end', '18:00')
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    const row = savedStaffRow()
    expect(row.times.map((t: any) => t.dayCd), '건드린 요일만 나간다').toEqual([TUE])
  })
})
