/**
 * @vitest-environment happy-dom
 *
 * 사업장 **공휴일 운영시간** — 요일이 아닌 한 세트.
 *
 * 사업장 설정에 공휴일 전용 테이블(공휴일 운영시간 테이블)이 생기기 전에는, 공휴일 운영시간을
 * 담을 자리가 없어 사업장 설정가 **모든 공휴일 일자를 일자별 운영시간 행으로 전개**해 두었다.
 * 전용 테이블이 생기면서 전개가 사라졌고, 공휴일 운영시간은 사업장당 한 세트가 유일한 소스다.
 *
 * 두 값의 역할이 갈린다 — 섞으면 안 된다:
 *   holidayClosedYn(공휴일 체크박스) = 공휴일에 **쉬는가**
 *   holidayHours               = 진료한다면 **몇 시부터 몇 시까지인가**
 * 그래서 휴무로 바꿔도 시간 값은 지우지 않는다. 지우면 다시 진료로 되돌렸을 때 시간이 사라진다.
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
const MONDAY = 1

/** 사업장: 월요일 09:00~18:00 진료 */
const siteRows = [{
  dayCd: MONDAY, openHm: '0900', closeHm: '1800',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}]

/** 공휴일: 10:00~16:00 진료, 휴게1 12:00~13:00 */
const holidayHoursRow = {
  openHm: '1000', closeHm: '1600',
  lunchStartHm: '1200', lunchEndHm: '1300',
  dinnerStartHm: null, dinnerEndHm: null,
}

/** @param holidayClosedYn true = 공휴일 휴무 */
function siteResponse(holidayHours: unknown, holidayClosedYn: boolean) {
  return {
    data: {
      code: 'succeed',
      payload: { site: siteRows, holidayHours, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn },
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

/** 운영시간 탭에서 사업장을 펼친다 */
async function openInstitution(wrapper: any) {
  wrapper.vm.$.setupState.activeLeftTab = 'WORKING_HOURS'
  wrapper.vm.$.setupState.toggleTreatmentExpansion('institution')
  await wrapper.vm.$nextTick()
  return wrapper
}

const HOLIDAY_ROW = '.schedulerTreatmentSetting__hoursTableHolidayRow'

function holidayRowText(wrapper: any) {
  return wrapper.find(HOLIDAY_ROW).findAll('td').map((td: any) => td.text()).join(' ').trim()
}

/** 요일 버튼 목록의 맨 끝이 공휴일 버튼이다 */
function holidayBtn(wrapper: any) {
  const all = wrapper.findAll('.schedulerTreatmentSetting__hoursWeekdayBtn')
  return all[all.length - 1]
}

describe('사업장 공휴일 운영시간 — 표기', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: { code: 'succeed', payload: { staff: [], overrides: [] } },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('공휴일 진료 — 조회한 시간과 휴게가 그대로 표기된다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, false))
    const wrapper = await openInstitution(await mountSetting())

    const text = holidayRowText(wrapper)
    expect(text).toContain('10:00~16:00')
    expect(text).toContain('12:00~13:00')
  })

  it('공휴일 버튼은 마지막 칸에 있고, 진료면 열려 있다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, false))
    const wrapper = await openInstitution(await mountSetting())

    const btn = holidayBtn(wrapper)
    expect(btn.text()).toBe('공휴일')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('★공휴일 휴무(체크 ON)이면 "휴무"으로 표기되고 버튼이 잠긴다', async () => {
    // 시간이 등록돼 있어도 쉬기로 했으면 정할 이유가 없다 — 매주 휴무 요일과 같은 규약
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, true))
    const wrapper = await openInstitution(await mountSetting())

    expect(holidayRowText(wrapper)).toBe('휴무')
    expect(holidayBtn(wrapper).attributes('disabled')).toBeDefined()
  })

  it('★공휴일 진료인데 시간이 없으면 "미설정" — "휴무"이라 단정하지 않는다', async () => {
    // 쉬기로 한 적이 없다. 시간을 아직 안 정했을 뿐이다.
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(null, false))
    const wrapper = await openInstitution(await mountSetting())

    expect(holidayRowText(wrapper)).toBe('미설정')
  })

  it('조회 실패면 "운영시간 없음" — 장애를 휴무/미설정으로 단정하지 않는다', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await openInstitution(await mountSetting())

    expect(holidayRowText(wrapper)).toBe('운영시간 없음')
  })
})

