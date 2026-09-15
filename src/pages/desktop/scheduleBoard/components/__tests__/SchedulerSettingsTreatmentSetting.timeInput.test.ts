/**
 * @vitest-environment happy-dom
 *
 * 운영시간 입력 완결성 가드
 * (2026-07-29 · 2026-08-28 저장 시점 검증으로 전환 · 2026-09-03 바깥 클릭에서도 검증 + [X] 출구).
 *
 * 시작·종료 중 **하나라도 입력했으면 둘 다** 있어야 한다. 한쪽만 채운 채 넘어가면
 * blocksToWorkRange 가 짝이 안 맞는 값을 null 로 바꿔 그 행이 **조용히 휴무로 저장**된다
 * — 사용자는 09:00 을 입력해 뒀는데 그 요일이 쉬는 날이 되어 있다.
 *
 * ★검증이 도는 자리는 둘이다.
 *  ① popover **바깥 클릭** — 캡처 가드가 그 클릭을 삼켜 popover 를 붙잡고 안내한다. 오류가
 *     남아 있는 한 매번 막는다. 나가는 길은 우상단 [X] 하나뿐이고, 그건 검증하지 않는다.
 *  ② 저장 버튼 — 실제로 막는 곳. 입력은 그때까지 상태에 그대로 남아 있다.
 *  commit 자체는 검증하지 않는다: 스크롤·리사이즈로도 들어오는 경로라 막을 자리가 아니다.
 *
 * 둘 다 비운 것은 막지 않는다. 그건 정상적인 의사 표현이다:
 *   진료행 = 그 요일 휴무 / 휴게행 = 휴게 없음
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const dialogMock = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
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

const MONDAY = 1

const siteRows = [{
  dayCd: MONDAY, openHm: '0900', closeHm: '1800',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}]

/* ★테스트마다 언마운트한다 — 이 컴포넌트는 document 에 click 리스너를 건다.
 * 남겨 두면 리스너가 누적돼, 한 번의 document 클릭이 이전 테스트의 컴포넌트들까지 깨우고
 * 그쪽 popover 가 열려 있으면 안내가 여러 번 호출된 것처럼 보인다(가짜 실패). */
const mounted: any[] = []

afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

/** attached=true 면 document 에 붙인다 — focus/activeElement 를 보는 테스트만 쓴다 */
async function mountSetting(attached = false) {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    ...(attached ? { attachTo: document.body } : {}),
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** 사업장 요일 편집 popover 를 좌표 계산 없이 draft 만 얹어 연다 */
function openWeekdayDraft(state: any, draft: Record<string, { start: string; end: string }>) {
  state.weekdayEditor.open = true
  state.weekdayEditor.ownerKey = 'INSTITUTION'
  state.weekdayEditor.weekday = MONDAY
  state.weekdayEditor.draft = {
    WORK: { start: '', end: '' },
    LUNCH: { start: '', end: '' },
    DINNER: { start: '', end: '' },
    ...draft,
  }
}

/* commit 경로 — 스크롤·리사이즈, 그리고 우상단 [X] 가 여기로 온다.
 * 이 경로는 검증하지 않는다: 반쪽 입력을 버리지 않고 상태에 남겨 저장 게이트에 넘긴다. */
describe('운영시간 입력 완결성 — 요일 편집 popover(commit 경로)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('★시작만 입력해도 commit 은 안내 없이 닫고, 입력은 상태에 그대로 남는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    state.commitWeekdayEditor()
    await flushPromises()

    expect(dialogMock.alert, 'commit 경로는 검증하지 않는다').not.toHaveBeenCalled()
    expect(state.weekdayEditor.open).toBe(false)
    expect(state.institutionWeeklyDayMap.get(MONDAY), '반쪽 입력이 버려지지 않는다')
      .toEqual([{ kind: 'WORK', start: '09:00', end: '' }])
  })

  it('종료만 입력해도 같다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '', end: '18:00' } })

    state.commitWeekdayEditor()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.institutionWeeklyDayMap.get(MONDAY)).toEqual([{ kind: 'WORK', start: '', end: '18:00' }])
  })

  it('휴게시간의 반쪽 입력도 그대로 보존된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {
      WORK: { start: '09:00', end: '18:00' },
      LUNCH: { start: '13:00', end: '' },
    })

    state.commitWeekdayEditor()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.institutionBreaksByWeekday.get(MONDAY).LUNCH).toEqual({ start: '13:00', end: '' })
    expect(state.institutionBreaksByWeekday.get(MONDAY).DINNER, '둘 다 비운 휴게는 없음').toBeNull()
  })

  it('시작·종료를 모두 채우면 정상 커밋된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '10:00', end: '17:00' } })

    state.commitWeekdayEditor()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.weekdayEditor.open).toBe(false)
    expect(state.institutionWeeklyDayMap.get(MONDAY)).toEqual([{ kind: 'WORK', start: '10:00', end: '17:00' }])
  })

  it('둘 다 비운 것은 그 요일 휴무가라는 정상 의사 표현 — entry 가 지워진다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    state.commitWeekdayEditor()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.institutionWeeklyDayMap.has(MONDAY)).toBe(false)
  })

  it('스크롤로 닫힐 때는 검증하지 않는다 — 사용자가 닫으려 한 조작이 아니다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    window.dispatchEvent(new Event('scroll'))
    await flushPromises()

    expect(dialogMock.alert, '스크롤은 안내 대상이 아니다').not.toHaveBeenCalled()
    expect(state.weekdayEditor.open, 'fixed popover 는 버튼과 어긋나므로 닫는다').toBe(false)
    expect(state.institutionWeeklyDayMap.get(MONDAY)).toEqual([{ kind: 'WORK', start: '09:00', end: '' }])
  })
})

