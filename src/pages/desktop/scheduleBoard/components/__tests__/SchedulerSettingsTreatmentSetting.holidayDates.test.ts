/**
 * @vitest-environment happy-dom
 *
 * 공휴일 날짜의 특정일자 취급 — **원천(사업장 설정)이 가진 일자별 행을 숨기지 않는다.**
 *
 * 사업장 설정는 공휴일 정책을 두 군데에 쓴다:
 *   공휴일 진료 플래그             → 공휴일 체크박스 (정책 플래그)
 *   일자별 운영시간 테이블      → 그 정책을 개별 일자로 전개한 행들
 *
 * 이 앱은 이 둘을 각각 그대로 신뢰한다 — 체크박스는 플래그에서, 특정일자는 일자별 행의
 * OFF_DAY_YN 에서 읽는다. 예전에는 공휴일 날짜를 특정일자에서 걸러냈는데, 일자별 운영시간이
 * **전체 치환**이라 걸러낸 날짜가 저장 payload 에서도 빠져 **사업장 설정 공휴일 행이 저장할
 * 때마다 통삭제**됐다. 조회(applyOffRulesBaseline)는 걸러내지 않았으므로 저장 쪽이 어긋난 것이었다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

// ── 외부 의존 stub ──────────────────────────────────────────
const dialogMock = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => dialogMock,
}))
vi.mock('notivue', () => ({
  push: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

/** 국가 공휴일 — 광복절 · 개천절 · 신정(다음 해) */
const HOLIDAYS = new Set(['2026-08-15', '2026-10-03', '2027-01-01'])
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({
    isHoliday: (key: string) => HOLIDAYS.has(key),
    ensureYears: vi.fn(async () => {}),
  }),
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

/** 08-14(일반 휴무) · 08-15(공휴일, 사업장 설정가 전개) · 2027-01-01(공휴일, 다음 해) */
const OFF_DATES = ['2026-08-14', '2026-08-15', '2027-01-01']

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

const state = (wrapper: any) => wrapper.vm.$.setupState

describe('공휴일 날짜의 특정일자 취급', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site             : [{ dayCd: 1, openHm: '0900', closeHm: '1800',
            lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null }],
          recurringOffRules: [],
          workDates        : [],
          offDates         : OFF_DATES,
          holidayClosedYn           : true,   // 공휴일 휴무
        },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: { code: 'succeed', payload: { staff: [], overrides: [] } },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('공휴일 날짜도 특정일자 칩으로 노출된다 (숨기지 않는다)', async () => {
    const keys = state(await mountSetting()).specificDates.map((r: any) => r.startKey)

    expect(keys).toEqual(OFF_DATES)
  })

  it('★저장 payload 에 공휴일 날짜가 그대로 실린다 — 빠지면 사업장 설정 행이 통삭제된다', async () => {
    const payload = state(await mountSetting()).buildPayload()

    expect(payload.offDates).toEqual(OFF_DATES)
  })

  it('공휴일과 일반 휴무일이 연속이어도 한 칩으로 묶지 않는다 (× 로 무엇이 지워지는지 보이도록)', async () => {
    const ranges = state(await mountSetting()).specificDates

    const aug = ranges.filter((r: any) => r.startKey.startsWith('2026-08'))
    expect(aug).toHaveLength(2)
    expect(aug[0]).toMatchObject({ startKey: '2026-08-14', endKey: '2026-08-14', isHoliday: false })
    expect(aug[1]).toMatchObject({ startKey: '2026-08-15', endKey: '2026-08-15', isHoliday: true })
  })

  /* ★연도가 아니라 **진료/휴무**으로 묶는다 (2026-08-03).
   * 종전에는 연도로 묶고 칩마다 "(휴무)"을 붙였는데, 정작 중요한 구분이 괄호 안에 묻혀 안 보였다. */
  it('진료/휴무로 묶여 구분선이 생긴다 — 휴무가 먼저', async () => {
    const groups = state(await mountSetting()).specificDatesByType

    expect(groups.map((g: any) => g.type)).toEqual(['OFF'])
    expect(groups.map((g: any) => g.label)).toEqual(['휴무'])
    expect(groups[0].ranges).toHaveLength(3)   // 08-14 · 08-15 · 2027-01-01 전부 휴무 지정
  })

  it('진료 지정이 섞이면 휴무 → 진료 순으로 두 그룹이 된다', async () => {
    const wrapper = await mountSetting()
    state(wrapper).dateOverrides = new Map([
      ['2026-08-14', 'OFF'],
      ['2026-08-20', 'WORK'],
    ])
    await wrapper.vm.$nextTick()

    const groups = state(wrapper).specificDatesByType
    expect(groups.map((g: any) => g.label)).toEqual(['휴무', '진료'])
    expect(groups[0].ranges[0].startKey).toBe('2026-08-14')
    expect(groups[1].ranges[0].startKey).toBe('2026-08-20')
  })

  it('칩 라벨에는 타입 접미어가 없다 — 그룹 헤더가 말해 준다', async () => {
    const wrapper = await mountSetting()
    state(wrapper).dateOverrides = new Map([['2026-08-14', 'OFF']])
    await wrapper.vm.$nextTick()

    expect(state(wrapper).specificDates[0].label).toBe('8월 14일')
  })

  it('★여러 해가 섞이면 칩에 연도를 붙인다 (어느 해인지 사라지면 안 된다)', async () => {
    // 기본 시드가 2026·2027 두 해다.
    const labels = state(await mountSetting()).specificDates.map((r: any) => r.label)

    expect(labels).toContain('2026년 8월 14일')
    expect(labels).toContain('2027년 1월 1일')
  })

  it('공휴일 칩을 지우면 그 날짜 override 가 제거된다 (삭제 허용)', async () => {
    const wrapper = await mountSetting()
    const holidayChip = state(wrapper).specificDates.find((r: any) => r.startKey === '2026-08-15')

    state(wrapper).removeSpecificRange(holidayChip)

    expect(state(wrapper).dateOverrides.has('2026-08-15')).toBe(false)
    expect(state(wrapper).dateOverrides.has('2026-08-14'), '옆 날짜는 남는다').toBe(true)
  })

  it('★공휴일 날짜도 달력에서 토글할 수 있다 — 임시진료 지정', async () => {
    const wrapper = await mountSetting()
    // 개천절: 공휴일 체크박스 ON 이라 기본은 휴무, override 는 없다
    expect(state(wrapper).isDisplayedOff(dayjs('2026-10-03')), '기본은 휴무').toBe(true)

    state(wrapper).toggleRangeOff('2026-10-03', '2026-10-03')

    expect(state(wrapper).dateOverrides.get('2026-10-03')).toBe('WORK')
    expect(state(wrapper).isDisplayedOff(dayjs('2026-10-03')), '지정한 것이 이긴다').toBe(false)
  })

  it('★우선순위 = 일자별 지정 > 공휴일 체크박스', async () => {
    const wrapper = await mountSetting()
    state(wrapper).dateOverrides.set('2027-01-01', 'WORK')

    expect(state(wrapper).includePublicHolidays, '공휴일 휴무 ON').toBe(true)
    expect(state(wrapper).isDisplayedOff(dayjs('2027-01-01'))).toBe(false)
  })
})
