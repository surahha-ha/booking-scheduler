/**
 * @vitest-environment happy-dom
 *
 * 요일 3상태 표기 — **"휴무로 정함"과 "아직 안 정함"은 다르다**.
 *
 * 운영시간은 세 상태를 가진다:
 *   미설정 = 아직 정하지 않음 → 사업장 운영시간을 따른다
 *   진료   = 시작·종료를 정함
 *   휴무   = 명시적으로 쉬기로 정함
 *
 * 예전에는 이 셋을 두 가지 모양("시각 있음 / 없음")에 눌러 담았다. 그래서 캘린더 셀이
 * 미설정과 휴무를 구별하지 못했고, **사업장 운영시간을 못 불러온 것뿐인데 전원이 "(휴무)"**
 * 으로 표기됐다. 쉬기로 한 것과 모르는 것은 다르다 — 후자는 "(운영시간 없음)"이다.
 *
 * 상태를 나르는 규약은 BE 응답의 행 존재 여부다(SiteService.getStaffWorkHours):
 *   행 없음 = 미설정 / 행 + 시각 = 진료 / 행 + null = 휴무
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── 외부 의존 stub ──────────────────────────────────────────
const dialogMock = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
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

// ── fixture ────────────────────────────────────────────────
const DOC = 101
const MONDAY = 1
/** 조회 결과가 아니라 요일만 쓰는 캘린더 키 — override 가 없으므로 요일 설정이 답이 된다 */
const SOME_MONDAY = '2026-07-06'

/** 사업장: 월요일 09:00~18:00 진료 */
const siteRows = [{
  dayCd: MONDAY, openHm: '0900', closeHm: '1800',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}]

function staffResponse(times: Array<{ dayCd: number; staffOpenHm: string | null; staffCloseHm: string | null }>) {
  return {
    data: {
      code: 'succeed',
      payload: { staff: [{ staffId: DOC, staffName: '김의사', times }], overrides: [] },
    },
  }
}

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** 그 담당자의 캘린더 셀 라벨 — 3상태가 겉으로 드러나는 지점 */
function label(wrapper: any) {
  const entries = wrapper.vm.$.setupState.formatInstitutionEntries(MONDAY, false, SOME_MONDAY)
  const entry = entries.find((e: any) => e.staffId === DOC)
  expect(entry, '담당자 entry').toBeTruthy()
  return entry.label
}

describe('요일 3상태 표기 — 미설정 / 진료 / 휴무', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    // 캘린더 셀은 이름을 staffStore.doctors 에서 찾는다 — 없으면 entry 자체가 만들어지지 않는다
    useStaffStore().doctors.push({ id: `${DOC}`, text: '김의사', staffId: DOC })
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctorIds: [DOC] }] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: { code: 'succeed', payload: { site: siteRows, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: true } },
    })
    mocks.getStaffWorkHours.mockResolvedValue(staffResponse([]))
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('진료 — 담당자가 정한 시간이 그대로 표기된다', async () => {
    mocks.getStaffWorkHours.mockResolvedValue(
      staffResponse([{ dayCd: MONDAY, staffOpenHm: '1000', staffCloseHm: '1700' }]))

    expect(label(await mountSetting())).toBe('김의사 10:00 ~ 17:00')
  })

  it('미설정 — 정한 적이 없으면 사업장 운영시간으로 표기된다', async () => {
    mocks.getStaffWorkHours.mockResolvedValue(staffResponse([]))

    expect(label(await mountSetting())).toBe('김의사 09:00 ~ 18:00')
  })

  it('★휴무 — 쉬기로 정한 요일은 사업장 값으로 대체되지 않는다', async () => {
    // 행이 있고 시각만 null = "이 요일은 쉰다"는 확정된 답
    mocks.getStaffWorkHours.mockResolvedValue(
      staffResponse([{ dayCd: MONDAY, staffOpenHm: null, staffCloseHm: null }]))

    expect(label(await mountSetting())).toBe('김의사 (휴무)')
  })

  /**
   * ★이번 변경의 핵심. 사업장 운영시간을 못 불러오면 미설정 담당자를 채울 값이 없다.
   * 그렇다고 "휴무"이라고 단정하면 거짓말이다 — 쉬기로 한 적이 없다.
   */
  it('★미설정 + 사업장 운영시간 조회 실패 → "(휴무)" 이 아니라 "(운영시간 없음)"', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    mocks.getStaffWorkHours.mockResolvedValue(staffResponse([]))

    expect(label(await mountSetting())).toBe('김의사 (운영시간 없음)')
  })

  it('휴무로 정한 요일은 사업장 조회가 실패해도 그대로 "(휴무)"', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    mocks.getStaffWorkHours.mockResolvedValue(
      staffResponse([{ dayCd: MONDAY, staffOpenHm: null, staffCloseHm: null }]))

    expect(label(await mountSetting()), '휴무는 원천 장애와 무관하게 확정된 답이다').toBe('김의사 (휴무)')
  })

  it('화면에서 요일을 비우면(X) 즉시 휴무가 된다 — 기관 값으로 되돌아가지 않는다', async () => {
    mocks.getStaffWorkHours.mockResolvedValue(
      staffResponse([{ dayCd: MONDAY, staffOpenHm: '1000', staffCloseHm: '1700' }]))
    const wrapper = await mountSetting()

    wrapper.vm.$.setupState.clearStaffWorkHours(DOC, MONDAY)
    await wrapper.vm.$nextTick()

    expect(label(wrapper)).toBe('김의사 (휴무)')
  })
})

