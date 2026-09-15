/**
 * @vitest-environment happy-dom
 *
 * SchedulerV3Page — 예약 저장의 실패 처리와 연타 방어 (회귀 B-2 · B-3)
 *
 * 검증 범위 1 (B-2): @save/@modify 처리 결과에 따른 ReservationPopup 의 :visible prop
 * - 등록 성공(code:'succeed') → visible=false (닫힘)
 * - 등록 실패(code!=='succeed') → visible=true 유지  ← 회귀의 핵심
 * - 수정 성공 → 닫힘 / 수정 실패 → 유지
 *
 * 검증 범위 2 (B-3): 앞 요청이 끝나기 전 다시 저장하면 요청이 두 번 나가지 않는다
 * - 응답 전 @save 두 번 → API 는 한 번만 호출
 * - 요청 중에는 :saving=true 로 내려가 버튼이 잠긴다
 *
 * 왜 "예외"가 아니라 "실패 응답 객체"로 재현하나:
 *   bookStore.addAppointment/modifyAppointment 는 실패를 try/catch 로 삼키고
 *   {code:'failed', message} 를 *정상 반환값* 으로 돌려준다(bookStore.ts).
 *   그래서 "예외가 안 났으니 성공" 이 성립하지 않는 것이 이 결함의 뿌리다.
 *   reject 로 흉내내면 결함을 재현하지 못하므로, 여기서는 bookApi.add/modify 가
 *   실패 본문을 resolve 하게 만든다.
 *
 * 팝업이 닫히면 안 되는 이유: ReservationPopup 은 visible=false 를 watch 해
 *   resetFormState() 를 돌린다 → 저장 실패인데 닫으면 사용자가 입력한 값이 통째로 사라진다.
 *
 * production 코드(SchedulerV3Page.vue)는 수정하지 않는다.
 * 마운트 의존성(SSE/라우터/API/HTTP 클라이언트)은 테스트 셋업의 mock 으로만 충족시킨다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 마운트 의존성(SSE/라우터/API/HTTP 클라이언트)은 공용 하네스의 mock 으로만 충족시킨다 — 페이지보다 먼저 import.
import { api, stubResizeObserver, toastMocks } from './v3PageHarness'
import SchedulerV3Page from '@/pages/desktop/scheduler-v3/SchedulerV3Page.vue'
import SchedulerGrid from '@/pages/desktop/scheduler/components/SchedulerGrid.vue'
import ReservationPopup from '@/components/popup/ReservationPopup.vue'

/** WAS 성공 본문 (bookStore.unwrapBody 는 res.data 를 그대로 돌려준다) */
const SUCCEED_RES = { data: { code: 'succeed', message: null, payload: { reservationId: 1 } } }
/** WAS 실패 본문 — throw 가 아니라 *정상 resolve* 다. 이것이 결함의 재현 조건. */
const FAILED_RES = { data: { code: 'failed', message: '이미 예약된 시간입니다.', payload: null } }

/** 빈 셀 클릭(@cell-click) 으로 팝업을 연 상태를 만든다. */
async function mountWithOpenPopup() {
  const wrapper = shallowMount(SchedulerV3Page)
  await flushPromises()

  wrapper.findComponent(SchedulerGrid).vm.$emit('cell-click', {
    columnKey: '2026-06-12|김대표',
    date: '2026-06-12',
    resourceId: '김대표',
    resourceLabel: '김대표',
    startMinute: 600,
    endMinute: 630,
  })
  await flushPromises()

  const popup = wrapper.findComponent(ReservationPopup)
  // 사전조건: 저장 전에는 팝업이 열려 있어야 이후 판정이 의미를 갖는다.
  expect(popup.props('visible')).toBe(true)
  return { wrapper, popup }
}

