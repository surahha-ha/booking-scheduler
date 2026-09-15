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
 * 으로 표기됐다. 쉬기로 한 것과 모르는 것은 다르다 — 후자는 표기하지 않는다(명세는
 * 운영하는 직원의 시간과 휴무 직원의 (휴무)만 정의한다).
 *
 * 상태를 나르는 규약은 BE 응답의 행 존재 여부다(SiteService.getStaffWorkHours):
 *   행 없음 = 미설정 / 행 + 시각 = 진료 / 행 + null = 휴무
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
  const entries = wrapper.vm.$.setupState.formatListEntries([DOC], dayjs(SOME_MONDAY), SOME_MONDAY)
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
    mocks.getTeams.mockResolvedValue({
      data: {
        code   : 'succeed',
        payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: DOC, staffName: '김의사' }] }] },
      },
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
   * ★사업장 운영시간을 못 불러오면 미설정 담당자를 채울 값이 없다.
   * 그렇다고 "휴무"이라고 단정하면 거짓말이다 — 쉬기로 한 적이 없다.
   * 화면정의서(§2-1)에 그 상태의 표기가 없으므로 entry 자체를 만들지 않는다
   * (조회 실패는 배너·저장차단이 따로 알린다).
   */
  it('★미설정 + 사업장 운영시간 조회 실패 → "(휴무)"으로 찍지 않고 표기하지 않는다', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    mocks.getStaffWorkHours.mockResolvedValue(staffResponse([]))

    const wrapper = await mountSetting()
    const entries = wrapper.vm.$.setupState.formatListEntries([DOC], dayjs(SOME_MONDAY), SOME_MONDAY)
    expect(entries.find((e: any) => e.staffId === DOC)).toBeUndefined()
  })

  it('휴무로 정한 요일은 사업장 조회가 실패해도 그대로 "(휴무)"', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    mocks.getStaffWorkHours.mockResolvedValue(
      staffResponse([{ dayCd: MONDAY, staffOpenHm: null, staffCloseHm: null }]))

    expect(label(await mountSetting()), '휴무는 원천 장애와 무관하게 확정된 답이다').toBe('김의사 (휴무)')
  })

  /* ★2026-08-20 규약 변경 — 운영시간 탭에서 시간을 비우는 것은 "미설정으로 되돌리기"다.
   * 휴무는 휴무일 탭이 정한다(탭 책임 분리). 종전의 × 버튼(= 그 요일 휴무)은 제거됐다. */
  it('화면에서 요일을 비우면 미설정으로 돌아간다 — 기관 값을 다시 따른다', async () => {
    mocks.getStaffWorkHours.mockResolvedValue(
      staffResponse([{ dayCd: MONDAY, staffOpenHm: '1000', staffCloseHm: '1700' }]))
    const wrapper = await mountSetting()

    wrapper.vm.$.setupState.setStaffWorkHours(DOC, MONDAY, 'start', '')
    wrapper.vm.$.setupState.setStaffWorkHours(DOC, MONDAY, 'end', '')
    await wrapper.vm.$nextTick()

    expect(label(wrapper)).toBe('김의사 09:00 ~ 18:00')
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
    mocks.getTeams.mockResolvedValue({
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

  /* ★규약 변경 — 종전에는 미설정 요일을 "휴무"로 **표기만** 하고 저장 때는
   * 아무것도 만들어 보내지 않았다. 그 조합이 구멍이었다: 원천에는 행이 남지 않아 미설정으로
   * 있는데, 자체 보드는 기본 운영시간(useSchedulerRules 의 DEFAULT_OPEN_DAILY)으로 그 요일을
   * 열어 예약을 받았다. 화면은 "휴무"라 말하면서 보드는 예약을 받는 상태였다.
   *
   * 지금은 반대 조합이다 — 표기는 아직 정하지 않았다는 뜻의 '-'(휴게시간과 같은 규약)로 두고,
   * 저장할 때 '매주 휴무'로 명시해 내보낸다. 원천(사업장 설정)이 "운영시간이 모두 없으면
   * 휴무"로 읽는 것과 같은 결론을 자체도 명시로 남기는 것이라, 두 시스템의 해석이 갈리지
   * 않는다. 무엇이 저장될지는 배너가 누르기 전에 알린다.
   * 조회 실패가 예외인 것은 종전과 같다 — 모르는 상태를 휴무로 굳히지 않는다. */
  it('★미설정 — 정한 적 없는 요일은 "-" 로 표기한다(요일버튼은 열려 있다)', async () => {
    const wrapper = await openInstitution(await mountSetting())

    expect(dayCellText(wrapper, TUESDAY), '운영시간·휴게시간 모두 미설정').toBe('운영시간 - 휴게시간1 -휴게시간2 -')
    expect(weekdayBtn(wrapper, TUESDAY).attributes('disabled'), '미설정 요일은 지금 정할 수 있다').toBeUndefined()
  })

  it('★미설정 요일은 저장할 때 "매주 휴무"으로 나간다 — 원천에 미설정으로 남겨 두지 않는다', async () => {
    const wrapper = await openInstitution(await mountSetting())

    const payload = wrapper.vm.$.setupState.buildPayload()
    /* 월요일만 진료행이 있으므로 나머지 6요일이 대상이다. 일요일은 원래 매주 휴무가라 그대로. */
    expect(payload.recurringOffRules).toEqual(
        [0, 2, 3, 4, 5, 6].map(dayCd => ({ dayCd, repeatTy: 'WEEKLY', monthlyNth: null })))
    expect(payload.site.map((r: any) => r.dayCd), '휴무가 된 요일은 진료행으로 나가지 않는다')
        .toEqual([MONDAY])
  })

  /* 휴무일 탭은 매주와 매월을 한 요일에 같이 두지 않는다(toggleOption — 매주를 켜면 매월을 비운다).
   * 자동 보정이 그 배타를 우회해 "매월 3번째" 위에 '매주'를 얹으면 사용자가 직접 고른 값이
   * 저장과 함께 사라진다. 매월 규칙이 있는 요일은 그대로 두고 배너에서도 뺀다(같은 computed). */
  it('★매월 n번째 휴무가 있는 요일은 운영시간이 없어도 "매주 휴무"으로 덮지 않는다', async () => {
    const WEDNESDAY = 3
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site              : siteRows,
          recurringOffRules : [
            { dayCd: SUNDAY, repeatTy: 'WEEKLY' },
            { dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth: 3 },   // 수요일은 매월 1·3번째만 휴무
            { dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth: 1 },
          ],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await openInstitution(await mountSetting())

    expect(wrapper.vm.$.setupState.missingTimeWeekdays, '수요일은 배너 대상에서 빠진다')
        .toEqual([2, 4, 5, 6])
    const wednesdayRules = wrapper.vm.$.setupState.buildPayload().recurringOffRules
        .filter((r: any) => r.dayCd === WEDNESDAY)
    expect(wednesdayRules, '수요일은 매월 규칙만 나간다 — 자동 매주가 끼지 않는다')
        .toEqual([
          { dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth: 1 },
          { dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth: 3 },
        ])

    /* 매월 n번째만 쉬는 요일은 나머지 주에 진료하므로 운영시간이 있어야 한다 — 자동 휴무 대상에서
     * 빠지는 대신 배너 둘째 줄이 그 요일을 따로 부르고, 저장은 게이트가 막는다. */
    expect(wrapper.vm.$.setupState.monthlyOnlyMissingTimeWeekdays, '수요일은 운영시간 필수 대상')
        .toEqual([WEDNESDAY])
    const lines = wrapper.findAll('.schedulerTreatmentSetting__missingTimeLine')
    expect(lines.length, '배너 두 줄 — 자동 휴무 안내 + 운영시간 필수 안내').toBe(2)
    /* 두 문장은 <br> 로 줄을 나눈다 — 안내 다이얼로그의 "\n" 과 같은 자리. <br> 앞뒤 텍스트를 각각 본다. */
    const br = lines[1].element.querySelector('br')
    expect(br, '줄바꿈').not.toBeNull()
    expect(lines[1].element.textContent!.replace(/\s+/g, ' ').trim())
        .toBe('수요일은 매월 1, 3번째 휴무가라 나머지 주에 진료합니다.운영시간을 입력해 주세요.')
    expect(br!.nextSibling!.textContent, '둘째 줄').toBe('운영시간을 입력해 주세요.')
    expect(lines[1].find('strong').text(), '몇 번째인지까지 말한다').toBe('수요일')
  })

  it('매월 1~5번째가 모두 선택된 요일은 매주와 같다 — 운영시간을 요구하지 않고 자동 휴무도 만들지 않는다', async () => {
    const WEDNESDAY = 3
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site              : siteRows,
          recurringOffRules : [
            { dayCd: SUNDAY, repeatTy: 'WEEKLY' },
            ...[1, 2, 3, 4, 5].map(monthlyNth => ({ dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth })),
          ],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await openInstitution(await mountSetting())

    expect(wrapper.vm.$.setupState.missingTimeWeekdays).toEqual([2, 4, 5, 6])
    expect(wrapper.vm.$.setupState.monthlyOnlyMissingTimeWeekdays, '다섯 개 전부면 쉬지 않는 주가 없다').toEqual([])
    expect(wrapper.findAll('.schedulerTreatmentSetting__missingTimeLine').length, '둘째 줄 없음').toBe(1)
    /* 같은 결과는 같게 보여야 한다 — 매주를 고른 일요일과 다섯 개를 고른 수요일이 운영시간 탭에서 구분되지 않는다 */
    expect(dayCellText(wrapper, WEDNESDAY), '매주와 같은 표기').toBe('휴무')
    expect(weekdayBtn(wrapper, WEDNESDAY).attributes('disabled'), '매주와 같은 잠금').toBeDefined()
    const wednesdayRules = wrapper.vm.$.setupState.buildPayload().recurringOffRules
        .filter((r: any) => r.dayCd === WEDNESDAY)
    expect(wednesdayRules, '저장 표현은 고른 대로 — 매주로 바꿔 쓰지 않는다')
        .toEqual([1, 2, 3, 4, 5].map(monthlyNth => ({ dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth })))
  })

  it('운영시간이 있는 요일에 매월 1~5번째를 전부 걸면 매주처럼 진료행이 나가지 않는다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site              : siteRows,                                 // 월요일 09:00~18:00
          recurringOffRules : [1, 2, 3, 4, 5].map(monthlyNth => ({ dayCd: MONDAY, repeatTy: 'MONTHLY', monthlyNth })),
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await openInstitution(await mountSetting())

    expect(dayCellText(wrapper, MONDAY), '시간이 있어도 휴무 규칙이 우선 — 매주와 같다').toBe('휴무')
    const payload = wrapper.vm.$.setupState.buildPayload()
    expect(payload.site.map((r: any) => r.dayCd), '매주 휴무 요일과 같은 규약(진료행 제외)').toEqual([])
    expect(payload.recurringOffRules.filter((r: any) => r.dayCd === MONDAY).length, '매월 다섯 행은 그대로').toBe(5)
  })

  /* 배너 둘째 줄(템플릿 v-for 조립)과 다이얼로그(문자열 함수)는 조립이 두 벌이라, 요일이 둘 이상일 때
   * 같은 문장을 내는지는 따로 고정해야 한다. 한 벌만 고치면 닫을 때와 저장할 때 다른 말을 하게 된다. */
  it('요일이 여럿이면 배너 둘째 줄과 다이얼로그가 같은 문장을 낸다', async () => {
    const WEDNESDAY = 3
    const FRIDAY = 5
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site              : siteRows,
          recurringOffRules : [
            { dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth: 3 },
            { dayCd: WEDNESDAY, repeatTy: 'MONTHLY', monthlyNth: 1 },
            { dayCd: FRIDAY, repeatTy: 'MONTHLY', monthlyNth: 2 },
          ],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await openInstitution(await mountSetting())
    const state = wrapper.vm.$.setupState

    expect(state.monthlyOnlyMissingTimeWeekdays).toEqual([WEDNESDAY, FRIDAY])
    const line = wrapper.findAll('.schedulerTreatmentSetting__missingTimeLine')[1]
    expect(line.element.textContent!.replace(/\s+/g, ' ').trim())
        .toBe('수요일은 매월 1, 3번째, 금요일은 매월 2번째 휴무가라 나머지 주에 진료합니다.운영시간을 입력해 주세요.')
    expect(line.findAll('strong').map((s: any) => s.text()), '요일마다 굵게').toEqual(['수요일', '금요일'])
    expect(state.monthlyTimeRequiredMsg([WEDNESDAY, FRIDAY]))
        .toBe('수요일은 매월 1, 3번째, 금요일은 매월 2번째 휴무가라 나머지 주에 진료합니다.\n운영시간을 입력해 주세요.')
  })

  it('담당자도 같다 — 매월 1~5번째 전부인 요일은 그 담당자 행에서 "휴무"으로 잠긴다', async () => {
    const WEDNESDAY = 3
    mocks.getStaffWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          staff: [{
            staffId: DOC, staffName: '김의사', times: [],
            monthlyOffRules: [1, 2, 3, 4, 5].map(monthlyNth => ({ dayCd: WEDNESDAY, monthlyNth })),
          }],
          overrides: [],
        },
      },
    })
    const wrapper = await mountSetting()
    const state = wrapper.vm.$.setupState

    expect(state.isWeekdayClosed(WEDNESDAY, `STAFF:${DOC}`), '다섯 개 전부 = 매주').toBe(true)
    expect(state.isWeekdayClosed(TUESDAY, `STAFF:${DOC}`), '규칙 없는 요일은 그대로').toBe(false)
  })

  it('배너가 저장될 요일을 미리 알린다 — payload 와 같은 값을 본다', async () => {
    const wrapper = await openInstitution(await mountSetting())

    expect(wrapper.vm.$.setupState.missingTimeWeekdays, '일요일은 이미 휴무가라 빠진다')
        .toEqual([2, 3, 4, 5, 6])
    const notice = wrapper.find('.schedulerTreatmentSetting__missingTimeNotice')
    /* 둘째 줄과 같은 자리에서 <br> 로 줄을 나눈다 */
    const br = notice.element.querySelector('br')
    expect(br, '줄바꿈').not.toBeNull()
    expect(notice.element.textContent!.replace(/\s+/g, ' ').trim())
        .toBe('운영시간이 없는 화, 수, 목, 금, 토요일은 저장하면 매주 휴무로 처리됩니다.운영시간을 입력해 주세요.')
    expect(br!.nextSibling!.textContent, '둘째 줄').toBe('운영시간을 입력해 주세요.')
    expect(notice.find('strong').text(), '요일은 굵게 강조한다').toBe('화, 수, 목, 금, 토요일')
  })

  /* 배너가 부르는 것은 **시작·종료가 둘 다 빈** 요일이다. 한쪽만 채운 요일은 쉬기로 한 것이 아니라
   * 채우다 만 것이고, 그 상태는 저장 자체가 미완성 게이트에 막힌다 — 배너가 그 요일까지 세면
   * 저장되지도 않을 '매주 휴무'을 예고하게 된다(같은 칸을 두 안내가 다르게 말한다). */
  it('★한쪽만 채운 요일은 배너 대상이 아니다 — 둘 다 비어야 자동 휴무 예고다', async () => {
    const wrapper = await openInstitution(await mountSetting())
    const state = wrapper.vm.$.setupState

    state.weekdayEditor.open = true
    state.weekdayEditor.ownerKey = 'INSTITUTION'
    state.weekdayEditor.weekday = TUESDAY
    state.weekdayEditor.draft = {
      WORK  : { start: '09:00', end: '' },   // 화요일 — 시작만 입력한 중간 상태
      LUNCH : { start: '', end: '' },
      DINNER: { start: '', end: '' },
    }
    state.commitWeekdayEditor()
    await wrapper.vm.$nextTick()

    expect(state.missingTimeWeekdays, '화요일은 빠지고 둘 다 빈 요일만 남는다').toEqual([3, 4, 5, 6])
    expect(wrapper.find('.schedulerTreatmentSetting__missingTimeNotice').find('strong').text())
        .toBe('수, 목, 금, 토요일')

    /* 예고에서 뺀 대신 저장은 미완성 게이트가 막는다 — 반쪽 값이 조용히 휴무로 저장되지 않는다 */
    await state.onSave()
    await flushPromises()
    expect(mocks.saveTreatmentSettings, '미완성 게이트가 먼저 막는다').not.toHaveBeenCalled()
  })

  it('사업장 운영시간이 하나도 없으면 매주 휴무인 일요일만 "휴무", 나머지는 "-"', async () => {
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

    expect(dayCellText(wrapper, SUNDAY), '휴무일 탭이 정한 요일만 휴무가다').toBe('휴무')
    for (const w of [1, 2, 3, 4, 5, 6]) {
      expect(dayCellText(wrapper, w), `요일 ${w}`).toBe('운영시간 - 휴게시간1 -휴게시간2 -')
    }
  })

  it('★조회 실패는 "휴무"이라 단정하지 않는다 — 장애를 전 요일 휴무로 오표기하면 안 된다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'failed', message: '일시적 서비스 접근 불가' } })
    const wrapper = await openInstitution(await mountSetting())

    for (const w of [0, 1, 2, 3, 4, 5, 6]) {
      expect(dayCellText(wrapper, w), `요일 ${w}`).toBe('운영시간 없음')
    }
  })

  /* 셀 표기('운영시간 없음')는 템플릿이 siteLoadFailed 로 직접 가르므로 위 테스트만으로는
   * missingTimeWeekdays 의 잠금 가드가 빠져도 그린이다. 장애를 "비어 있다"로 읽어 휴무로
   * 굳히지 않는다는 계약은 이 computed 와 배너에서 따로 고정한다. */
  it('★조회 실패면 자동 휴무 대상이 없다 — 배너도 뜨지 않고 payload 에 매주 휴무를 만들지 않는다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'failed', message: '일시적 서비스 접근 불가' } })
    const wrapper = await openInstitution(await mountSetting())

    expect(wrapper.vm.$.setupState.missingTimeWeekdays, '모르는 상태를 미설정으로 읽지 않는다').toEqual([])
    expect(wrapper.find('.schedulerTreatmentSetting__missingTimeNotice').exists(), '배너 없음').toBe(false)
    /* 바깥 겹: canSaveSite 가 사업장 설정 번들(recurringOffRules 포함)을 통째로 뺀다. 두 겹이 다 서야 한다. */
    expect(wrapper.vm.$.setupState.buildPayload().recurringOffRules, '사업장 설정 번들 자체가 실리지 않는다')
        .toBeUndefined()
  })
})