/**
 * 바깥 클릭에서의 검증 (2026-09-03).
 *
 * 저장까지 미루지 않고 그 자리에서 잡는다. 판정 3단과 문구는 저장 게이트와 같다.
 *
 * ★되돌렸던 구현(14252b6)의 사고를 되풀이하지 않는 것이 이 describe 의 임무다:
 *  ① 닫기만 막고 배경(패널 접기·탭 이동)은 그대로 진행돼 popover 가 앵커를 잃고 떠 있었다
 *     → 캡처 단계에서 클릭 자체를 삼켜 배경도 함께 멈춘다.
 *  ② 클릭할 때마다 안내가 다시 떠 아무 데도 누를 수 없었다
 *     → 우상단 [X] 가 검증 없이 닫아 준다. 막는 것과 [X] 는 한 쌍이라, X 가 사라지면 ② 가 그대로
 *       재발한다. 그래서 "매번 막힌다"와 "[X] 로 나간다"를 같은 describe 에서 함께 지킨다.
 */
describe('운영시간 입력 완결성 — 바깥 클릭과 [X] 출구', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  /** 배경 클릭 — 캡처 가드가 보는 것과 같은 경로 */
  async function clickOutside() {
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
  }

  it('★반쪽 입력이 남은 채 바깥을 누르면 popover 가 닫히지 않고 안내가 한 번 뜬다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    await clickOutside()

    expect(state.weekdayEditor.open, '고칠 자리를 화면에 붙잡아 둔다').toBe(true)
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0]).toBe('시작시간과 종료시간을 모두 입력해 주세요.')
    expect(state.institutionWeeklyDayMap.get(MONDAY), '붙잡아 뒀으니 draft 를 아직 상태로 옮기지 않는다')
      .toEqual([{ kind: 'WORK', start: '09:00', end: '18:00' }])
  })

  it('★안내와 함께 비어 있는 칸이 빨갛게 된다 — 어느 칸인지 문구만으로는 알 수 없다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    await clickOutside()

    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end'), '비어 있는 종료칸').toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start'), '채워진 시작칸은 아니다').toBe(false)
  })

  /* ★고칠 때까지 막는다. 종전에는 첫 클릭만 막고 두 번째를 놓아줬는데, [X] 가 생겨 나갈 길이
   * 따로 있으므로 더는 놓아줄 이유가 없다. 놓아주면 오류가 든 값이 조용히 상태로 넘어간다. */
  it('★두 번째·세 번째 클릭에서도 계속 막히고 그때마다 안내한다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    await clickOutside()
    await clickOutside()
    await clickOutside()

    expect(state.weekdayEditor.open, '고치기 전에는 닫히지 않는다').toBe(true)
    expect(dialogMock.alert).toHaveBeenCalledTimes(3)
    expect(state.institutionWeeklyDayMap.get(MONDAY), 'draft 는 상태로 넘어가지 않는다')
      .toEqual([{ kind: 'WORK', start: '09:00', end: '18:00' }])
  })

  /* ★덫 방지의 전부 — 이 버튼이 없으면 위 "계속 막는다"가 그대로 14252b6 의 사고 ② 가 된다. */
  it('★[X] 는 검증 없이 닫는다 — 막힌 사용자가 나가는 유일한 출구', async () => {
    const wrapper = await mountSetting(true)
    const state = wrapper.vm.$.setupState
    state.activeLeftTab = 'WORKING_HOURS'
    state.expandedTreatmentKey = 'institution'
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    await wrapper.vm.$nextTick()

    const closeBtn = document.querySelector(
      '.schedulerTreatmentSetting__weekdayEditorClose',
    ) as HTMLElement
    expect(closeBtn, '[X] 가 popover 에 렌더돼 있어야 한다').toBeTruthy()
    closeBtn.click()
    await flushPromises()

    expect(dialogMock.alert, '[X] 는 안내하지 않는다').not.toHaveBeenCalled()
    expect(state.weekdayEditor.open).toBe(false)
    expect(state.institutionWeeklyDayMap.get(MONDAY), '반쪽 입력은 상태에 남아 저장 게이트가 잡는다')
      .toEqual([{ kind: 'WORK', start: '09:00', end: '' }])
  })

  it('★일자 지정 popover 의 [X] 도 같은 규약', async () => {
    const wrapper = await mountSetting(true)
    const state = wrapper.vm.$.setupState
    state.cellStaffEditor.open = true
    state.cellStaffEditor.ownerKey = 'STAFF:11'
    state.cellStaffEditor.dateKey = '2026-08-18'
    state.cellStaffEditor.weekday = 2
    state.cellStaffEditor.draft = { WORK: { start: '09:00', end: '' } }
    await wrapper.vm.$nextTick()

    const closeBtn = document.querySelector(
      '.schedulerTreatmentSetting__weekdayEditorClose',
    ) as HTMLElement
    expect(closeBtn, '[X] 가 popover 에 렌더돼 있어야 한다').toBeTruthy()
    closeBtn.click()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.cellStaffEditor.open).toBe(false)
  })

  it('정상 값이면 바깥 클릭에 그대로 닫힌다 — 막을 것이 없다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '10:00', end: '17:00' } })

    await clickOutside()

    expect(state.weekdayEditor.open).toBe(false)
    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.institutionWeeklyDayMap.get(MONDAY)).toEqual([{ kind: 'WORK', start: '10:00', end: '17:00' }])
  })

  it('둘 다 비운 것은 그 요일 휴무가라는 정상 의사 표현 — 막지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    await clickOutside()

    expect(state.weekdayEditor.open).toBe(false)
    expect(dialogMock.alert).not.toHaveBeenCalled()
  })

  /* 매월 n번째만 쉬는 요일은 나머지 주에 진료하므로 둘 다 비우는 것이 "휴무"이 아니다 — 저장 게이트
   * 4단과 같은 판정·같은 문구를 바깥 클릭에서도 돌린다(닫을 때와 저장할 때 다르게 말하지 않는다). */
  it('★매월 n번째만 휴무인 요일을 둘 다 비운 채 바깥을 누르면 붙잡고 몇 번째인지까지 말한다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site: siteRows, holidayHours: null,
          recurringOffRules: [{ dayCd: MONDAY, repeatTy: 'MONTHLY', monthlyNth: 2 }],
          workDates: [], offDates: [], holidayClosedYn: false,
        },
      },
    })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    await clickOutside()

    expect(state.weekdayEditor.open, '고칠 자리를 붙잡아 둔다').toBe(true)
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0])
      .toBe('월요일은 매월 2번째 휴무가라 나머지 주에 진료합니다.\n운영시간을 입력해 주세요.')
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start'), '빈 운영시간 시작칸이 붉다').toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end'), '빈 운영시간 종료칸이 붉다').toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'LUNCH', 'start'), '휴게시간은 대상이 아니다').toBe(false)
  })

  it('★형식 오류도 같은 게이트 — 저장 게이트와 같은 문구로 막는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '25:90', end: '17:00' } })

    await clickOutside()

    expect(state.weekdayEditor.open).toBe(true)
    expect(dialogMock.alert.mock.calls[0][0]).toBe('시간을 00:00 ~ 23:59 범위로 입력해 주세요.')
  })

  it('★역전도 같은 게이트', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '17:00', end: '10:00' } })

    await clickOutside()

    expect(state.weekdayEditor.open).toBe(true)
    expect(dialogMock.alert.mock.calls[0][0]).toBe('종료시간은 시작시간보다 늦어야 합니다.')
  })

  it('미완성이 형식 오류보다 먼저 안내된다 — 저장 게이트와 같은 순서', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '25:90', end: '' } })

    await clickOutside()

    expect(dialogMock.alert.mock.calls[0][0]).toBe('시작시간과 종료시간을 모두 입력해 주세요.')
  })

  it('휴게시간의 반쪽 입력도 막는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '18:00' }, LUNCH: { start: '13:00', end: '' } })

    await clickOutside()

    expect(state.weekdayEditor.open).toBe(true)
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
  })

  /* popover 안에서 입력칸을 옮겨 다니는 것은 닫으려는 조작이 아니다 */
  it('★popover 안쪽 클릭은 막지 않는다', async () => {
    const wrapper = await mountSetting(true)
    const state = wrapper.vm.$.setupState
    state.activeLeftTab = 'WORKING_HOURS'
    state.expandedTreatmentKey = 'institution'
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    await wrapper.vm.$nextTick()

    const input = document.querySelector('.schedulerTreatmentSetting__weekdayEditor input') as HTMLElement
    expect(input, 'popover 입력칸이 렌더돼 있어야 한다').toBeTruthy()
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(state.weekdayEditor.open).toBe(true)
  })

  it('★일자 지정 popover 도 같은 규칙으로 막힌다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.cellStaffEditor.open = true
    state.cellStaffEditor.ownerKey = 'STAFF:11'
    state.cellStaffEditor.dateKey = '2026-08-18'
    state.cellStaffEditor.weekday = 2
    state.cellStaffEditor.draft = { WORK: { start: '09:00', end: '' } }

    await clickOutside()

    expect(state.cellStaffEditor.open).toBe(true)
    expect(dialogMock.alert.mock.calls[0][0]).toBe('시작시간과 종료시간을 모두 입력해 주세요.')
  })
})

