/**
 * @vitest-environment happy-dom
 *
 * 운영시간 popover 위치 — 뷰포트 밖으로 나가지 않는다.
 *
 * 월 캘린더 오른쪽 끝 열(토)에서 직원 운영시간을 클릭하면 popover 가 화면 오른쪽으로 넘어가
 * 시간 입력칸에 손을 댈 수 없었다. 마지막 주 행에서는 같은 일이 아래쪽으로 일어난다.
 *
 * 규칙:
 *  - 편집 popover(요일 · 일자 지정) = 앵커 아래·왼쪽 정렬이 기본. 넘치면 가로는 앵커 오른쪽 끝에 맞춰
 *    뒤집고, 세로는 앵커 위로 뒤집는다.
 *  - 더보기 popover = 셀을 덮는 배치라 뒤집지 않고 뷰포트 안으로 밀기만 한다.
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

import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'
import { useStaffStore } from '@/stores/staffStore'

const VW = 1440
const VH = 900
const MARGIN = 8   // POPOVER_MARGIN
const GAP = 4      // POPOVER_GAP

/** 앵커 사각형 — DOMRect 중 쓰는 값만 */
function anchor(left: number, top: number, width = 120, height = 20) {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

async function mountSetting() {
  mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: { code: 'succeed', payload: { site: [], holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false } },
  })
  mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
  mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })

  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper.vm.$.setupState
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  useStaffStore()
  Object.defineProperty(window, 'innerWidth', { value: VW, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true })
})

describe('편집 popover — clampPopoverPos', () => {
  it('여유가 있으면 앵커 아래·왼쪽에 그대로 붙는다', async () => {
    const { clampPopoverPos } = await mountSetting()
    const a = anchor(300, 200)

    expect(clampPopoverPos(a, 320, 120)).toEqual({ top: a.bottom + GAP, left: a.left })
  })

  it('★오른쪽 끝 열이면 앵커 오른쪽 끝에 맞춰 뒤집어 화면 안에 들어온다', async () => {
    const { clampPopoverPos } = await mountSetting()
    const a = anchor(VW - 130, 200)   // 토요일 열 — 왼쪽 정렬하면 320px 이 화면 밖으로 나간다

    const pos = clampPopoverPos(a, 320, 120)

    expect(pos.left, '앵커 오른쪽 끝 기준으로 뒤집힌다').toBe(a.right - 320)
    expect(pos.left + 320, '오른쪽 여백 안').toBeLessThanOrEqual(VW - MARGIN)
    expect(pos.left).toBeGreaterThanOrEqual(MARGIN)
  })

  it('★아래 공간이 모자라면 앵커 위로 뒤집는다', async () => {
    const { clampPopoverPos } = await mountSetting()
    const a = anchor(300, VH - 40)    // 마지막 주 행

    const pos = clampPopoverPos(a, 320, 120)

    expect(pos.top, '앵커 위로 올라간다').toBe(a.top - 120 - GAP)
    expect(pos.top + 120).toBeLessThanOrEqual(VH - MARGIN)
  })

  it('popover 가 뷰포트보다 커도 왼쪽·위 여백 밖으로 나가지 않는다', async () => {
    const { clampPopoverPos } = await mountSetting()
    const pos = clampPopoverPos(anchor(10, 10), VW + 200, VH + 200)

    expect(pos.left).toBe(MARGIN)
    expect(pos.top).toBe(MARGIN)
  })
})

describe('더보기 popover — clampOverlayPos', () => {
  it('여유가 있으면 셀을 덮는 위치 그대로다 (아래로 내리지 않는다)', async () => {
    const { clampOverlayPos } = await mountSetting()
    const a = anchor(300, 200, 180, 100)

    expect(clampOverlayPos(a, 280, 360)).toEqual({ top: a.top, left: a.left })
  })

  it('★오른쪽 끝 셀이면 안으로 밀린다 (뒤집지 않는다)', async () => {
    const { clampOverlayPos } = await mountSetting()
    const a = anchor(VW - 130, 200, 120, 100)

    const pos = clampOverlayPos(a, 280, 360)

    expect(pos.left).toBe(VW - 280 - MARGIN)
    expect(pos.top, '세로는 셀 상단 유지').toBe(a.top)
  })
})
