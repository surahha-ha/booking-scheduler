/**
 * hover 이탈 신호의 주인 판정.
 *
 * 겹친(레이어링) 카드 사이나, 포털에 떠 있는 ⋮·리사이즈 핸들을 거쳐 옮겨가면
 * 다음 카드의 mouseenter 가 이전 카드의 mouseleave 보다 **먼저** 도착한다.
 * 이때 이전 카드의 이탈을 그대로 받으면 마우스가 새 카드 위에 있는데도 hover 가 꺼졌다
 * (카드 위인데 ⋮ 버튼과 hover 테두리가 잠깐 뒤 사라지는 증상).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSchedulerHover } from '../composables/useSchedulerHover'
import { useSchedulerInteractionLock } from '../composables/useSchedulerInteractionLock'

const GRACE = 50

function setup() {
  const lock = useSchedulerInteractionLock()
  const hover = useSchedulerHover(lock)
  return { lock, hover }
}

const el = () => ({}) as HTMLElement

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('onCardLeave — 이탈 신호의 주인', () => {

  it('이탈이 다음 카드 진입보다 늦게 와도 새 카드 hover 는 유지된다', () => {
    const { hover } = setup()

    hover.onCardEnter('A', el())
    // 순서가 뒤집힌 경우: B 진입이 먼저, A 이탈이 나중
    hover.onCardEnter('B', el())
    hover.onCardLeave('A')

    vi.advanceTimersByTime(GRACE * 4)

    expect(hover.hoveredId.value).toBe('B')
  })

  it('정상 순서(이탈 → 진입)에서도 새 카드 hover 는 유지된다', () => {
    const { hover } = setup()

    hover.onCardEnter('A', el())
    hover.onCardLeave('A')
    hover.onCardEnter('B', el())

    vi.advanceTimersByTime(GRACE * 4)

    expect(hover.hoveredId.value).toBe('B')
  })

  it('빈 공간으로 나가면 grace 후 hover 가 풀린다', () => {
    const { hover } = setup()

    hover.onCardEnter('A', el())
    hover.onCardLeave('A')

    expect(hover.hoveredId.value).toBe('A') // grace 동안은 유지
    vi.advanceTimersByTime(GRACE * 4)

    expect(hover.hoveredId.value).toBeNull()
  })

  it('id 를 생략한 이탈(quick action 영역)은 종전대로 현재 hover 를 푼다', () => {
    const { hover } = setup()

    hover.onCardEnter('A', el())
    hover.onCardLeave()

    vi.advanceTimersByTime(GRACE * 4)

    expect(hover.hoveredId.value).toBeNull()
  })
})
