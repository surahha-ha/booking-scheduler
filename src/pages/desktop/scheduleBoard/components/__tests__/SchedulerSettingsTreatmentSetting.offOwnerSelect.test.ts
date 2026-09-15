/**
 * @vitest-environment happy-dom
 *
 * 휴무일 탭 — 선택 단위(사업장 / 담당자) (2026-08-20).
 *
 * 종전에는 팀 헤더 클릭이 `selectedTeamIds` 를 토글했는데, 그 값은 `is-active` 클래스 외에
 * **소비처가 없었다** — 눌리기만 하고 아무 일도 하지 않는 토글이었다. 우측 12개월 캘린더는
 * 늘 사업장 규칙만 그렸다.
 *
 * 이제 선택 단위는 `selectedOffOwner`('INSTITUTION' | 'STAFF:<id>') 하나이고,
 * **팀은 선택 단위가 아니다** — 휴무는 사업장과 담당자에만 붙는다(팀에는 붙지 않는다).
 * 운영시간 탭의 `expandedTreatmentKey` 와 키를 공유하지 않는다(그쪽은 팀도 선택 단위다).
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
const A1 = 101, A2 = 102
const B1 = 201
const TEAM_A = '1'
const TEAM_B = '2'

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())

  const staff = useStaffStore()
  staff.doctors.push(
    { id: `${A1}`, text: '김의사', staffId: A1 } as any,
    { id: `${A2}`, text: '이직원', staffId: A2 } as any,
    { id: `${B1}`, text: '박의사', staffId: B1 } as any,
  )

  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: {
        teams: [
          {
            id     : Number(TEAM_A),
            name   : '보철팀',
            doctors: [
              { staffId: A1, staffName: '김의사' },
              { staffId: A2, staffName: '이직원' },
            ],
          },
          {
            id     : Number(TEAM_B),
            name   : '교정팀',
            doctors: [{ staffId: B1, staffName: '박의사' }],
          },
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

describe('휴무일 탭 — 선택 단위', () => {
  it('처음에는 사업장이 선택돼 있다', async () => {
    const wrapper = await mountSetting()

    expect(wrapper.vm.$.setupState.selectedOffOwner).toBe('INSTITUTION')
  })

  it('담당자 칩을 클릭하면 그 담당자가 선택된다', async () => {
    const wrapper = await mountSetting()

    await wrapper.findAll('.schedulerTreatmentSetting__chip--selectable')[0].trigger('click')

    expect(wrapper.vm.$.setupState.selectedOffOwner).toBe(`STAFF:${A1}`)
  })

  it('사업장 헤더를 클릭하면 사업장으로 돌아온다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.selectOffOwner(`STAFF:${A1}`)

    await wrapper.find('.schedulerTreatmentSetting__sectionHeader--selectable').trigger('click')

    expect(state.selectedOffOwner).toBe('INSTITUTION')
  })

  it('★팀은 선택 단위가 아니다 — 팀 헤더에는 선택 동작이 없다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    await wrapper.findAll('.schedulerTreatmentSetting__teamHeader')[0].trigger('click')

    expect(state.selectedOffOwner, '팀을 눌러도 선택 대상은 바뀌지 않는다').toBe('INSTITUTION')
    expect(state.selectedTeamIds, '소비처 없던 죽은 토글은 제거됐다').toBeUndefined()
  })

  it('★선택한 담당자가 팀에서 빠지면 사업장 선택으로 되돌아간다 — 목록에 없는 대상을 계속 그리지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.selectOffOwner(`STAFF:${A2}`)

    state.teams = state.teams.map((t: any) =>
      t.id === TEAM_A ? { ...t, doctorIds: [A1] } : t)
    await flushPromises()

    expect(state.selectedOffOwner).toBe('INSTITUTION')
  })

  it('다른 담당자가 빠져도 선택은 유지된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.selectOffOwner(`STAFF:${A1}`)

    state.teams = state.teams.map((t: any) =>
      t.id === TEAM_B ? { ...t, doctorIds: [] } : t)
    await flushPromises()

    expect(state.selectedOffOwner).toBe(`STAFF:${A1}`)
  })
})
