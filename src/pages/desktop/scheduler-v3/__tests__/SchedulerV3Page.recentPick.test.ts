/**
 * @vitest-environment happy-dom
 *
 * SchedulerV3Page — 검색 드롭다운 pick(onRecentPick) 의 분기.
 *
 * pick 은 "그 카드를 화면에 데려온다" 한 동작인데 출발 상태에 따라 하는 일이 갈린다:
 *   ① 이미 그려진 카드 → 날짜·팀·재조회 없이 강조만
 *   ② 다른 날짜 → 날짜 이동(재조회 1회) + 의사 컬럼 정합(팀 전환·의사 필터 해제)
 *   ③ 진료장부에서 미래 항목 → 예약장부로 전환(진료장부는 과거~오늘만 표기)
 *   ④ 카드가 끝내 안 나타나면 5초 뒤 포기하고 그때부터 강조 5초
 *   ⑤ 기다리는 동안 사용자가 wheel 하면 즉시 포기(보고 있는 자리를 뺏지 않는다)
 * 세로 스크롤 계산 자체는 searchScrollFocus.test 가, 페이지 경계 밖 담당자 재고정(focusDoctorColumn)은
 * 컬럼 기하가 필요해 여기서 다루지 않는다.
 *
 * 기대값 출처: onRecentPick·requestScrollToCard 주석(SchedulerV3Page.vue) — 상수 SEARCH_*_MS 는 현행 고정.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

import { api, stubResizeObserver } from './v3PageHarness'
import SchedulerV3Page from '@/pages/desktop/scheduler-v3/SchedulerV3Page.vue'
// 하네스가 스텁으로 바꾼 검색필터 — shallowMount 가 다시 감싸므로 이름이 아니라 컴포넌트 참조로 찾는다.
import SchedulerSearchFilter from '@/pages/desktop/scheduleBoard/components/SchedulerSearchFilter.vue'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import { useStaffStore } from '@/stores/staffStore'

const TODAY = '2030-03-06'
const DOCTOR = '김원장'
const APPT_ID = 501

function bookItem(id: number, ymd: string, staffName = DOCTOR) {
  return {
    reservationId: id, tenantId: 'C1', statusCode: '00',
    startAt: `${ymd}T10:00:00`, endAt: `${ymd}T10:30:00`,
    // 이름 모드 컬럼 키는 담당자 이름이다 — externalStaffNo 가 있으면 doctorId 가 그 번호로 채워져 컬럼과 어긋난다.
    externalStaffNo: null, staffName, customerId: 1, memberYn: 'N', customerPhone: '01000000000', customerName: '홍길동',
    delYn: 'N', memo: '',
  }
}

/** 드롭다운이 넘기는 최근 예약 항목 — 페이지는 reservationId·startAt·staffName 만 본다. */
function recentItem(id: number, ymd: string, staffName = DOCTOR) {
  return { reservationId: id, startAt: `${ymd}T10:00:00`, staffName }
}

async function mountPage() {
  const wrapper = shallowMount(SchedulerV3Page)
  await flushPromises()
  // happy-dom 은 폭이 0 이라 컬럼이 안 생긴다 — 보드 폭을 넣어 카드가 그려지게 한다.
  wrapper.vm.$.setupState.availableWidth = 1200
  await flushPromises()
  return wrapper
}

function pick(wrapper: ReturnType<typeof shallowMount>, item: ReturnType<typeof recentItem>) {
  wrapper.findComponent(SchedulerSearchFilter).vm.$emit('pick-recent', item)
}

const highlightOf = (wrapper: ReturnType<typeof shallowMount>) =>
  wrapper.vm.$.setupState.searchHighlightId as string | null