describe('운영시간 입력 완결성 — 저장 최종 가드', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: 11, staffName: '김의사' }] }] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          staff: [{ staffId: 11, staffName: '김의사', times: [{ dayCd: MONDAY, staffOpenHm: '0900', staffCloseHm: '1300' }] }],
          overrides: [],
        },
      },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
  })

  /**
   * ★담당자 주간 7행 인라인 표는 popover 를 쓰지 않는다 — 입력 중간 상태를 그대로 둔다
   * (매 글자 막을 수 없다). 그래서 저장 직전에 한 번 더 본다.
   */
  it('★담당자 주간에 반쪽 입력이 남아 있으면 저장하지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    // 월요일 종료시간만 지운다 → {start:'09:00', end:''}
    state.setStaffWorkHours(11, MONDAY, 'end', '')
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings, '저장 API 가 호출되면 안 된다').not.toHaveBeenCalled()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
  })

  /* 시간을 통째로 비우는 것은 "미설정으로 되돌리기"다(2026-08-20 탭 책임 분리).
   * 한쪽만 채운 미완성 상태와 달리 저장을 막을 이유가 없다. */
  it('통째로 비운 요일은 미설정이라 저장을 막지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(11, MONDAY, 'start', '')
    state.setStaffWorkHours(11, MONDAY, 'end', '')
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings).toHaveBeenCalledTimes(1)
  })

  /* 안내(alert)만으로는 어느 칸을 채워야 하는지 알 수 없다 —
   * 예약등록 팝업과 같은 규약(data-invalid)으로 그 칸을 가리킨다. */
  it('★저장을 막을 때 비어 있는 칸이 하이라이트되고, 그 담당자 패널이 펼쳐진다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(11, MONDAY, 'end', '')
    await wrapper.vm.$nextTick()

    // 저장 전에는 그리지 않는다 — 입력 중에 빨갛게 만들지 않기 위해
    expect(state.staffTimeInvalid(11, MONDAY, 'end')).toBe(false)

    await state.onSave()
    await flushPromises()

    expect(state.staffTimeInvalid(11, MONDAY, 'end'), '비어 있는 종료 칸을 가리킨다').toBe(true)
    expect(state.staffTimeInvalid(11, MONDAY, 'start'), '채워진 칸은 건드리지 않는다').toBe(false)
    // 접힌 패널에 테두리를 그려 봐야 화면에 없다 → 펼치고 운영시간 탭으로 옮긴다
    expect(state.expandedTreatmentKey).toBe('staff:11')
    expect(state.activeLeftTab).toBe('WORKING_HOURS')
  })

  it('★짝을 맞추면 하이라이트가 스스로 풀린다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(11, MONDAY, 'end', '')
    await state.onSave()
    await flushPromises()
    expect(state.staffTimeInvalid(11, MONDAY, 'end')).toBe(true)

    state.setStaffWorkHours(11, MONDAY, 'end', '13:00')
    await wrapper.vm.$nextTick()

    expect(state.staffTimeInvalid(11, MONDAY, 'end')).toBe(false)
  })

  it('다른 요일·다른 담당자는 하이라이트되지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.setStaffWorkHours(11, MONDAY, 'end', '')
    await state.onSave()
    await flushPromises()

    expect(state.staffTimeInvalid(11, MONDAY + 1, 'end')).toBe(false)
    expect(state.staffTimeInvalid(99, MONDAY, 'end')).toBe(false)
  })
})

