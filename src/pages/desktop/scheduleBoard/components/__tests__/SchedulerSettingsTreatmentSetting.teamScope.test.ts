/**
 * @vitest-environment happy-dom
 *
 * 운영시간 조회 단위 — **직원 / 팀 / 사업장 셋**이다 (화면설계서 OSP_MD_APB033 §3-1).
 *
 * 팀은 오래 "목록을 묶는 머리글"일 뿐이었고, 팀을 눌러도 캘린더는 사업장 전체를 보여줬다.
 * 그래서 팀 단위로 운영시간을 훑을 방법이 없었다. 팀을 조회 단위로 올린 뒤 지켜야 할 것은 둘이다:
 *
 *   1. 팀 모드 캘린더에는 **그 팀 소속만** 나온다 — 팀 미소속(orphan)이 섞이면 조회 단위가 무의미해진다
 *   2. 라벨 판정(cascade)은 사업장 모드와 **완전히 같다** — 같은 날짜가 단위에 따라 다르게 보이면 안 된다
 *
 * 좌측 편집 패널은 팀 모드에서 펼치지 않는다. 운영시간 편집 대상은 직원·사업장뿐이라서다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

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
  useHolidayStore: () => ({
    isHoliday: () => false,
    ensureYears: vi.fn(async () => {}),
  }),
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
const MONDAY = 1
const SATURDAY = 6
const SOME_MONDAY = '2026-07-06'
/** 아무도 토요일 운영시간을 정하지 않았다 — 사업장 값을 따라야 하는 날 */
const SOME_SATURDAY = '2026-07-11'

/** 보철팀 2명 · 교정팀 1명 · 어느 팀에도 없는 1명(orphan) */
const A1 = 101 // 보철팀
const A2 = 102 // 보철팀
const B1 = 201 // 교정팀
const ORPHAN = 999

const TEAM_A = 1
const TEAM_B = 2

/** 사업장: 월 09:00~18:00 · 토 09:00~13:00 — 운영시간 미설정 직원이 따르게 되는 값 */
const siteRows = [
  {
    dayCd: MONDAY, openHm: '0900', closeHm: '1800',
    lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
  },
  {
    dayCd: SATURDAY, openHm: '0900', closeHm: '1300',
    lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
  },
]

/** 네 명 모두 월요일 운영시간을 각자 정해 둔다 — 라벨이 누구 것인지 구분되게 */
const staffRows = [
  { staffId: A1, staffName: '김의사', times: [{ dayCd: MONDAY, staffOpenHm: '0900', staffCloseHm: '1300' }] },
  { staffId: A2, staffName: '이직원', times: [{ dayCd: MONDAY, staffOpenHm: '0900', staffCloseHm: '1400' }] },
  { staffId: B1, staffName: '박의사', times: [{ dayCd: MONDAY, staffOpenHm: '1000', staffCloseHm: '1900' }] },
  { staffId: ORPHAN, staffName: '무소속', times: [{ dayCd: MONDAY, staffOpenHm: '0800', staffCloseHm: '1200' }] },
]

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** 지금 선택된 조회 단위로 계산한 셀 entries (기본은 월요일) */
function cellEntries(wrapper: any, dateKey = SOME_MONDAY): any[] {
  const state = wrapper.vm.$.setupState
  const owner = state.getCalendarOwner()
  const ids = state.getCalendarDoctorOrder(owner)
  return state.formatListEntries(ids, dayjs(dateKey), dateKey)
}

