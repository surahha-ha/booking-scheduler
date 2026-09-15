/**
 * @vitest-environment happy-dom
 *
 * useSchedulerPopover — 패널 슬롯의 주인 판정 (회귀 A-5)
 *
 * 패널 element 슬롯(_popoverEl)은 전역 하나인데, 카드마다 자기 패널을 watch 해
 * 등록(el)과 해제(null)를 각각 밀어 넣는다. 카드 A → B 로 옮겨 열 때 B 의 등록이 먼저
 * flush 되고 A 의 해제가 뒤에 오면 B 의 패널이 null 로 덮인다.
 *
 * 그 상태에서는 바깥클릭 리스너가 패널 안쪽을 알아보지 못한다. 리스너는 document 의
 * 캡처 단계라 패널의 mousedown.stop 도 막지 못하므로, 메뉴 항목을 눌러도 메뉴가 먼저
 * 닫혀 클릭이 먹지 않는다. flush 순서에 달려 있어 재현이 간헐적이다.
 *
 * 검증 범위: 패널 안쪽 mousedown 이 popover 를 닫지 않는가(= 슬롯이 올바른 패널을 들고 있는가).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useSchedulerPopover } from '../useSchedulerPopover'

function el(): HTMLElement {
  const node = document.createElement('div')
  document.body.appendChild(node)
  return node
}

function mousedownOn(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

function setup() {
  const interactionLock = {
    isLocked: ref(false),
    acquire: vi.fn(() => ({ unlock: vi.fn() })),
    forceUnlock: vi.fn(),
  } as never
  const hover = { suppress: vi.fn(), unsuppress: vi.fn() } as never
  return useSchedulerPopover({ interactionLock, hover, bodyEl: ref(null) })
}

describe('useSchedulerPopover — 패널 슬롯 주인 판정', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('패널 안쪽 mousedown 은 popover 를 닫지 않는다', () => {
    const popover = setup()
    const trigger = el()
    const panel = el()

    popover.open('A', trigger)
    popover.setPopoverElement(panel, 'A')

    mousedownOn(panel)

    expect(popover.isOpen.value).toBe(true)
  })

  it('패널 바깥 mousedown 은 닫는다', () => {
    const popover = setup()
    const trigger = el()
    const panel = el()
    const outside = el()

    popover.open('A', trigger)
    popover.setPopoverElement(panel, 'A')

    mousedownOn(outside)

    expect(popover.isOpen.value).toBe(false)
  })

  it('🔑 A→B 전환에서 A 의 뒤늦은 해제가 B 의 패널을 덮지 않는다', () => {
    const popover = setup()
    const triggerA = el()
    const triggerB = el()
    const panelA = el()
    const panelB = el()

    popover.open('A', triggerA)
    popover.setPopoverElement(panelA, 'A')

    // B 로 옮겨 열린다. B 의 등록이 먼저 flush 되고…
    popover.open('B', triggerB)
    popover.setPopoverElement(panelB, 'B')
    // …A 의 해제(null)가 뒤늦게 도착한다. 주인이 아니므로 무시돼야 한다.
    popover.setPopoverElement(null, 'A')

    mousedownOn(panelB)

    expect(popover.isOpen.value).toBe(true)
    expect(popover.openedId.value).toBe('B')
  })

  it('🔑 주인이 아닌 카드의 등록도 슬롯을 가로채지 못한다', () => {
    const popover = setup()
    const triggerB = el()
    const panelB = el()
    const panelA = el()

    popover.open('B', triggerB)
    popover.setPopoverElement(panelB, 'B')
    // 닫힌 카드 A 가 뒤늦게 자기 패널을 등록해도 지금 열린 건 B 다.
    popover.setPopoverElement(panelA, 'A')

    mousedownOn(panelB)

    expect(popover.isOpen.value).toBe(true)
  })

  it('닫으면 슬롯을 비운다 — 이전 패널이 다음 판정에 남지 않는다', () => {
    const popover = setup()
    const triggerA = el()
    const panelA = el()
    const triggerB = el()

    popover.open('A', triggerA)
    popover.setPopoverElement(panelA, 'A')
    popover.close()

    // B 를 열되 패널은 아직 등록 전(렌더 직후 한 틱). 옛 패널 A 안쪽을 눌러도
    // 그것은 이제 바깥이므로 닫혀야 한다.
    popover.open('B', triggerB)
    mousedownOn(panelA)

    expect(popover.isOpen.value).toBe(false)
  })
})