/**
 * 사업장 요일 popover 의 반쪽 입력은 닫을 때가 아니라 **저장 버튼**에서 잡는다.
 * 안내만으로는 어느 요일인지 알 수 없다 — 사업장 패널을 펼치고 그 요일 버튼을 빨갛게 가리킨다.
 * (popover 는 이미 닫혀 있어, 버튼이 그 요일을 가리키는 유일한 자리다.)
 */
describe('미완성 입력 — 사업장 popover 는 저장 게이트가 잡는다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
  })

  it('★반쪽 입력을 닫아 두고 저장하면 저장하지 않고 안내하며, 사업장 패널을 펼치고 그 요일 버튼을 가리킨다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    state.commitWeekdayEditor()
    await flushPromises()

    // 저장 전에는 그리지 않는다 — 입력 중에 빨갛게 만들지 않기 위해
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY)).toBe(false)

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings, '저장 API 가 호출되면 안 된다').not.toHaveBeenCalled()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
    expect(state.activeLeftTab).toBe('WORKING_HOURS')
    expect(state.expandedTreatmentKey, '접힌 패널에 테두리를 그려 봐야 화면에 없다').toBe('institution')
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY), '그 요일 버튼을 가리킨다').toBe(true)
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY + 1), '다른 요일은 건드리지 않는다').toBe(false)
  })

  it('★저장이 막힌 뒤 다시 연 popover 는 비어 있는 칸을 가리킨다 (입력 중에는 그리지 않는다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end'), '입력 중').toBe(false)
    state.commitWeekdayEditor()

    await state.onSave()
    await flushPromises()

    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end'), '비어 있는 종료 칸').toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start'), '채워진 칸은 그대로').toBe(false)
  })

  it('휴게시간 반쪽 입력도 저장을 막고 그 요일 버튼을 가리킨다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {
      WORK: { start: '09:00', end: '18:00' },
      LUNCH: { start: '13:00', end: '' },
    })
    state.commitWeekdayEditor()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY)).toBe(true)

    openWeekdayDraft(state, { WORK: { start: '09:00', end: '18:00' }, LUNCH: { start: '13:00', end: '' } })
    expect(state.editorSlotInvalid(state.weekdayEditor, 'LUNCH', 'end')).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(false)
  })

  it('★짝을 맞추면 하이라이트가 스스로 풀리고 저장된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    state.commitWeekdayEditor()
    await state.onSave()
    await flushPromises()
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY)).toBe(true)

    // baseline(09:00~18:00)과 다른 값으로 맞춰야 dirty 가 되어 저장이 나간다
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '17:00' } })
    state.commitWeekdayEditor()
    await wrapper.vm.$nextTick()
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY)).toBe(false)

    await state.onSave()
    await flushPromises()
    expect(mocks.saveTreatmentSettings).toHaveBeenCalledTimes(1)
  })

  /* popover 는 이미 닫혀 있다 — 요일 버튼 테두리만으로는 진료/휴게1/휴게2 · 시작/종료 중 어느 칸인지 모른다.
   * 그 요일 popover 를 다시 열어 빈 칸을 보이고, 안내 [확인] 뒤 포커스가 그 칸에 있어야 한다. */
  it('★저장이 막히면 그 요일 popover 가 자동으로 다시 열리고 비어 있는 칸에 포커스가 간다', async () => {
    const wrapper = await mountSetting(true)
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    state.commitWeekdayEditor()
    await flushPromises()
    expect(state.weekdayEditor.open, '닫혀 있다').toBe(false)

    await state.onSave()
    await flushPromises()

    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(state.weekdayEditor.open, '그 요일 popover 가 다시 열린다').toBe(true)
    expect(state.weekdayEditor.ownerKey).toBe('INSTITUTION')
    expect(state.weekdayEditor.weekday).toBe(MONDAY)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end'), '빈 종료 칸을 가리킨다').toBe(true)
    const focused = document.activeElement as HTMLElement | null
    expect(focused?.getAttribute('data-invalid'), '포커스가 그 칸에 있다').toBe('true')
    expect(wrapper.element.contains(focused) || document.body.contains(focused)).toBe(true)
  })

  it('휴게시간 칸이 비었으면 다시 열린 popover 에서 그 휴게 칸이 가리켜진다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '18:00' }, DINNER: { start: '', end: '19:00' } })
    state.commitWeekdayEditor()

    await state.onSave()
    await flushPromises()

    expect(state.weekdayEditor.open).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'DINNER', 'start')).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start')).toBe(false)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(false)
  })

  /* 매주 휴무 요일은 버튼이 disabled 라 고칠 길이 없고 payload 도 그 행을 싣지 않는다 — 보면 덫이 된다 */
  it('매주 휴무로 잠긴 요일의 반쪽 값은 게이트가 보지 않는다 (저장이 영영 막히지 않는다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    state.commitWeekdayEditor()
    state.weekdayOffs = new Map([[MONDAY, new Set(['WEEKLY'])]]) // 월요일 매주 휴무
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(mocks.saveTreatmentSettings).toHaveBeenCalledTimes(1)
  })

  it('공휴일 운영시간의 반쪽 입력도 같은 게이트 — 사업장 패널을 펼치고 공휴일 버튼을 가리킨다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.weekdayEditor.open = true
    state.weekdayEditor.ownerKey = state.HOLIDAY_OWNER
    state.weekdayEditor.weekday = state.HOLIDAY_SLOT
    state.weekdayEditor.draft = {
      WORK  : { start: '10:00', end: '' },
      LUNCH : { start: '', end: '' },
      DINNER: { start: '', end: '' },
    }
    state.commitWeekdayEditor()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
    expect(state.expandedTreatmentKey).toBe('institution')
    expect(state.ownerWeekdayInvalid(state.HOLIDAY_OWNER, state.HOLIDAY_SLOT)).toBe(true)
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY), '요일 버튼은 멀쩡하다').toBe(false)
    expect(state.weekdayEditor.open, '공휴일 popover 가 다시 열린다').toBe(true)
    expect(state.weekdayEditor.ownerKey).toBe(state.HOLIDAY_OWNER)
  })

  it('공휴일 휴무로 잠겨 있으면 공휴일 반쪽 값은 게이트가 보지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.weekdayEditor.open = true
    state.weekdayEditor.ownerKey = state.HOLIDAY_OWNER
    state.weekdayEditor.weekday = state.HOLIDAY_SLOT
    state.weekdayEditor.draft = {
      WORK  : { start: '10:00', end: '' },
      LUNCH : { start: '', end: '' },
      DINNER: { start: '', end: '' },
    }
    state.commitWeekdayEditor()
    state.includePublicHolidays = true // 공휴일 휴무 → 공휴일 시간 잠김
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(mocks.saveTreatmentSettings).toHaveBeenCalledTimes(1)
  })
})

