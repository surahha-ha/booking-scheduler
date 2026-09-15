/**
 * @vitest-environment happy-dom
 *
 * SchedulerV3Page — 상태 칩·회원 숫자는 화면에 그려진 카드 수와 같다.
 *
 * 신고(2026-09-08): 화면은 9/7~9/9 인데 조회 창은 9/7~9/10 이라, 9/10 예약이 카드는 없이 숫자에만 떴다.
 * BE 집계는 창(SQL 모수)을 세고 카드는 레이아웃(화면)을 그려 둘이 같아질 수 없었다 → 숫자를 카드에서 센다.
 *
 * 고정하는 계약:
 *   ① 전체 숫자 = 그려진 카드(rects) 수. 창 안이지만 화면 밖 날짜의 예약은 세지 않는다
 *   ② 예약장부의 완료(01)는 카드가 '예약'으로 그려지므로 '예약' 숫자에 든다
 *   ③ 상태 필터는 재조회 없이 화면에서 걸리고, 켠 상태의 숫자 = 그려진 카드 수, 숨긴 상태의 숫자는 남는다
 *   ④ 날짜를 옮기면 목록·컬럼이 바뀌고 숫자도 그 화면의 카드로 바뀐다
 *   ⑤ 숫자는 검색필터 컴포넌트에 props 로 흘러간다
 *
 * 기대값 출처: 사용자 요구("화면에 보여지는 예약건수와 동일하게") + boardStatistics.ts 주석.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

import { api, stubResizeObserver } from './v3PageHarness'
import SchedulerV3Page from '@/pages/desktop/scheduler-v3/SchedulerV3Page.vue'
import SchedulerSearchFilter from '@/pages/desktop/scheduleBoard/components/SchedulerSearchFilter.vue'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'

const TODAY = '2030-03-06'
const DOCTOR = '김대표'
const FAR = dayjs(TODAY).add(9, 'day').format('YYYY-MM-DD') // 창 안(담당자 1명이면 창은 전체칸+4 일 이상) · 화면 밖

function bookItem(id: number, ymd: string, status: string, memberYn = 'N', hour = 10) {
  const hh = String(hour).padStart(2, '0')
  return {
    reservationId: id, tenantId: 'C1', statusCode: status,
    startAt: `${ymd}T${hh}:00:00`, endAt: `${ymd}T${hh}:30:00`,
    // 이름 모드 컬럼 키는 담당자 이름 — externalStaffNo 가 있으면 doctorId 가 그 번호가 되어 컬럼과 어긋난다.
    externalStaffNo: null, staffName: DOCTOR, customerId: id, memberYn, customerPhone: '01000000000', customerName: '홍길동',
    delYn: 'N', memo: '',
  }
}

function payloadOf(items: ReturnType<typeof bookItem>[]) {
  const byDate = new Map<string, ReturnType<typeof bookItem>[]>()
  for (const it of items) {
    const d = it.startAt.slice(0, 10).replace(/-/g, '')
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d)!.push(it)
  }
  return [...byDate.entries()].map(([workRsvtDt, its]) => ({ workRsvtDt, items: its }))
}

const ITEMS = [
  bookItem(1, TODAY, '00', 'Y', 10),
  bookItem(2, TODAY, '03', 'N', 11),
  bookItem(3, TODAY, '01', 'N', 13), // 완료 — 예약장부에서는 '예약' 카드
  bookItem(4, dayjs(TODAY).add(1, 'day').format('YYYY-MM-DD'), '00', 'N', 10),
  bookItem(5, FAR, '03', 'N', 10), // 창 안 · 화면 밖 — 신고의 주인공
  bookItem(6, TODAY, '03', 'N', 10), // 1번과 같은 시각에 겹치는 취소 — 칸이 2레인이 된다(③의 폭 고정 검증용)
]

type Setup = {
  rects: { id: string }[]
  visibleDates: string[]
  boardStatistics: { state: Record<string, number>; member: Record<string, number> }
}
const setup = (w: ReturnType<typeof shallowMount>) => w.vm.$.setupState as unknown as Setup

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

async function mountPage() {
  // 방문장부는 표시가 1일로 강제돼 창과 화면이 갈리지 않는다 — 여러 날을 그리는 예약장부에서 본다.
  useSchedulerFilterStore().setDataType('APPOINTMENT', false)
  const wrapper = shallowMount(SchedulerV3Page)
  await flushPromises()
  // happy-dom 은 폭이 0 이라 컬럼이 안 생긴다 — 보드 폭을 넣어 카드가 그려지게 한다.
  wrapper.vm.$.setupState.availableWidth = 1200
  await advance(200) // applyDataWindow 디바운스(150ms) 통과 → 목록 도착
  return wrapper
}

describe('SchedulerV3Page — 숫자는 그려진 카드에서 센다', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubResizeObserver()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(dayjs(TODAY).toDate())
    api.getDoctors.mockResolvedValue({ data: { code: 'succeed', payload: [{ staffName: DOCTOR, staffId: 1, openYn: 'Y' }] } })
    api.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    api.get.mockResolvedValue({ data: { code: 'succeed', payload: payloadOf(ITEMS) } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('① 전체 = 그려진 카드 수 — 창 안이지만 화면 밖 날짜의 예약은 세지 않는다', async () => {
    const wrapper = await mountPage()
    const s = setup(wrapper)

    // 전제: 그 예약은 조회 창 안에 있어 목록에는 왔고(신고 상황), 화면 날짜에는 없다.
    // 창 길이는 예약장부 설정(전체칸)에 따르므로 값이 아니라 "창 끝이 그 날짜 이후" 로 확인한다.
    const list = api.get.mock.calls[api.get.mock.calls.length - 1][0] as { endDate: string }
    expect(list.endDate >= dayjs(FAR).format('YYYYMMDD')).toBe(true)
    expect(s.visibleDates).not.toContain(FAR)

    expect(s.rects.length).toBe(5)
    expect(s.boardStatistics.state['전체']).toBe(s.rects.length)
    expect(s.boardStatistics.state['취소']).toBe(2) // 화면 밖 9일 뒤 취소(5)는 빠진다 — 2·6 만
  })

  it('② 예약장부의 완료 카드는 예약 숫자에 든다 · 회원 Y/N', async () => {
    const wrapper = await mountPage()
    const s = setup(wrapper)

    expect(s.boardStatistics.state).toEqual({ 전체: 5, 예약: 3, 취소: 2 })
    expect(s.boardStatistics.member).toEqual({ Y: 1, N: 4 })
  })

  // 기대값 출처: 사용자 확정(2026-09-08) — 칩을 켜도 다른 칩 숫자는 변하면 안 된다. 그래서 엔진 입력은 전체이고
  // 필터는 rect 에서만 숨긴다(칸 폭·표시 날짜가 필터와 무관). 1·6 이 같은 시각에 겹쳐 그 칸은 2레인이다.
  it('③ 상태 필터는 재조회 없이 화면에서 걸린다 — 켠 상태 숫자 = 카드 수, 다른 숫자·표시 날짜는 그대로', async () => {
    const wrapper = await mountPage()
    const s = setup(wrapper)
    const listCalls = api.get.mock.calls.length
    const datesBefore = [...s.visibleDates]
    const stateBefore = { ...s.boardStatistics.state }

    useSchedulerFilterStore().setStatusKeys(['CANCEL'])
    await advance(200)

    expect(api.get.mock.calls.length).toBe(listCalls)
    expect(s.rects.map(r => r.id).sort()).toEqual(['2', '6'])
    expect(s.boardStatistics.state['취소']).toBe(s.rects.length)
    expect(s.visibleDates).toEqual(datesBefore)
    expect(s.boardStatistics.state).toEqual(stateBefore)
  })

  it('④ 날짜를 옮기면 그 화면의 카드로 다시 센다', async () => {
    const wrapper = await mountPage()
    const s = setup(wrapper)

    useSchedulerFilterStore().setPeriodDate(dayjs(FAR).toDate())
    await advance(200)

    expect(s.visibleDates[0]).toBe(FAR)
    expect(s.rects.map(r => r.id)).toEqual(['5'])
    expect(s.boardStatistics.state).toEqual({ 전체: 1, 예약: 0, 취소: 1 })
  })

  // 기대값 출처: 사용자 요구(2026-09-08) — 조회 중 이전 건수가 잠시 보이면 새 조건의 값처럼 읽힌다.
  it('⑥ 검색 조건이 바뀌어 재조회하는 동안은 0 으로 보이고, 새 목록이 오면 그 값으로 바뀐다', async () => {
    const wrapper = await mountPage()
    const s = setup(wrapper)
    expect(s.boardStatistics.state['전체']).toBe(5)

    let release: (() => void) | null = null
    api.get.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: { code: 'succeed', payload: payloadOf(ITEMS.slice(0, 1)) } })
    }))

    useSchedulerFilterStore().setKeyword('홍길동', true) // payload 가 바뀌는 재조회
    await advance(200)

    expect(s.boardStatistics.state).toEqual({ 전체: 0, 예약: 0, 취소: 0 })
    expect(s.boardStatistics.member).toEqual({ Y: 0, N: 0 })

    release!()
    await advance(0)

    expect(s.boardStatistics.state).toEqual({ 전체: 1, 예약: 1, 취소: 0 })
  })

  it('⑤ 숫자는 검색필터 컴포넌트로 props 로 흘러간다', async () => {
    const wrapper = await mountPage()
    const s = setup(wrapper)

    // 하네스가 스텁으로 바꾼 컴포넌트라 props 선언이 없어 attrs 로 받는다.
    const attrs = wrapper.findComponent(SchedulerSearchFilter).vm.$attrs
    expect(attrs['state-statistics']).toEqual(s.boardStatistics.state)
    expect(attrs['member-statistics']).toEqual(s.boardStatistics.member)
  })
})