describe('사업장 공휴일 운영시간 — 저장 payload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: { code: 'succeed', payload: { staff: [], overrides: [] } },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('조회한 공휴일 시간이 저장 payload 에 그대로 실린다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, false))
    const wrapper = await mountSetting()

    expect(wrapper.vm.$.setupState.buildPayload().holidayHours).toEqual(holidayHoursRow)
  })

  it('★공휴일 휴무가어도 시간 값은 payload 에 보존된다', async () => {
    // 지우고 보내면, 다시 진료로 되돌렸을 때 사업장 설정에서 시간이 사라져 있다.
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, true))
    const wrapper = await mountSetting()

    const payload = wrapper.vm.$.setupState.buildPayload()
    expect(payload.holidayClosedYn, '휴무 플래그는 그대로').toBe(true)
    expect(payload.holidayHours, '시간은 보존').toEqual(holidayHoursRow)
  })

  /**
   * ★null 을 보내면 BE 가 "미전송 = baseline 보존"으로 읽어 지운 값이 되살아난다 — 삭제할 방법이 없어진다.
   * 전 필드 null 객체는 BE buildHolidayRows 가 빈 목록으로 바꿔 사업장 설정에 전체 교체(=전삭제)로 내보낸다.
   */
  const EMPTY_HOLIDAY = {
    openHm: null, closeHm: null,
    lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
  }

  it('공휴일 시간이 미설정이면 전 필드 null 객체로 나간다 (null 아님)', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(null, false))
    const wrapper = await mountSetting()

    expect(wrapper.vm.$.setupState.buildPayload().holidayHours).toEqual(EMPTY_HOLIDAY)
  })

  it('★설정돼 있던 공휴일 시간을 비우면 삭제 의도로 나간다 (되살아나지 않는다)', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, false))
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.weekdayEditor.ownerKey = state.HOLIDAY_OWNER
    state.weekdayEditor.weekday = state.HOLIDAY_SLOT
    state.weekdayEditor.draft = {
      WORK  : { start: '', end: '' },
      LUNCH : { start: '', end: '' },
      DINNER: { start: '', end: '' },
    }
    state.commitWeekdayEditor()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.$.setupState.buildPayload().holidayHours).toEqual(EMPTY_HOLIDAY)
  })

  /**
   * ★회귀 방지. 공휴일을 institutionWeeklyDayMap 에 특수 키로 섞으면, 그 Map 을 요일로 순회하는
   * buildInstitutionTimesPayload 가 공휴일을 요일 행으로 실어 보낸다(엉뚱한 dayCd).
   * 그래서 공휴일은 별도 상태(institutionHolidayDayMap)로 둔다.
   */
  it('★공휴일 시간이 요일별 site[] 를 오염시키지 않는다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, false))
    const wrapper = await mountSetting()

    const site = wrapper.vm.$.setupState.buildPayload().site
    expect(site.map((r: any) => r.dayCd), '월요일 한 행뿐').toEqual([MONDAY])
    expect(site[0].openHm, '공휴일 시간이 요일 행에 새어들지 않았다').toBe('0900')
  })

  it('편집한 공휴일 시간이 payload 에 반영된다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, false))
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    // popover 를 거치지 않고 commit 경로만 태운다(편집기 좌표 계산은 이 테스트의 관심사가 아니다)
    state.weekdayEditor.ownerKey = state.HOLIDAY_OWNER
    state.weekdayEditor.weekday = state.HOLIDAY_SLOT
    state.weekdayEditor.draft = {
      WORK  : { start: '11:00', end: '15:00' },
      LUNCH : { start: '', end: '' },
      DINNER: { start: '', end: '' },
    }
    state.commitWeekdayEditor()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.$.setupState.buildPayload().holidayHours).toEqual({
      openHm: '1100', closeHm: '1500',
      lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
    })
  })
})

/**
 * ★공휴일 진료로 저장하려면 공휴일 운영시간이 있어야 한다 (2026-08-03).
 *
 * 공휴일 운영시간(공휴일 운영시간 테이블)은 시작·종료시분이 NOT NULL 이라 "시간 없는 공휴일 운영시간"
 * 행 자체가 저장될 수 없다. 시간을 비운 채 진료로 저장하면 사업장 설정·예약장부 양쪽에서 그날은
 * 휴무로 판정되므로, "진료함으로 설정했는데 실제로는 쉰다"는 상태가 조용히 만들어진다.
 */
describe('사업장 공휴일 운영시간 — 저장 가드', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    useStaffStore()
    mocks.getTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: { code: 'succeed', payload: { staff: [], overrides: [] } },
    })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', message: '저장되었습니다.' } })
  })

  it('★공휴일 진료로 바꿨는데 시간이 비어 있으면 저장하지 않고 안내한다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(null, true)) // 휴무 + 시간 미설정
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.includePublicHolidays = false // 공휴일 진료로 전환 → site 가 dirty
    await wrapper.vm.$nextTick()
    await state.onSave()

    expect(mocks.saveTreatmentSettings, '저장이 나가지 않는다').not.toHaveBeenCalled()
    expect(dialogMock.alert, '어디를 고칠지 안내한다').toHaveBeenCalled()
  })

  it('안내와 함께 운영시간 탭 + 사업장 패널을 펼친다 (접힌 곳은 보이지 않는다)', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(null, true))
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.includePublicHolidays = false
    await wrapper.vm.$nextTick()
    await state.onSave()

    expect(wrapper.vm.$.setupState.activeLeftTab).toBe('WORKING_HOURS')
    expect(wrapper.vm.$.setupState.expandedTreatmentKey).toBe('institution')
  })

  it('공휴일 시간이 설정돼 있으면 그대로 저장된다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(holidayHoursRow, true))
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.includePublicHolidays = false
    await wrapper.vm.$nextTick()
    await state.onSave()

    expect(mocks.saveTreatmentSettings).toHaveBeenCalled()
  })

  it('★공휴일 휴무(체크 ON)으로 저장할 때는 시간이 없어도 막지 않는다', async () => {
    // 쉬기로 했으면 운영시간을 정할 이유가 없다. 가드는 "진료함"일 때만이다.
    mocks.getSiteWorkHours.mockResolvedValue(siteResponse(null, false)) // 진료 + 시간 미설정
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    state.includePublicHolidays = true // 휴무로 전환
    await wrapper.vm.$nextTick()
    await state.onSave()

    expect(mocks.saveTreatmentSettings).toHaveBeenCalled()
  })
})
