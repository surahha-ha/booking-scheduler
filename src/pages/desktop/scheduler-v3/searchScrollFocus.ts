/**
 * 검색 pick 카드로의 세로 스크롤 계산.
 *
 * V3 보드는 보드 전체 높이를 펼쳐 바깥 스크롤 하나만 쓰고(.v3-board 주석), 헤더(.v3-board-head)는
 * sticky 로 상단에 남는다. 그래서 "화면에 보이는가"는 뷰포트 전체가 아니라 **헤더 아래 영역** 기준이며,
 * 스크롤 대상도 문서 하나로 단정할 수 없다(앱이 외부 프레임 안에서 렌더된다).
 * 두 가지를 여기서 계산으로 분리해 DOM 없이 검증한다.
 */

/** 스크롤 없이 카드가 이미 유효 영역 안에 있으면 null. 아니면 더해야 할 scrollTop 증분(px). */
export function computeScrollDelta(args: {
  /** 카드 상/하단 — 뷰포트 기준(getBoundingClientRect). */
  cardTop: number
  cardBottom: number
  /** 가려지지 않고 실제로 보이는 영역 — 상단은 sticky 헤더 하단. */
  viewTop: number
  viewBottom: number
}): number | null {
  const { cardTop, cardBottom, viewTop, viewBottom } = args
  if (cardTop >= viewTop && cardBottom <= viewBottom) return null

  // 유효 영역보다 긴 예약은 가운데 맞추면 위아래가 다 잘린다 — 시작 시각이 보이도록 상단 맞춤.
  if (cardBottom - cardTop > viewBottom - viewTop) return cardTop - viewTop

  return (cardTop + cardBottom) / 2 - (viewTop + viewBottom) / 2
}

/**
 * 카드가 속한 스크롤 컨테이너 탐색.
 *
 * ⚠️ scrollIntoView 를 쓰지 않는 이유 — 그쪽은 스크롤 체인의 **모든 조상**을 움직인다.
 *   이 앱은 외부 프레임 안에서 렌더되고 그 번들이 자체 스크롤 컨테이너를 두는지
 *   정적으로 확정할 수 없어, 보드만 움직이려던 것이 프레임 바깥 영역까지 밀 수 있다.
 *   실제로 스크롤될 요소 하나만 찾아 그 scrollTop 만 바꾼다.
 */
export function findScrollContainer(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}