describe('SchedulerV3Page — 저장 성공에만 예약 팝업을 닫는다', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubResizeObserver()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('등록 성공(code:succeed) → 팝업이 닫힌다', async () => {
    api.add.mockResolvedValue(SUCCEED_RES)
    const { popup } = await mountWithOpenPopup()

    popup.vm.$emit('save', { patientName: '홍길동' })
    await flushPromises()

    expect(api.add).toHaveBeenCalledTimes(1)
    expect(popup.props('visible')).toBe(false)
  })

  it('🔑 등록 실패(실패 응답 객체 반환) → 팝업이 그대로 열려 있다 (입력값 보존)', async () => {
    api.add.mockResolvedValue(FAILED_RES)
    const { popup } = await mountWithOpenPopup()

    popup.vm.$emit('save', { patientName: '홍길동' })
    await flushPromises()

    expect(api.add).toHaveBeenCalledTimes(1)
    expect(popup.props('visible')).toBe(true)
    // 실패는 조용히 넘기지 않고 서버 메시지를 그대로 알린다.
    expect(toastMocks.error).toHaveBeenCalledWith('이미 예약된 시간입니다.')
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('수정 성공(code:succeed) → 팝업이 닫힌다', async () => {
    api.modify.mockResolvedValue(SUCCEED_RES)
    const { popup } = await mountWithOpenPopup()

    popup.vm.$emit('modify', { id: '77', patientName: '홍길동' })
    await flushPromises()

    expect(api.modify).toHaveBeenCalledTimes(1)
    expect(api.modify.mock.calls[0][0]).toBe('77')
    expect(popup.props('visible')).toBe(false)
  })

  it('🔑 수정 실패(실패 응답 객체 반환) → 팝업이 그대로 열려 있다 (입력값 보존)', async () => {
    api.modify.mockResolvedValue(FAILED_RES)
    const { popup } = await mountWithOpenPopup()

    popup.vm.$emit('modify', { id: '77', patientName: '홍길동' })
    await flushPromises()

    expect(api.modify).toHaveBeenCalledTimes(1)
    expect(popup.props('visible')).toBe(true)
    expect(toastMocks.error).toHaveBeenCalledWith('이미 예약된 시간입니다.')
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})

describe('SchedulerV3Page — 저장 연타로 요청이 두 번 나가지 않는다 (회귀 B-3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubResizeObserver()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 응답을 테스트가 직접 놓아주는 지연 Promise — "요청이 아직 안 끝난 상태" 를 만든다. */
  function deferred() {
    let resolve!: (v: unknown) => void
    const promise = new Promise(r => { resolve = r })
    return { promise, resolve }
  }

  it('🔑 등록 응답 전에 다시 등록하면 API 는 한 번만 호출된다', async () => {
    const first = deferred()
    api.add.mockReturnValue(first.promise)
    const { popup } = await mountWithOpenPopup()

    popup.vm.$emit('save', { patientName: '홍길동' })
    await flushPromises()
    // 아직 응답 전 — 사용자가 한 번 더 누른 상황
    popup.vm.$emit('save', { patientName: '홍길동' })
    await flushPromises()

    expect(api.add).toHaveBeenCalledTimes(1)

    first.resolve(SUCCEED_RES)
    await flushPromises()
    // 응답이 온 뒤에도 중복 등록은 없다
    expect(api.add).toHaveBeenCalledTimes(1)
    expect(popup.props('visible')).toBe(false)
  })

  it('🔑 수정 응답 전에 다시 수정하면 API 는 한 번만 호출된다', async () => {
    const first = deferred()
    api.modify.mockReturnValue(first.promise)
    const { popup } = await mountWithOpenPopup()

    popup.vm.$emit('modify', { id: '77', patientName: '홍길동' })
    await flushPromises()
    popup.vm.$emit('modify', { id: '77', patientName: '홍길동' })
    await flushPromises()

    expect(api.modify).toHaveBeenCalledTimes(1)

    first.resolve(SUCCEED_RES)
    await flushPromises()
    expect(api.modify).toHaveBeenCalledTimes(1)
  })

  it('요청 중에는 saving=true 로 버튼을 잠그고, 끝나면 푼다', async () => {
    const first = deferred()
    api.add.mockReturnValue(first.promise)
    const { popup } = await mountWithOpenPopup()

    expect(popup.props('saving')).toBe(false)

    popup.vm.$emit('save', { patientName: '홍길동' })
    await flushPromises()
    expect(popup.props('saving')).toBe(true)

    first.resolve(FAILED_RES) // 실패로 끝나도 잠금은 반드시 풀려야 한다(다시 시도해야 하므로)
    await flushPromises()
    expect(popup.props('saving')).toBe(false)
    expect(popup.props('visible')).toBe(true)
  })
})