/**
 * 일자 지정(달력 셀) popover 의 반쪽 입력 — 저장이 막히면 그 달로 옮기고 그 셀 편집기를 다시 연다.
 */
describe('미완성 입력 — 일자 지정은 그 셀 편집기를 다시 연다', () => {
  const DOC = 11
  const TUE_DATE = '2026-08-18'

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    // 셀 entry 는 이름을 staffStore.doctors 에서 찾는다 — 없으면 그 줄이 렌더되지 않아
    // 저장 게이트가 되짚을 앵커(cellEntryEls)도 생기지 않는다
    useStaffStore().doctors.push({ id: `${DOC}`, text: '김의사', staffId: DOC } as any)
    mocks.getTeams.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: DOC, staffName: '김의사' }] }] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
  })

  it('★저장이 막히면 그 달로 이동해 그 날짜 셀 편집기가 다시 열리고 빈 칸이 가리켜진다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.selectedYear = 2025
    state.selectedMonth = 1

    const next = new Map(state.workingHoursOverridesByOwner)
    next.set(`STAFF:${DOC}`, new Map([[TUE_DATE, [{ kind: 'WORK', start: '', end: '13:00' }]]]))
    state.workingHoursOverridesByOwner = next
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
    expect(state.expandedTreatmentKey, '그 담당자 패널(=달력 대상)').toBe(`staff:${DOC}`)
    expect([state.selectedYear, state.selectedMonth], '그 날짜의 달로 옮긴다').toEqual([2026, 8])
    expect(state.cellStaffEditor.open, '그 셀 편집기가 다시 열린다').toBe(true)
    expect(state.cellStaffEditor.dateKey).toBe(TUE_DATE)
    expect(state.editorSlotInvalid(state.cellStaffEditor, 'WORK', 'start'), '빈 시작 칸').toBe(true)
  })
})

