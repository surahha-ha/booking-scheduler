/**
 * @vitest-environment happy-dom
 *
 * 휴무일 탭 — 팀 구성원 칩 드래그 재정렬 (2026-08-19).
 *
 * 핸들러·상태·스타일은 다 있었는데 `<li>` 에 `draggable="true"` 가 없어 dragstart 자체가
 * 발생하지 않았다(HTML5 DnD 는 이 속성 없이는 드래그가 시작되지 않는다). 그 한 줄을 채운 뒤,
 * 드래그가 "겉도는" 원인이던 두 규약을 담당자 순서 변경 팝업(SchedulerDoctorOrderPopup)에 맞췄다:
 *
 *   1. 삽입 위치 — 뺀 뒤의 배열에 targetIndex 로 그대로 꽂는다(= 잡은 자리로 간다).
 *      종전의 "target 앞에 삽입"(fromIndex<toIndex 일 때 -1 보정)은 아래로 끌 때 한 칸 덜 갔다.
 *   2. gap 위 dragover — 칩 사이 4px 여백에서 컨테이너 핸들러가 발동해 targetIndex 를 null("끝으로")로
 *      덮어쓰면 드롭 위치 표시가 드래그 내내 깜빡인다. 팀이 바뀔 때만 초기화한다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── 외부 의존 stub ──────────────────────────────────────────
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

// ── fixture ────────────────────────────────────────────────
const A1 = 101, A2 = 102, A3 = 103   // 보철팀 (순서: A1 → A2 → A3)
const B1 = 201                        // 교정팀
/* 서버는 팀 id 를 숫자로 주지만 hydrateFromServer 가 String(t.id) 로 담는다 — 화면 상태 기준은 문자열이다. */
const TEAM_A = '1'
const TEAM_B = '2'

/** getTeams 응답의 팀 구성원 — 컴포넌트는 staffId 만 doctorIds 로 옮긴다(이름은 staffStore 에서 찾는다) */
const members = (...nos: number[]) => nos.map(no => ({ staffId: no, staffName: `담당자${no}` }))

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** dragstart/dragover 가 받는 최소 이벤트 — preventDefault·stopPropagation·dataTransfer 만 쓴다 */
function dragEvent() {
  return {
    preventDefault : vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer   : { effectAllowed: '', dropEffect: '', setData: vi.fn() },
  }
}

/** 그 팀의 현재 구성원 순서 */
function memberIds(wrapper: any, teamId: string): number[] {
  return wrapper.vm.$.setupState.teams.find((t: any) => t.id === teamId).doctorIds
}

/** sourceIndex 칩을 잡아 targetIndex 칩 위에 떨어뜨린다 */
function dragChip(wrapper: any, teamId: string, sourceIndex: number, targetIndex: number) {
  const state = wrapper.vm.$.setupState
  const docId = memberIds(wrapper, teamId)[sourceIndex]
  state.onChipDragStart(dragEvent(), teamId, docId, sourceIndex)
  state.onChipDragOver(dragEvent(), teamId, targetIndex)
  state.onChipDrop(dragEvent(), teamId, targetIndex)
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())

  const staff = useStaffStore()
  staff.doctors.push(
    { id: `${A1}`, text: '김의사', staffId: A1 } as any,
    { id: `${A2}`, text: '이직원', staffId: A2 } as any,
    { id: `${A3}`, text: '최위생', staffId: A3 } as any,
    { id: `${B1}`, text: '박의사', staffId: B1 } as any,
  )

  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: {
        teams: [
          { id: Number(TEAM_A), name: '보철팀', doctors: members(A1, A2, A3) },
          { id: Number(TEAM_B), name: '교정팀', doctors: members(B1) },
        ],
      },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { site: [], recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: true },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({
    data: { code: 'succeed', payload: { staff: [], overrides: [] } },
  })
  mocks.getUnassignedReservations.mockResolvedValue({
    data: { code: 'succeed', payload: { assignable: false } },
  })
})

