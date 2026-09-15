/**
 * @vitest-environment happy-dom
 *
 * 팀 + 구성원 설정 — 구성원 picker 에서 "미지정" 은 보이지 않는다 (2026-08-28).
 *
 * "미지정" 은 사람이 아니라 사업장 설정 경유 예약의 담당의 자리표시자이고, BE 가 병원마다 담당자 원장에 1회 선등록한다.
 * 팀 구성원으로 배정되면 "미지정 예약"(= 원장에는 있으나 팀 멤버가 아닌 건)이라는 정의가 무너져
 * 미지정 데이터 설정이 대상을 잃는다. 그래서 목록에서 감춘다.
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
const A1 = 101          // 보철팀 구성원
const C1 = 301          // 어느 팀에도 없는 담당자
const UNASSIGNED = 999  // 원장에 선등록된 "미지정"
const TEAM_A = '1'

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
    { id: '김의사', text: '김의사', staffId: A1 } as any,
    { id: '미지정', text: '미지정', staffId: UNASSIGNED } as any,
    { id: '신입일', text: '신입일', staffId: C1 } as any,
  )

  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: {
        teams: [{
          id     : Number(TEAM_A),
          name   : '보철팀',
          doctors: [{ staffId: A1, staffName: '김의사' }],
        }],
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

describe('구성원 picker — "미지정" 제외', () => {
  it('구성원 설정을 열면 "미지정" 은 목록에 없고 나머지 담당자는 그대로 나온다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.openStaffPickerFor(TEAM_A, { top: 0, left: 0 })
    await wrapper.vm.$nextTick()

    const labels = wrapper.findAll('.schedulerTreatmentSetting__staffOption').map(b => b.text())
    expect(labels, '"미지정" 만 빠지고 나머지는 유지').toEqual(['김의사', '신입일'])
  })

  it('원장(staffStore.doctors)에는 "미지정" 이 그대로 남는다 — 목록에서만 감춘다', async () => {
    const wrapper = await mountSetting()
    const staff = useStaffStore()

    expect(staff.doctors.map(d => d.text)).toContain('미지정')
    expect(wrapper.vm.$.setupState.staffPickerDoctors.map((d: any) => d.text)).not.toContain('미지정')
  })

  it('이미 팀에 들어가 있던 "미지정" 은 저장에서 빠지지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    // 과거에 배정돼 팀 구성원으로 남아 있는 상태
    state.teams = [{ id: TEAM_A, name: '보철팀', doctorIds: [A1, UNASSIGNED] }]
    state.openStaffPickerFor(TEAM_A, { top: 0, left: 0 })
    await wrapper.vm.$nextTick()

    expect([...state.staffPicker.staged], 'picker 목록에 없어도 staged 에는 남는다').toEqual([A1, UNASSIGNED])

    state.confirmStaffPicker()
    expect(state.teams.find((t: any) => t.id === TEAM_A).doctorIds).toEqual([A1, UNASSIGNED])
  })
})