/**
 * 시간 입력칸을 `<input type="time">` → 일반 텍스트로 전환 (2026-08-18).
 *
 * 브라우저가 보장해 주던 형식·범위 검사가 사라졌다. 이 describe 가 그 대체 가드를 지킨다 —
 * 뚫리면 "2590" 이 state 를 지나 HHMMToHmm(콜론만 제거)을 통과해 서버로 나간다.
 */

/** 실제 input 의 change 이벤트를 흉내 낸다 — 핸들러가 DOM 값을 되돌려 쓰므로 target 이 필요하다 */
function changeEvent(value: string) {
  return { target: { value } }
}

describe('시간 텍스트 입력 — 정규화', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  /* 입력 단계 마스킹 — 문자·5번째 숫자는 칸에 들어오지도 못한다.
   * state 는 건드리지 않는다(확정은 blur) — 여기서 반영하면 "09" 중간 상태가 09:00 으로 저장된다. */
  it('★입력 중 숫자 외 문자는 칸에서 지워진다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    const event = changeEvent('0a9b')
    state.maskTimeInput(event)

    expect(event.target.value).toBe('09')
    expect(state.weekdayEditor.draft.WORK.start, '아직 확정하지 않는다').toBe('')
  })

  it('★숫자 4개를 넘겨 칠 수 없다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    const event = changeEvent('09305')
    state.maskTimeInput(event)

    expect(event.target.value).toBe('09:30')
  })

  it('★4번째 숫자에서 콜론이 자동으로 붙는다 (3자리까지는 붙지 않는다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    const typing = changeEvent('')
    for (const [keyed, shown] of [['0', '0'], ['09', '09'], ['093', '093'], ['0930', '09:30']]) {
      typing.target.value = keyed
      state.maskTimeInput(typing)
      expect(typing.target.value).toBe(shown)
    }
  })

  it('★"0930" 처럼 콜론 없이 쳐도 "09:30" 으로 확정된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    state.onEditorTimeInput(changeEvent('0930'), 'WORK', 'start')
    await wrapper.vm.$nextTick()

    expect(state.weekdayEditor.draft.WORK.start).toBe('09:30')
  })

  /* state 값이 이미 같으면 재렌더가 없어 :value 바인딩만으로는 입력칸에 친 원문이 남는다 */
  it('★입력칸의 DOM 값도 정규화된 값으로 맞춘다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    const event = changeEvent('930')
    state.onEditorTimeInput(event, 'WORK', 'start')

    expect(event.target.value).toBe('09:30')
  })

  it('보정할 수 없는 값은 지우지 않고 그대로 둔다 — 말없이 지우면 그 요일이 휴무가 된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    state.onEditorTimeInput(changeEvent('2590'), 'WORK', 'start')
    await wrapper.vm.$nextTick()

    expect(state.weekdayEditor.draft.WORK.start).toBe('2590')
  })

  it('빈 입력은 그대로 빈 값 — 휴무 지정 경로를 막지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '18:00' } })

    state.onEditorTimeInput(changeEvent('  '), 'WORK', 'start')
    await wrapper.vm.$nextTick()

    expect(state.weekdayEditor.draft.WORK.start).toBe('')
  })
})