describe('팀 구성원 칩 — 드래그 재정렬', () => {
  /**
   * ★드래그 시작점이 칩 전체 → 핸들(≡+이름, 2026-08-20) → **≡ 그립만** 으로 좁혀졌다(2026-08-24).
   * 이름까지 draggable 이면 row 내부가 전부 드래그 존이 돼, 선택 클릭이
   * (몇 px 움직임에도 drag 로 해석되어) 가장자리 여백에서만 먹는다. 드롭 대상은 칩(li) 그대로다.
   */
  it('드래그는 ≡ 그립에서만 시작한다 — 칩·이름 영역에는 draggable 이 없다', async () => {
    const wrapper = await mountSetting()

    const chips = wrapper.findAll('.schedulerTreatmentSetting__chip--selectable')
    expect(chips.length, '휴무일 탭 팀 구성원 칩').toBeGreaterThan(0)
    for (const chip of chips) {
      expect(chip.attributes('draggable'), '칩 전체가 끌리면 선택 클릭과 겹친다').toBeUndefined()
    }

    const handles = wrapper.findAll('.schedulerTreatmentSetting__chipHandle')
    expect(handles.length, '칩마다 핸들이 하나씩 있어야 한다').toBe(chips.length)
    for (const handle of handles) {
      expect(handle.attributes('draggable'), '이름까지 끌리면 선택 클릭이 드래그로 샌다').toBeUndefined()
    }

    const grips = wrapper.findAll('.schedulerTreatmentSetting__chipHandleGrip')
    expect(grips.length, '칩마다 그립이 하나씩 있어야 한다').toBe(chips.length)
    for (const grip of grips) {
      expect(grip.attributes('draggable'), '그립이 없으면 dragstart 자체가 나지 않는다').toBe('true')
    }
  })

  it('★아래로 끌면 잡은 자리에 놓인다 — 한 칸 덜 가지 않는다', async () => {
    const wrapper = await mountSetting()

    dragChip(wrapper, TEAM_A, 0, 2)   // A1 을 맨 아래(A3 자리)로

    expect(memberIds(wrapper, TEAM_A)).toEqual([A2, A3, A1])
  })

  it('위로 끌면 그 자리에 놓인다', async () => {
    const wrapper = await mountSetting()

    dragChip(wrapper, TEAM_A, 2, 0)   // A3 를 맨 위로

    expect(memberIds(wrapper, TEAM_A)).toEqual([A3, A1, A2])
  })

  it('가운데로 끌면 그 자리에 놓인다', async () => {
    const wrapper = await mountSetting()

    dragChip(wrapper, TEAM_A, 0, 1)   // A1 을 A2 자리로

    expect(memberIds(wrapper, TEAM_A)).toEqual([A2, A1, A3])
  })

  it('제자리에 떨어뜨리면 순서가 그대로다', async () => {
    const wrapper = await mountSetting()

    dragChip(wrapper, TEAM_A, 1, 1)

    expect(memberIds(wrapper, TEAM_A)).toEqual([A1, A2, A3])
  })

  it('드롭 후 드래그 상태가 풀린다 — 강조가 남지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    dragChip(wrapper, TEAM_A, 0, 2)

    expect(state.chipDrag.active).toBe(false)
    expect(state.chipDrag.targetIndex).toBeNull()
  })

  it('★칩 사이 여백 위를 지나도 드롭 위치가 "끝으로" 튀지 않는다 (같은 팀)', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onChipDragStart(dragEvent(), TEAM_A, A1, 0)
    state.onChipDragOver(dragEvent(), TEAM_A, 1)       // A2 칩 위
    state.onChipListDragOver(dragEvent(), TEAM_A)      // 칩 사이 gap(컨테이너)

    expect(state.chipDrag.targetIndex, 'gap 이 대상 칩을 덮어쓰면 안 된다').toBe(1)
  })

  it('다른 팀 위로 넘어가면 드롭 위치는 그 팀의 끝으로 초기화된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onChipDragStart(dragEvent(), TEAM_A, A1, 0)
    state.onChipDragOver(dragEvent(), TEAM_A, 1)
    state.onChipListDragOver(dragEvent(), TEAM_B)

    expect(state.chipDrag.targetTeamId).toBe(TEAM_B)
    expect(state.chipDrag.targetIndex).toBeNull()
  })

  it('컨테이너에 떨어뜨리면 맨 끝으로 간다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.onChipDragStart(dragEvent(), TEAM_A, A1, 0)
    state.onChipListDragOver(dragEvent(), TEAM_A)
    state.onChipListDrop(dragEvent(), TEAM_A)

    expect(memberIds(wrapper, TEAM_A)).toEqual([A2, A3, A1])
  })
})

