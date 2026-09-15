/**
 * @vitest-environment happy-dom
 *
 * 일자 지정(특정일자 운영시간) — 화면정의서 OSP_MD_APB033 §6-2.
 *
 * 캘린더 셀의 직원 운영시간을 클릭하면 그 (직원, 날짜) 한정 지정을 편집한다. 이 파일이 지키는 것 셋:
 *
 *  1) 프리필 통일 — popover 입력칸의 기본값은 셀에 보이던 값과 같아야 한다.
 *     담당자의 그 요일이 미설정이면 사업장의 그 요일 운영시간이 들어온다.
 *     (예전에는 popover 만 raw dayMap 을 읽어, 셀엔 "김의사 09:00 ~ 18:00" 인데 열면 빈칸이었다.)
 *
 *  2) 열어보기만 하면 지정이 생기지 않는다 — 확인 버튼 없는 즉시반영 UX 라 바깥 클릭도 커밋이다.
 *     프리필과 값이 같으면 지정 없음을 유지한다. 지정이 생기면 그 날짜가 그 시각으로 굳어
 *     이후 요일값·기관값 변경을 따라오지 못한다.
 *
 *  3) 지정된 줄만 하이라이트 — 셀에서 요일 반복을 따르는 줄과 눈으로 갈려야 한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

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

const MON = 1, TUE = 2
const DOC = 11

/* 2026-08-17(월) · 2026-08-18(화) — 요일 고정 날짜를 써야 프리필 판정이 흔들리지 않는다 */
const MON_DATE = '2026-08-17'
const TUE_DATE = '2026-08-18'

/* 사업장 — 월 09:00~18:00 / 화 10:00~17:00 */
const siteRows = [
  { dayCd: MON, openHm: '0900', closeHm: '1800', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
  { dayCd: TUE, openHm: '1000', closeHm: '1700', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
]

/* 이 담당자는 **월요일 1건**만 등록돼 있다 — 화요일은 미설정(기관 값 상속) */
const staffMondayOnly = [
  { staffId: DOC, staffName: '홍의사', times: [{ dayCd: MON, staffOpenHm: '0900', staffCloseHm: '1300' }] },
]

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

function setupMocks(staff: any[], overrides: any[] = []) {
  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { teams: [{ id: 1, name: '1진료팀', doctors: [{ staffId: DOC, staffName: '홍의사' }] }] },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code: 'succeed',
      payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff, overrides } } })
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

/** 셀 클릭 대신 편집기를 직접 연다 — getBoundingClientRect 를 갖춘 최소 이벤트 */
function fakeClickEvent() {
  return {
    stopPropagation: () => {},
    currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0 }) },
  } as any
}

/** 저장 payload 의 overrides[] — 고친 것이 없으면 저장 자체가 나가지 않으므로 [] 로 본다. */
function savedOverrides() {
  const call = mocks.saveTreatmentSettings.mock.calls[0]
  return call ? call[0].workingHours.overrides : []
}

/** 내부 state 기준 그 (직원, 날짜) 지정 존재 여부 */
function hasDesignation(state: any, dateKey: string) {
  return state.workingHoursOverridesByOwner.get(`STAFF:${DOC}`)?.has(dateKey) === true
}

describe('일자 지정 popover — 프리필은 셀에 보이던 값과 같다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    setupMocks(staffMondayOnly)
  })

  it('★담당자 요일이 미설정이면 사업장의 그 요일 운영시간이 프리필된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, TUE_DATE, TUE)
    await wrapper.vm.$nextTick()

    expect(state.cellStaffEditor.draft.WORK).toEqual({ start: '10:00', end: '17:00' })
  })

  it('담당자 요일이 등록돼 있으면 그 담당자 값이 프리필된다 (기관 값이 아니다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, MON_DATE, MON)
    await wrapper.vm.$nextTick()

    expect(state.cellStaffEditor.draft.WORK).toEqual({ start: '09:00', end: '13:00' })
  })

  it('이미 지정된 날짜는 지정값이 프리필된다 (요일값보다 우선)', async () => {
    setupMocks(staffMondayOnly, [
      { staffId: DOC, date: TUE_DATE, overrideOpenHm: '1400', overrideCloseHm: '1900' },
    ])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, TUE_DATE, TUE)
    await wrapper.vm.$nextTick()

    expect(state.cellStaffEditor.draft.WORK).toEqual({ start: '14:00', end: '19:00' })
  })
})

