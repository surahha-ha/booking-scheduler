/**
 * @vitest-environment happy-dom
 *
 * 운영시간 입력 완결성 가드 (2026-07-29).
 *
 * 시작·종료 중 **하나라도 입력했으면 둘 다** 있어야 한다. 한쪽만 채운 채 넘어가면
 * blocksToWorkRange 가 짝이 안 맞는 값을 null 로 바꿔 그 행이 **조용히 휴무로 저장**된다
 * — 사용자는 09:00 을 입력해 뒀는데 그 요일이 쉬는 날이 되어 있다.
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
  getTreatmentSettings: vi.fn(),
  getSiteWorkHours: vi.fn(),
  getStaffWorkHours: vi.fn(),
  saveTreatmentSettings: vi.fn(),
  getUnassignedReservations: vi.fn(),
  assignUnassigned: vi.fn(),
}))
vi.mock('@/api/siteApi', () => ({
  getTreatmentSettings: mocks.getTreatmentSettings,
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

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
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

describe('운영시간 입력 완결성 — 요일 편집 popover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('★시작만 입력하면 커밋이 막히고 안내가 뜬다 (편집기도 닫히지 않는다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    expect(state.commitWeekdayEditor()).toBe(false)
    await flushPromises()

    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0]).toContain('시작시간과 종료시간을 모두 입력')
    expect(wrapper.vm.$.setupState.weekdayEditor.open, '입력을 보존하려면 열려 있어야 한다').toBe(true)
  })

  it('★종료만 입력해도 똑같이 막힌다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '', end: '18:00' } })

    expect(state.commitWeekdayEditor()).toBe(false)
    await flushPromises()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
  })

  it('★휴게시간도 한쪽만 입력하면 막힌다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {
      WORK: { start: '09:00', end: '18:00' },
      LUNCH: { start: '13:00', end: '' },
    })

    expect(state.commitWeekdayEditor()).toBe(false)
    await flushPromises()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
  })

  it('시작·종료를 모두 채우면 정상 커밋된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '10:00', end: '17:00' } })

    expect(state.commitWeekdayEditor()).toBe(true)
    await flushPromises()

    expect(dialogMock.alert).not.toHaveBeenCalled()
    expect(wrapper.vm.$.setupState.weekdayEditor.open).toBe(false)
  })

  it('둘 다 비운 것은 막지 않는다 — 그 요일 휴무이라는 정상 의사 표현', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {})

    expect(state.commitWeekdayEditor()).toBe(true)
    await flushPromises()
    expect(dialogMock.alert).not.toHaveBeenCalled()
  })
})

describe('운영시간 입력 완결성 — 저장 최종 가드', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctorIds: [11] }] } },
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

  it('X 버튼으로 통째로 비운 요일은 휴무이라 저장을 막지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.clearStaffWorkHours(11, MONDAY)
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

describe('미완성 입력 하이라이트 — popover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('★닫기를 시도한 뒤에만 비어 있는 칸을 가리킨다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    // 입력 중(시도 전)에는 그리지 않는다
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(false)

    expect(state.commitWeekdayEditor()).toBe(false)
    await flushPromises()

    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start')).toBe(false)
  })

  it('휴게시간 행도 같은 규약으로 가리킨다 (진료 행은 멀쩡하면 그대로)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, {
      WORK: { start: '09:00', end: '18:00' },
      LUNCH: { start: '13:00', end: '' },
    })

    expect(state.commitWeekdayEditor()).toBe(false)
    await flushPromises()

    expect(state.editorSlotInvalid(state.weekdayEditor, 'LUNCH', 'end')).toBe(true)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'start')).toBe(false)
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(false)
  })

  it('editor 를 새로 열면 하이라이트는 꺼진 상태로 시작한다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })
    state.commitWeekdayEditor()
    await flushPromises()
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(true)

    // 좌표 계산 없이 여는 헬퍼는 tried 를 남기므로, 실제 open 경로와 같게 초기화되는지 본다
    state.weekdayEditor.tried = false
    expect(state.editorSlotInvalid(state.weekdayEditor, 'WORK', 'end')).toBe(false)
  })

  /**
   * ★무한 반복 회귀 (2026-08-03).
   *
   * 안내 다이얼로그는 popover 바깥(모달)에 그려지므로 [확인] 클릭이 document 까지 올라온다.
   * handleDocumentClick 이 그때 commit 을 다시 돌리면 → 여전히 미완성 → 안내 재노출 → 무한 반복이 되고,
   * 사용자는 입력칸에 손도 대지 못한다. dialogBusy 가드가 그 경로를 끊는다.
   */
  it('★안내가 떠 있는 동안 document 클릭이 들어와도 안내가 겹쳐 뜨지 않는다', async () => {
    let releaseAlert: () => void = () => {}
    dialogMock.alert.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseAlert = () => resolve() }),
    )

    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    expect(state.commitWeekdayEditor(), '미완성이라 커밋되지 않는다').toBe(false)
    await wrapper.vm.$nextTick()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)

    // 안내의 [확인] 클릭이 document 로 전파되는 상황을 그대로 재현
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(dialogMock.alert, '안내는 한 번만').toHaveBeenCalledTimes(1)
    expect(state.weekdayEditor.open, '입력은 그대로 붙잡혀 있다').toBe(true)

    releaseAlert()
    await flushPromises()
  })

  it('안내를 닫은 뒤 외부 클릭은 정상적으로 다시 커밋을 시도한다 (가드가 영구히 막지 않는다)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    openWeekdayDraft(state, { WORK: { start: '09:00', end: '' } })

    expect(state.commitWeekdayEditor()).toBe(false)
    await flushPromises()          // 기본 mock 은 즉시 resolve → dialogBusy 해제
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(dialogMock.alert, '가드가 풀린 뒤에는 다시 안내한다').toHaveBeenCalledTimes(2)
  })
})
