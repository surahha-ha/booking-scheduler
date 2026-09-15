/**
 * @vitest-environment happy-dom
 *
 * 휴무일 탭 — 팀 배치 시점 상속(복사) (2026-08-24, 화면정의서 APB032/033 §4).
 *
 * "사업장 값은 첫 직원에게, 첫 직원 값은 다음 직원들에게 상속됨"은 런타임 참조가 아니라
 * **배치 시점 복사**다 — 새로 배치되는 직원만 받고, 이미 팀에 있던 직원은 덮어쓰지 않으며,
 * 복사본은 원본과 참조를 공유하지 않는다(한 명을 고치면 전원이 바뀌는 사고 방지).
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
const A1 = 101, A2 = 102          // 보철팀 (A1 = 첫 직원)
const C1 = 301, C2 = 302          // 어느 팀에도 없는 신규 배치 대상
const TEAM_A = '1'
const K = (no: number) => `STAFF:${no}`

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
    { id: `${C1}`, text: '신입일', staffId: C1 } as any,
    { id: `${C2}`, text: '신입이', staffId: C2 } as any,
  )

  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: {
        teams: [{
          id     : Number(TEAM_A),
          name   : '보철팀',
          doctors: [
            { staffId: A1, staffName: '김의사' },
            { staffId: A2, staffName: '이직원' },
          ],
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

/** picker 를 승인 상태로 만들어 confirm 을 부른다 */
function confirmPicker(state: any, teamId: string | null, staged: number[]) {
  state.staffPicker = { open: true, top: 0, left: 0, staged: new Set(staged), teamId }
  state.confirmStaffPicker()
}

describe('팀 배치 시점 상속(복사)', () => {
  it('신규 팀 생성 — 구성원 전원이 사업장 값(매주·매월·특정일자·공휴일)을 복사받는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.weekdayOffs = new Map([[1, new Set(['WEEKLY', 'MONTHLY_2'])]])
    state.dateOverrides = new Map([['2026-05-05', 'OFF']])
    state.includePublicHolidays = true

    state.editingTeam = { id: null, name: '신규팀' }
    confirmPicker(state, null, [C1, C2])

    for (const no of [C1, C2]) {
      expect(state.workingHoursByOwner.get(K(no))?.get(1), '기관 매주 → entry=[]').toEqual([])
      const monthly = state.staffMonthlyOffs.get(K(no))?.get(1)
      expect([...(monthly ?? [])], '기관 매월만 옮긴다 — WEEKLY 는 표현이 다르다').toEqual(['MONTHLY_2'])
      expect(state.workingHoursOverridesByOwner.get(K(no))?.get('2026-05-05'), '기관 특정일자 휴무').toEqual([])
      expect(state.staffHolidayOff.get(K(no)), '기관 공휴일 휴무(체크) → N').toBe('N')
    }
  })

  it('기존 팀에 추가 — 첫 직원 값을 복사받고, 기존 구성원은 덮어쓰지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.workingHoursByOwner = new Map([[K(A1), new Map([[5, []], [2, [{ kind: 'WORK', start: '10:00', end: '17:00' }]]])]])
    state.staffMonthlyOffs = new Map([[K(A1), new Map([[3, new Set(['MONTHLY_3'])]])]])
    state.staffHolidayOff = new Map([[K(A1), 'Y'], [K(A2), 'N']])

    confirmPicker(state, TEAM_A, [A1, A2, C1])

    expect(state.workingHoursByOwner.get(K(C1))?.get(5)).toEqual([])
    expect(state.workingHoursByOwner.get(K(C1))?.get(2)).toEqual([{ kind: 'WORK', start: '10:00', end: '17:00' }])
    expect([...(state.staffMonthlyOffs.get(K(C1))?.get(3) ?? [])]).toEqual(['MONTHLY_3'])
    expect(state.staffHolidayOff.get(K(C1))).toBe('Y')
    // 기존 구성원 A2 는 자기 값 유지
    expect(state.staffHolidayOff.get(K(A2)), '기존 구성원은 복사 대상이 아니다').toBe('N')
  })

  it('복사본은 원본과 참조를 공유하지 않는다 — 새 직원을 고쳐도 첫 직원이 안 바뀐다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const a1Blocks = [{ kind: 'WORK', start: '10:00', end: '17:00' }]
    state.workingHoursByOwner = new Map([[K(A1), new Map([[2, a1Blocks]])]])

    confirmPicker(state, TEAM_A, [A1, A2, C1])

    const copied = state.workingHoursByOwner.get(K(C1))!.get(2)!
    expect(copied).not.toBe(a1Blocks)
    copied[0].start = '08:00'
    expect(state.workingHoursByOwner.get(K(A1))!.get(2)![0].start, '원본 불변').toBe('10:00')
  })
})