/**
 * 사업장 패널도 같은 규약을 따라야 한다 — 담당자만 3상태를 구별하면 두 표기가 어긋난다.
 *
 * 사업장은 휴무를 진료행이 아니라 **휴무일 탭의 매주 규칙(recurringOffRules WEEKLY)** 으로 표현한다.
 * 그래서 두 상태의 겉모습이 실제로 다르다: 휴무 요일은 요일버튼이 잠기고(disabled),
 * 미설정 요일은 버튼이 열려 있어 지금 정할 수 있다. 표기도 갈라야 한다.
 */
describe('사업장 운영시간 표기 — 휴무 vs 미설정', () => {
  const SUNDAY = 0
  const TUESDAY = 2

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore().doctors.push({ id: `${DOC}`, text: '김의사', staffId: DOC })
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { code: 'succeed', payload: { teams: [] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site              : siteRows,                                 // 월요일만 진료 — 나머지 요일은 행 없음(미설정)
          recurringOffRules : [{ dayCd: SUNDAY, repeatTy: 'WEEKLY' }],  // 일요일은 매주 휴무
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    mocks.getStaffWorkHours.mockResolvedValue(staffResponse([]))
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  /* 요일 7행만 — 표 맨 아래 공휴일 행(요일 축이 아닌 별도 한 세트)은 제외한다. */
  const WEEKDAY_ROWS =
      '.schedulerTreatmentSetting__hoursTable tbody tr:not(.schedulerTreatmentSetting__hoursTableHolidayRow)'

  /** 운영시간 탭에서 사업장을 펼친다 */
  async function openInstitution(wrapper: any) {
    wrapper.vm.$.setupState.activeLeftTab = 'WORKING_HOURS'
    wrapper.vm.$.setupState.toggleTreatmentExpansion('institution')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll(WEEKDAY_ROWS).length, '요일 7행').toBe(7)
    return wrapper
  }

  /** 그 요일 행의 값 셀 텍스트 — 요일 라벨(th) 은 빼고 본다 */
  function dayCellText(wrapper: any, weekday: number) {
    const row = wrapper.findAll(WEEKDAY_ROWS)[weekday]
    return row.findAll('td').map((td: any) => td.text()).join(' ').trim()
  }

  function weekdayBtn(wrapper: any, weekday: number) {
    return wrapper.findAll('.schedulerTreatmentSetting__hoursWeekdayBtn')[weekday]
  }

  it('진료 — 등록된 요일은 시간이 그대로 표기된다', async () => {
    const wrapper = await openInstitution(await mountSetting())

    expect(dayCellText(wrapper, MONDAY)).toContain('09:00~18:00')
  })

  it('휴무 — 매주 휴무 요일은 "휴무"으로 남는다(요일버튼도 잠긴다)', async () => {
    const wrapper = await openInstitution(await mountSetting())

    expect(dayCellText(wrapper, SUNDAY)).toBe('휴무')
    expect(weekdayBtn(wrapper, SUNDAY).attributes('disabled'), '휴무 요일은 편집 불가').toBeDefined()
  })

  /* ★2026-07-28 규약 변경 — 사업장 운영시간은 원천(사업장 설정)이 2상태(진료/휴무)다.
   * 행이 없거나 값이 없으면 원천이 그걸 휴무로 다루므로 앱 표기도 "휴무"으로 따라간다.
   * 단 (1) 표기만 따라갈 뿐 저장 때 휴무를 만들어 보내지는 않고, (2) 조회 실패는 예외다. */
  it('★미설정 — 정한 적 없는 요일도 원천을 따라 "휴무"으로 표기한다(요일버튼은 열려 있다)', async () => {
    const wrapper = await openInstitution(await mountSetting())

    expect(dayCellText(wrapper, TUESDAY)).toBe('휴무')
    expect(weekdayBtn(wrapper, TUESDAY).attributes('disabled'), '미설정 요일은 지금 정할 수 있다').toBeUndefined()
  })

  it('★미설정 요일은 표기만 휴무 — 저장 payload 에 휴무 규칙으로 나가지 않는다', async () => {
    const wrapper = await openInstitution(await mountSetting())

    const payload = wrapper.vm.$.setupState.buildPayload()
    // 일요일(원래 매주 휴무)만 남고, 미설정 요일(화요일 등)은 규칙으로 승격되지 않는다
    expect(payload.recurringOffRules).toEqual([{ dayCd: SUNDAY, repeatTy: 'WEEKLY', monthlyNth: null }])
    expect(payload.site.map((r: any) => r.dayCd), '미설정 요일은 진료행으로도 나가지 않는다')
        .not.toContain(TUESDAY)
  })

  it('사업장 운영시간이 하나도 없으면 전 요일 "휴무"', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site: [], recurringOffRules: [{ dayCd: SUNDAY, repeatTy: 'WEEKLY' }],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await openInstitution(await mountSetting())

    for (const w of [0, 1, 2, 3, 4, 5, 6]) {
      expect(dayCellText(wrapper, w), `요일 ${w}`).toBe('휴무')
    }
  })

  it('★조회 실패는 "휴무"이라 단정하지 않는다 — 장애를 전 요일 휴무로 오표기하면 안 된다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'failed', message: '일시적 서비스 접근 불가' } })
    const wrapper = await openInstitution(await mountSetting())

    for (const w of [0, 1, 2, 3, 4, 5, 6]) {
      expect(dayCellText(wrapper, w), `요일 ${w}`).toBe('운영시간 없음')
    }
  })
})