describe('일자 지정 popover — 열어보기만 하면 지정이 생기지 않는다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    setupMocks(staffMondayOnly)
  })

  it('★미설정 요일에서 열었다 그대로 닫으면 지정이 만들어지지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, TUE_DATE, TUE)
    await wrapper.vm.$nextTick()
    state.commitCellStaffEditor()

    expect(hasDesignation(state, TUE_DATE), '열어보기만 한 날은 지정이 아니다').toBe(false)

    await state.onSave()
    expect(savedOverrides()).toEqual([])
  })

  it('등록된 요일에서 열었다 그대로 닫아도 지정이 만들어지지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, MON_DATE, MON)
    await wrapper.vm.$nextTick()
    state.commitCellStaffEditor()

    expect(hasDesignation(state, MON_DATE)).toBe(false)
  })

  it('값을 고쳤으면 지정으로 저장된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, TUE_DATE, TUE)
    await wrapper.vm.$nextTick()
    state.setCellStaffBlockTime('WORK', 'end', '12:00')
    state.commitCellStaffEditor()
    await state.onSave()

    expect(savedOverrides()).toEqual([
      { staffId: DOC, date: TUE_DATE, overrideOpenHm: '1000', overrideCloseHm: '1200' },
    ])
  })

  /**
   * ★2026-08-20 규약 변경 — 시간을 모두 비우는 것은 **그 날짜 지정 해제**다("그 날짜만 휴무"이 아니다).
   * 휴무는 휴무일 탭이 정한다(탭 책임 분리). 운영시간 탭이 휴무 지정까지 만들면
   * 휴무일 탭이 잠가 둔 날짜를 이쪽이 다시 여는 모순이 생긴다.
   * 지정을 지우면 그 날짜는 요일 규칙·사업장 값을 다시 따라간다.
   */
  it('★시간을 모두 비우면 그 날짜 지정이 해제된다 — 휴무 지정이 아니다', async () => {
    setupMocks(staffMondayOnly, [
      { staffId: DOC, date: TUE_DATE, overrideOpenHm: '1000', overrideCloseHm: '1700' },
    ])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, TUE_DATE, TUE)
    await wrapper.vm.$nextTick()
    state.setCellStaffBlockTime('WORK', 'start', '')
    state.setCellStaffBlockTime('WORK', 'end', '')
    state.commitCellStaffEditor()
    await state.onSave()

    expect(savedOverrides(), '지정이 남지 않는다').toEqual([])
  })

  it('이미 지정된 날은 값이 그대로여도 지정이 유지된다 (명시적으로 정해 둔 날)', async () => {
    setupMocks(staffMondayOnly, [
      { staffId: DOC, date: TUE_DATE, overrideOpenHm: '1000', overrideCloseHm: '1700' },
    ])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openCellStaffEditor(fakeClickEvent(), `STAFF:${DOC}`, TUE_DATE, TUE)
    await wrapper.vm.$nextTick()
    state.commitCellStaffEditor()

    expect(hasDesignation(state, TUE_DATE)).toBe(true)
  })
})

describe('캘린더 셀 — 지정된 줄만 하이라이트', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    // 셀 entry 는 이름을 staffStore.doctors 에서 찾는다 — 없으면 entry 자체가 만들어지지 않는다
    useStaffStore().doctors.push({ id: `${DOC}`, text: '홍의사', staffId: DOC } as any)
  })

  it('★지정이 걸린 (직원, 날짜) 만 isDesignated 다', async () => {
    setupMocks(staffMondayOnly, [
      { staffId: DOC, date: TUE_DATE, overrideOpenHm: '1400', overrideCloseHm: '1900' },
    ])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const designated = state.formatListEntries([DOC], dayjs(TUE_DATE), TUE_DATE)
    expect(designated[0].label, '지정값이 라벨에도 반영된다').toBe('홍의사 14:00 ~ 19:00')
    expect(designated[0].isDesignated).toBe(true)

    const plain = state.formatListEntries([DOC], dayjs(MON_DATE), MON_DATE)
    expect(plain[0].isDesignated, '요일 반복만 따르는 날은 강조하지 않는다').toBe(false)
  })

  it('기관 휴무일에도 진료로 지정한 줄은 시간이 보인다 — 지정이 기관 휴무를 이긴다(§4-2 1단계)', async () => {
    setupMocks(staffMondayOnly, [
      { staffId: DOC, date: TUE_DATE, overrideOpenHm: '1400', overrideCloseHm: '1900' },
    ])
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.dateOverrides.set(TUE_DATE, 'OFF') // 사업장 일자 휴무 — 예전에는 이 날 전원이 (휴무)으로 접혔다

    const entries = state.formatListEntries([DOC], dayjs(TUE_DATE), TUE_DATE)
    expect(entries[0].label, '지정 진료 시간이 기관 휴무를 덮지 않고 그대로 보인다').toBe('홍의사 14:00 ~ 19:00')
    expect(entries[0].isOff).toBe(false)
    expect(entries[0].isDesignated, '직원별 표기가 갈리는 날일수록 지정 강조가 필요하다').toBe(true)
  })
})