/** 그 셀에 나오는 직원 이름들 */
function cellNames(wrapper: any): string[] {
  return cellEntries(wrapper).map((e: any) => String(e.label).split(' ')[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())

  // 캘린더 셀은 이름을 staffStore.doctors 에서 찾는다 — 없으면 entry 자체가 만들어지지 않는다
  const staff = useStaffStore()
  staff.doctors.push(
    { id: `${A1}`, text: '김의사', staffId: A1 } as any,
    { id: `${A2}`, text: '이직원', staffId: A2 } as any,
    { id: `${B1}`, text: '박의사', staffId: B1 } as any,
    { id: `${ORPHAN}`, text: '무소속', staffId: ORPHAN } as any,
  )

  mocks.getTeams.mockResolvedValue({
    data: {
      code: 'succeed',
      payload: {
        teams: [
          {
            id     : TEAM_A,
            name   : '보철팀',
            doctors: [
              { staffId: A1, staffName: '김의사' },
              { staffId: A2, staffName: '이직원' },
            ],
          },
          {
            id     : TEAM_B,
            name   : '교정팀',
            doctors: [{ staffId: B1, staffName: '박의사' }],
          },
        ],
      },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code: 'succeed',
      payload: { site: siteRows, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: true },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({
    data: { code: 'succeed', payload: { staff: staffRows, overrides: [] } },
  })
  mocks.getUnassignedReservations.mockResolvedValue({ data: { code: 'succeed', payload: { assignable: false } } })
})

describe('운영시간 조회 단위 — 팀', () => {
  it('팀을 고르면 캘린더에 그 팀 소속만 나온다 (다른 팀·무소속 제외)', async () => {
    const wrapper = await mountSetting()
    wrapper.vm.$.setupState.toggleTreatmentExpansion(`team:${TEAM_A}`)
    await wrapper.vm.$nextTick()

    expect(cellNames(wrapper)).toEqual(['김의사', '이직원'])
  })

  it('다른 팀을 고르면 그 팀 소속으로 바뀐다', async () => {
    const wrapper = await mountSetting()
    wrapper.vm.$.setupState.toggleTreatmentExpansion(`team:${TEAM_B}`)
    await wrapper.vm.$nextTick()

    expect(cellNames(wrapper)).toEqual(['박의사'])
  })

  it('사업장 모드에는 팀 미소속(orphan)까지 전원이 나온다 — 팀 모드와 대비', async () => {
    const wrapper = await mountSetting()
    // 미선택 = 사업장 모드
    expect(cellNames(wrapper)).toEqual(['김의사', '이직원', '박의사', '무소속'])
  })

  it('라벨 판정은 사업장 모드와 같다 — 같은 날짜가 단위에 따라 달라지지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const institutionLabels: Record<string, string> = {}
    for (const e of state.formatListEntries(
      state.getCalendarDoctorOrder(state.getCalendarOwner()), dayjs(SOME_MONDAY), SOME_MONDAY,
    )) institutionLabels[e.staffId] = e.label

    state.toggleTreatmentExpansion(`team:${TEAM_A}`)
    await wrapper.vm.$nextTick()

    const owner = state.getCalendarOwner()
    for (const e of state.formatListEntries(
      state.getCalendarDoctorOrder(owner), dayjs(SOME_MONDAY), SOME_MONDAY,
    )) {
      expect(e.label, `${e.staffId} 라벨`).toBe(institutionLabels[e.staffId])
    }
  })

  it('팀 선택은 좌측 편집 패널을 펼치지 않는다 — 편집 대상은 직원·사업장뿐', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.toggleTreatmentExpansion(`team:${TEAM_A}`)
    await wrapper.vm.$nextTick()

    expect(state.expandedTreatmentKey).toBe(`team:${TEAM_A}`)
    expect(wrapper.find('.schedulerTreatmentSetting__hoursPanel').exists()).toBe(false)
  })

  it('직원을 고르면 캘린더 대상이 그 한 명이 된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.toggleTreatmentExpansion(`staff:${A1}`)
    await wrapper.vm.$nextTick()

    expect(state.getCalendarOwner().scope).toBe('STAFF')
    expect(cellNames(wrapper)).toEqual(['김의사'])
  })

  /* ── 미설정 요일의 사업장 폴백 ──────────────────────────────
   * 네 명 다 토요일 운영시간을 정한 적이 없다(= 미설정). 미설정은 휴무가 아니라
   * "사업장 운영시간을 따른다"는 뜻이라 캘린더에도 기관 시간이 나와야 한다.
   * 직원 단위만 이 cascade 를 안 타서, 같은 토요일이 사업장·팀 모드에서는 시간이 보이고
   * 직원 모드에서는 빈칸이던 결함이 있었다(운영시간 입력칸에는 이미 기관 값이 보이고 있었다). */
  it('직원 모드 — 미설정 요일에는 사업장 운영시간이 표기된다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.toggleTreatmentExpansion(`staff:${A1}`)
    await wrapper.vm.$nextTick()

    const entries = cellEntries(wrapper, SOME_SATURDAY)
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe('김의사 09:00 ~ 13:00')
    expect(entries[0].isOff).toBe(false)
  })

  it('미설정 요일 표기는 직원·팀·사업장 세 단위가 모두 같다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    const labelOf = (keyOrNull: string | null) => {
      state.expandedTreatmentKey = keyOrNull
      return cellEntries(wrapper, SOME_SATURDAY)
        .find((e: any) => e.staffId === A1)?.label
    }

    const asStaff = labelOf(`staff:${A1}`)
    const asTeam = labelOf(`team:${TEAM_A}`)
    const asInstitution = labelOf(null)

    expect(asStaff).toBe('김의사 09:00 ~ 13:00')
    expect(asTeam).toBe(asStaff)
    expect(asInstitution).toBe(asStaff)
  })

  it('없는 팀 키가 남아 있으면 사업장 모드로 떨어진다 — 빈 캘린더를 만들지 않는다', async () => {
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState
    state.toggleTreatmentExpansion('team:99999')
    await wrapper.vm.$nextTick()

    expect(state.getCalendarOwner().scope).toBe('INSTITUTION')
    expect(cellNames(wrapper)).toEqual(['김의사', '이직원', '박의사', '무소속'])
  })
})