/**
 * 오류 표시는 두 계층에 건다 — data-invalid 는 CSS(빨간 테두리), aria-invalid 는 스크린리더.
 * 둘 다 같은 판정 함수에서 나오므로 값이 어긋날 수 없어야 한다.
 * aria-invalid 에는 어떤 CSS 규칙도 걸지 않는다(테두리가 겹쳐 그려지지 않는다).
 */
describe('오류 표시 — data-invalid / aria-invalid 동행', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: 11, staffName: '김의사' }] }] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          staff: [{ staffId: 11, staffName: '김의사', times: [{ dayCd: MONDAY, staffOpenHm: '0900', staffCloseHm: '1300' }] }],
          overrides: [],
        },
      },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
  })

  /** 담당자 패널을 펼쳐 7행 인라인 표의 시간 입력칸을 꺼낸다.
   *  좌측 탭 기본값은 'OFF'(휴무일)라 운영시간 탭으로 옮기지 않으면 표 자체가 렌더되지 않는다. */
  async function openStaffHours(wrapper: any) {
    wrapper.vm.$.setupState.activeLeftTab = 'WORKING_HOURS'
    wrapper.vm.$.setupState.expandedTreatmentKey = `staff:11`
    await wrapper.vm.$nextTick()
    return wrapper.findAll('.schedulerTreatmentSetting__timeInput')
  }

  it('정상 값이면 두 속성 모두 "false" — CSS 는 "true" 만 보므로 테두리가 그려지지 않는다', async () => {
    const wrapper = await mountSetting()
    const inputs = await openStaffHours(wrapper)

    expect(inputs.length, '요일 7행 × 시작·종료').toBeGreaterThan(0)
    expect(inputs[0].attributes('data-invalid')).toBe('false')
    expect(inputs[0].attributes('aria-invalid')).toBe('false')
  })

  it('★오류가 나면 두 속성이 함께 "true" 가 된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onStaffTimeInput(changeEvent('2590'), 11, MONDAY, 'end')
    const inputs = await openStaffHours(wrapper)

    const invalid = inputs.filter(i => i.attributes('data-invalid') === 'true')
    expect(invalid.length, '형식이 틀린 칸 하나').toBe(1)
    expect(invalid[0].attributes('aria-invalid'), '같은 판정 함수라 항상 동행한다').toBe('true')
  })

  it('모든 시간 입력칸이 두 속성을 함께 갖는다 (한쪽만 붙은 칸이 없다)', async () => {
    const wrapper = await mountSetting()
    const inputs = await openStaffHours(wrapper)

    for (const input of inputs) {
      expect(input.attributes('data-invalid')).toBeDefined()
      expect(input.attributes('aria-invalid')).toBe(input.attributes('data-invalid'))
    }
  })
})