/**
 * 구성원이 0명인 팀 (2026-08-24).
 *
 * 칩 리스트는 자식이 없으면 높이가 0 이라 **드롭 대상이 되지 못한다** — 핸들러는 걸려 있는데
 * dragover 가 아예 일어나지 않아 "끌어다 놓아도 아무 일이 없는" 상태가 됐다.
 * 그래서 빈 팀에는 신규 팀 폼과 같은 안내 영역(memberArea)을 세우고, 클릭 배정과 드롭을 둘 다 받는다.
 *
 * 아래 테스트는 **핸들러 호출이 아니라 DOM 이벤트**로 검증한다 — 이번 결함은 핸들러 로직이 아니라
 * "그 핸들러가 닿는 요소가 화면에 없다" 였기 때문에, setupState 를 직접 부르면 통과해 버린다.
 */
describe('구성원이 없는 팀 — 배정 진입점', () => {
  const TEAM_C = '3'

  async function mountWithEmptyTeam() {
    mocks.getTeams.mockResolvedValue({
      data: {
        code   : 'succeed',
        payload: {
          teams: [
            { id: Number(TEAM_A), name: '보철팀', doctors: members(A1, A2, A3) },
            { id: Number(TEAM_C), name: '빈팀', doctors: [] },
          ],
        },
      },
    })
    return mountSetting()
  }

  /** 빈 팀 섹션의 안내 영역 (구성원이 있는 팀에는 없다) */
  function emptyArea(wrapper: any) {
    return wrapper.find('.schedulerTreatmentSetting__memberArea')
  }

  it('구성원이 0명이면 안내 영역이 서고, 칩 리스트는 그리지 않는다', async () => {
    const wrapper = await mountWithEmptyTeam()

    const area = emptyArea(wrapper)
    expect(area.exists(), '높이 0 인 빈 ul 만 있으면 겨냥할 자리가 없다').toBe(true)
    expect(area.text()).toContain('클릭하여 직원을 추가해주세요')

    /* 칩 리스트는 구성원이 있는 팀(보철팀) 것 하나뿐이어야 한다 */
    expect(wrapper.findAll('.schedulerTreatmentSetting__chipList--member').length).toBe(1)
  })

  it('안내 영역을 클릭하면 그 팀으로 구성원 picker 가 열린다', async () => {
    const wrapper = await mountWithEmptyTeam()

    await emptyArea(wrapper).trigger('click')

    const {staffPicker} = wrapper.vm.$.setupState
    expect(staffPicker.open, '빈 팀에 사람을 넣는 길이 ⋯ 메뉴뿐이면 찾기 어렵다').toBe(true)
    expect(staffPicker.teamId).toBe(TEAM_C)
  })

  it('★안내 영역에 드롭하면 빈 팀으로 이동한다 — 확인 후 반영', async () => {
    const wrapper = await mountWithEmptyTeam()
    const state = wrapper.vm.$.setupState

    state.onChipDragStart(dragEvent(), TEAM_A, A1, 0)
    await emptyArea(wrapper).trigger('dragover')
    await emptyArea(wrapper).trigger('drop')

    expect(state.confirmDialog, '팀 이동은 확인을 거친다').not.toBeNull()
    state.confirmDialog.onConfirm()

    expect(memberIds(wrapper, TEAM_C)).toEqual([A1])
    expect(memberIds(wrapper, TEAM_A)).toEqual([A2, A3])
  })

  it('★팀명 줄에 드롭해도 받는다 — 빈 팀에서 사람이 겨냥하는 곳이다', async () => {
    const wrapper = await mountWithEmptyTeam()
    const state = wrapper.vm.$.setupState

    /* 헤더는 팀 순서대로 렌더된다 — 두 번째가 빈 팀 */
    const header = wrapper.findAll('.schedulerTreatmentSetting__teamHeader')[1]

    state.onChipDragStart(dragEvent(), TEAM_A, A1, 0)
    await header.trigger('dragover')
    await header.trigger('drop')

    expect(state.confirmDialog).not.toBeNull()
    state.confirmDialog.onConfirm()

    expect(memberIds(wrapper, TEAM_C)).toEqual([A1])
  })
})