/** 페이지의 디바운스(150ms)·대기 상한을 지나며 마이크로태스크를 비운다. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

describe('SchedulerV3Page — 검색 pick', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubResizeObserver()
    // flushPromises 는 setImmediate 를 쓴다 — 그것까지 가짜로 만들면 flush 가 멈춘다.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(dayjs(TODAY).toDate())
    api.getDoctors.mockResolvedValue({ data: { code: 'succeed', payload: [{ staffName: DOCTOR, staffId: 1, openYn: 'Y' }] } })
    api.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    api.get.mockResolvedValue({ data: { code: 'succeed', payload: [] } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('① 이미 그려진 카드는 날짜·팀·재조회 없이 강조만 한다', async () => {
    api.get.mockResolvedValue({ data: { code: 'succeed', payload: [{ dayCd: 'WED', dayNm: '수', items: [bookItem(APPT_ID, TODAY)] }] } })
    const wrapper = await mountPage()
    await advance(200)
    const rendered = (wrapper.vm.$.setupState.rects as { id: unknown }[]).some(r => String(r.id) === String(APPT_ID))
    expect(rendered, '전제: 카드가 그려져 있다').toBe(true)

    const filter = useSchedulerFilterStore()
    const before = { version: filter.searchVersion, date: filter.periodDate, team: filter.selectedTeamName }
    pick(wrapper, recentItem(APPT_ID, TODAY))
    await advance(200)

    expect(filter.searchVersion).toBe(before.version)
    expect(filter.periodDate).toEqual(before.date)
    expect(filter.selectedTeamName).toBe(before.team)
    expect(highlightOf(wrapper)).toBe(String(APPT_ID))
  })

  it('② 다른 날짜 항목은 그 날짜로 옮기고 재조회는 한 번이다', async () => {
    const wrapper = await mountPage()
    await advance(200)
    const filter = useSchedulerFilterStore()
    const before = filter.searchVersion
    const target = dayjs(TODAY).add(3, 'day').format('YYYY-MM-DD')

    pick(wrapper, recentItem(777, target))
    await advance(200)

    expect(dayjs(filter.periodDate).format('YYYY-MM-DD')).toBe(target)
    expect(filter.searchVersion).toBe(before + 1)
    expect(filter.doctors, '의사 개별 필터는 전체로').toEqual([])
    expect(highlightOf(wrapper)).toBe('777')
  })

  it('② 팀 소속 담당자의 항목이면 그 팀으로 전환한다(미소속이면 미지정 null)', async () => {
    api.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [
      { id: 1, name: '교정팀', doctors: [{ staffId: 1, staffName: DOCTOR }] },
    ] } } })
    const wrapper = await mountPage()
    await advance(200)
    await useStaffStore().loadTeams() // 팀 목록은 검색필터(스텁)가 불러오므로 여기서 직접
    const filter = useSchedulerFilterStore()
    const target = dayjs(TODAY).add(3, 'day').format('YYYY-MM-DD')

    pick(wrapper, recentItem(777, target, DOCTOR))
    await advance(200)
    expect(filter.selectedTeamName).toBe('교정팀')

    pick(wrapper, recentItem(778, target, '박원장'))
    await advance(200)
    expect(filter.selectedTeamName, '어느 팀에도 없으면 미지정').toBeNull()
  })

  it('③ 진료장부에서 미래 항목을 고르면 예약장부로 전환한다', async () => {
    const wrapper = await mountPage()
    await advance(200)
    const filter = useSchedulerFilterStore()
    filter.setDataType('TREATMENT', false)

    pick(wrapper, recentItem(777, dayjs(TODAY).add(3, 'day').format('YYYY-MM-DD')))
    await advance(200)

    expect(filter.dataType).toBe('APPOINTMENT')
  })

  it('③ 진료장부에서 과거 항목은 진료장부에 머문다', async () => {
    const wrapper = await mountPage()
    await advance(200)
    const filter = useSchedulerFilterStore()
    filter.setDataType('TREATMENT', false)

    pick(wrapper, recentItem(777, dayjs(TODAY).subtract(3, 'day').format('YYYY-MM-DD')))
    await advance(200)

    expect(filter.dataType).toBe('TREATMENT')
  })

  it('④ 카드가 끝내 안 나타나면 5초 뒤 포기하고 그때부터 강조 5초를 센다', async () => {
    const wrapper = await mountPage()
    await advance(200)

    pick(wrapper, recentItem(999, dayjs(TODAY).add(3, 'day').format('YYYY-MM-DD')))
    await advance(200)
    expect(highlightOf(wrapper)).toBe('999')

    // pick 뒤 t=0.2s. 대기 상한은 t=5.0s 에 포기 → 강조는 거기서부터 5s → t=10.0s 해제.
    await advance(4_600) // t=4.8s — 아직 기다리는 중
    expect(highlightOf(wrapper), '대기 상한 전').toBe('999')
    await advance(5_000) // t=9.8s — 포기 뒤 강조 중(pick 시점에서 5s 를 셌다면 이미 꺼졌을 시각)
    expect(highlightOf(wrapper), '강조는 포기 시점부터 센다').toBe('999')
    await advance(400) // t=10.2s
    expect(highlightOf(wrapper)).toBeNull()
  })

  it('⑤ 기다리는 동안 wheel 하면 즉시 포기하고 강조 5초를 센다', async () => {
    const wrapper = await mountPage()
    await advance(200)

    pick(wrapper, recentItem(999, dayjs(TODAY).add(3, 'day').format('YYYY-MM-DD')))
    await advance(200)
    window.dispatchEvent(new Event('wheel'))

    await advance(4_900)
    expect(highlightOf(wrapper), 'wheel 뒤 5s 안이면 아직 강조').toBe('999')
    await advance(300)
    expect(highlightOf(wrapper), 'wheel 이 없었다면 아직 대기 중일 시점').toBeNull()
  })
})