describe('시간 텍스트 입력 — 형식·순서 가드 (사업장 popover → 저장 게이트)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
  })

  /** popover 를 닫아 상태에 옮긴 뒤 저장을 누른다 — 게이트는 저장에서만 돈다 */
  async function commitAndSave(state: any, draft: Record<string, { start: string; end: string }>) {
    openWeekdayDraft(state, draft)
    state.commitWeekdayEditor()
    expect(state.weekdayEditor.open, '닫을 때는 막지 않는다').toBe(false)
    await state.onSave()
    await flushPromises()
  }

  it('★형식이 틀린 값이 남아 있으면 저장하지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    await commitAndSave(state, { WORK: { start: '2590', end: '18:00' } })

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('00:00 ~ 23:59')
    expect(state.expandedTreatmentKey, '어느 칸인지 보이게 패널을 펼친다').toBe('institution')
  })

  it('★종료가 시작보다 이르면 저장하지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    await commitAndSave(state, { WORK: { start: '18:00', end: '09:00' } })

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('종료시간은 시작시간보다')
  })

  it('시작·종료가 같아도 구간이 아니라 막는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    await commitAndSave(state, { WORK: { start: '09:00', end: '09:00' } })

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('종료시간은 시작시간보다')
  })

  it('휴게시간 행의 역전도 막는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    await commitAndSave(state, {
      WORK : { start: '09:00', end: '18:00' },
      LUNCH: { start: '14:00', end: '13:00' },
    })

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('종료시간은 시작시간보다')
  })

  /* 안내가 엉뚱하면 사용자가 다른 곳을 고친다 — 덜 채운 칸을 "형식 오류"라 하면 안 된다 */
  it('미완성이 형식 오류보다 먼저 안내된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    await commitAndSave(state, {
      WORK : { start: '09:00', end: '' },
      LUNCH: { start: '2590', end: '13:00' },
    })

    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
  })

  /* 형식 오류·역전은 blur 로 확정된 사실이라 저장을 눌러 보기 전에 바로 가리킨다 */
  it('★형식 오류는 저장을 눌러 보기 전에도 하이라이트된다 — popover 안과 요일 버튼 모두', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '2590', end: '18:00' } })

    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start')).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(false)

    state.commitWeekdayEditor()
    await wrapper.vm.$nextTick()
    expect(state.ownerWeekdayInvalid('INSTITUTION', MONDAY), '닫은 뒤에는 요일 버튼이 가리킨다').toBe(true)
  })

  it('★역전은 고쳐야 할 종료칸을 가리킨다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '18:00', end: '09:00' } })

    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start')).toBe(false)
  })
})

describe('시간 텍스트 입력 — 저장 최종 가드 (담당자 7행)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTeams.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: 11, staffName: '김의사' }] }] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          staff: [{ staffId: 11, staffName: '김의사', times: [{ dayCd: MONDAY, staffOpenHm: '0900', staffCloseHm: '1300' }] }],
          overrides: [],
        },
      },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
  })

  /* 7행 인라인 표는 popover commit 을 거치지 않는다 — 여기서 못 잡으면 그대로 payload 에 실린다 */
  it('★형식이 틀린 값이 남아 있으면 저장하지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onStaffTimeInput(changeEvent('2590'), 11, MONDAY, 'end')
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings, '저장 API 가 호출되면 안 된다').not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('00:00 ~ 23:59')
    expect(state.expandedTreatmentKey, '어느 칸인지 보이게 패널을 펼친다').toBe('staff:11')
  })

  it('★종료가 시작보다 이르면 저장하지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onStaffTimeInput(changeEvent('08:00'), 11, MONDAY, 'end')
    await wrapper.vm.$nextTick()

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toContain('종료시간은 시작시간보다')
  })

  it('형식 오류 칸은 저장을 눌러 보기 전에도 하이라이트된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onStaffTimeInput(changeEvent('2590'), 11, MONDAY, 'end')
    await wrapper.vm.$nextTick()

    expect(state.staffTimeInvalid(11, MONDAY, 'end')).toBe(true)
    expect(state.staffTimeInvalid(11, MONDAY, 'start')).toBe(false)
  })

  it('정규화로 살아난 값은 그대로 저장된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onStaffTimeInput(changeEvent('1830'), 11, MONDAY, 'end')
    await wrapper.vm.$nextTick()
    expect(state.fetchStaffWorkHours(11, MONDAY, 'end')).toBe('18:30')

    await state.onSave()
    await flushPromises()

    expect(mocks.saveTreatmentSettings).toHaveBeenCalledTimes(1)
    const payload = mocks.saveTreatmentSettings.mock.calls[0][0]
    const monday = payload.workingHours.staff
      .find((m: any) => m.staffId === 11).times
      .find((t: any) => t.dayCd === MONDAY)
    expect(monday.staffCloseHm, '서버로는 콜론 없는 "HHmm" 으로 나간다').toBe('1830')
  })
})
