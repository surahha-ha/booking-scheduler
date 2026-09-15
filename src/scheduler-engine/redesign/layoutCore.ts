/**
 * V2 스케줄러 엔진 코어 재설계 — 순수함수 (격리 모듈, 라이브 보드 미배선)
 *
 * 설계 기준: src/scheduler-engine/REDESIGN.md
 * 레퍼런스: book_20260529.html 프로토타입 (arrangeCards 31879 / packPages 32596 / budget 32228)
 * 원칙: 명세 > 프로토타입. 프로토 버그(§10)는 수정하여 포팅.
 *
 * 본 모듈은 어떤 컴포넌트에도 연결되어 있지 않다(안전판). 골드마스터 테스트로만 검증된다.
 */

// ════════════════════════════════════════════════════════════
// 타입
// ════════════════════════════════════════════════════════════

export interface CardInput {
  id: string
  startMin: number
  endMin: number
}

export interface PlacedCard {
  id: string
  column: number
  subRow: number
  level: number
  isFloating: false
}

export interface FloatingCard {
  id: string
  column: number
  floatOverId: string | null
  subRow: number
  floatLevel: number
  isFloating: true
}

export interface ArrangeResult {
  placed: PlacedCard[]
  floating: FloatingCard[]
  /** startMin → 그 시각 그룹의 스택 깊이(base행 + float행). band 높이 ×배 산정용. */
  expandedRows: Record<number, number>
}

export interface UnitLike {
  /** (날짜,의사) 키 */
  key: string
  /** 그 unit 의 자연 칸 수 = min(maxConcurrent, N칸), 최소 1 */
  slots: number
}

export interface Page {
  /** 글로벌 sub-col 시작 인덱스 (모든 unit slots 를 펼친 시퀀스 기준) */
  slotStart: number
  /** 글로벌 sub-col 끝 인덱스 (exclusive) */
  slotEnd: number
}

export interface PageColumn {
  unitIndex: number
  /** unit 내 시작 sub-col index (carry-over; 0 = unit 처음부터) */
  subColStart: number
  /** 이 페이지가 담는 sub-col 수 */
  subColCount: number
  /** 페이지 내 누적 위치 (leftPx 계산용; 0부터) */
  slotsStartIdx: number
  /** unit 전체 sub-col 수 (원래 N; arrangeCards 인자·페이지 카드 슬라이스 기준) */
  unitSlots: number
}

// ════════════════════════════════════════════════════════════
// 1. computeBudget — 보기단계 → 컬럼 예산
//    REDESIGN §3 / 명세 11-1 표. 프로토 버그 E(v<4 클램프) 수정 → [2,14].
// ════════════════════════════════════════════════════════════

export function computeBudget(totalColumns: number, viewStep: number): number {
  const v = totalColumns + 2 * (3 - viewStep)
  return Math.max(2, Math.min(14, v))
}

// ════════════════════════════════════════════════════════════
// 2. maxConcurrent — 동시 최대 겹침 수 (sweep-line)
//    프로토 버그 A(30분 슬롯 카운트) 수정 → cellDuration 무관 정확 계산.
//    [start, end) 반열림: 같은 시각에 끝나고 시작하면 겹치지 않음.
// ════════════════════════════════════════════════════════════

export function maxConcurrent(appts: { startMin: number, endMin: number }[]): number {
  if (appts.length === 0) return 0
  const events: [number, number][] = []
  for (const a of appts) {
    events.push([a.startMin, 1])
    events.push([a.endMin, -1])
  }
  // 같은 좌표에서 end(-1)를 start(+1)보다 먼저 처리
  events.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]))
  let cur = 0
  let max = 0
  for (const [, delta] of events) {
    cur += delta
    if (cur > max) max = cur
  }
  return max
}

// ════════════════════════════════════════════════════════════
// 3. arrangeCards — unit 내부 카드 배치 (placed / floating / expandedRows)
//    프로토 31879 충실 포팅. REDESIGN §5.
//    우선순위: 일반배치 → row확장(같은 startTime 칸수 초과) → floating(다른 startTime 끼어듦)
// ════════════════════════════════════════════════════════════

interface ColSlot {
  endMin: number
  id: string
  dur: number
  startMin: number
}

/**
 * '더 긴 예약' 판정 — 열 선택(floatPlace)과 layering(computeRects pass 2)이 **함께 쓰는 단일 정의**.
 * 두 곳이 어긋나면 "빈 칸으로 보낸 이유"와 "들여쓰기를 붙인 이유"가 달라진다.
 * 기준을 길이에서 시작 순서로 바꾸는 정책 변경은 이 함수 하나만 고치면 된다.
 */
export function isLongerCard(
  other: { startMin: number, endMin: number },
  self: { startMin: number, endMin: number },
): boolean {
  return (other.endMin - other.startMin) > (self.endMin - self.startMin)
}

/**
 * 빈 칸 스택 상한 — 긴 예약을 피해 빈 칸에 쌓을 때 허용할 최대 깊이 차.
 * `Infinity` = 화면정의서 그대로(빈 칸이 있으면 절대 긴 예약 위에 얹지 않는다).
 * 좁은 N칸 보기·페이지 경계 압축에서 밴드가 과하게 두꺼워지면 `2` 로 낮춘다 —
 * 그 순간부터 상한을 넘는 칸은 열 선택 1순위에서 제외돼 기존 분산 배치로 돌아간다.
 */
export const EMPTY_LANE_STACK_CAP = Infinity

export function arrangeCards(
  cards: CardInput[],
  subColumnCount: number,
  emptyLaneStackCap: number = EMPTY_LANE_STACK_CAP,
): ArrangeResult {
  const n = Math.max(1, subColumnCount)
  // startMin asc, dur DESC
  const sorted = cards.slice().sort((a, b) =>
    a.startMin !== b.startMin
      ? a.startMin - b.startMin
      : (b.endMin - b.startMin) - (a.endMin - a.startMin),
  )

  const groupMap = new Map<number, CardInput[]>()
  const groupKeys: number[] = []
  for (const c of sorted) {
    if (!groupMap.has(c.startMin)) {
      groupMap.set(c.startMin, [])
      groupKeys.push(c.startMin)
    }
    groupMap.get(c.startMin)!.push(c)
  }

  const columns: (ColSlot | null)[] = Array.from({ length: n }, () => null)
  const placed: PlacedCard[] = []
  const floating: FloatingCard[] = []
  const expandedRows: Record<number, number> = {}
  const allCards: { startMin: number, endMin: number, level: number, column: number }[] = []
  const chainMaxLevels: Record<number, number> = {}

  function computeLevel(card: CardInput, targetCol: number): number {
    const overlapping = allCards.filter(c =>
      c.column === targetCol
      && c.startMin <= card.startMin && c.endMin > card.startMin
      && (c.startMin < card.startMin || c.endMin > card.endMin),
    )
    if (overlapping.length === 0) {
      chainMaxLevels[targetCol] = 0
      return 0
    }
    let maxOngoing = -1
    for (const c of overlapping) if (c.level > maxOngoing) maxOngoing = c.level
    if (maxOngoing === 0) chainMaxLevels[targetCol] = 0
    const stackLevel = maxOngoing + 1
    const chainMax = chainMaxLevels[targetCol] || 0
    const level = Math.max(stackLevel, chainMax)
    chainMaxLevels[targetCol] = Math.max(chainMax, level)
    return level
  }

  // groupDepth[col] = 현재 그룹(같은 시각)에서 그 칸에 쌓인 카드 수(=다음 subRow). placeBase/floatPlace 가 증가.
  function placeBase(card: CardInput, col: number, groupDepth: number[]): void {
    const level = computeLevel(card, col)
    placed.push({ id: card.id, column: col, subRow: groupDepth[col], level, isFloating: false })
    columns[col] = { endMin: card.endMin, id: card.id, dur: card.endMin - card.startMin, startMin: card.startMin }
    groupDepth[col]++
    allCards.push({ startMin: card.startMin, endMin: card.endMin, level, column: col })
  }

  // 그 칸에서 이 카드와 시간이 겹치는 '더 긴' 카드 수. 이전 그룹에서 넘어온 관통 카드도 allCards 에 있어 함께 센다.
  function longerOverlapCount(card: CardInput, col: number): number {
    let cnt = 0
    for (const c of allCards) {
      if (c.column !== col) continue
      if (c.startMin >= card.endMin || c.endMin <= card.startMin) continue
      if (isLongerCard(c, card)) cnt++
    }
    return cnt
  }

  // 넘치는 카드 = float. 1순위 = "그 칸에서 겹치는 더 긴 카드 수"가 가장 적은 칸 → 긴 예약을 덜 가린다.
  // 2순위 = 시각적 깊이(groupDepth + 이전 그룹 occupant), 동률은 낮은 인덱스.
  // → 빈 칸이 있으면 긴 예약 위에 얹지 않고 그 칸에 쌓는다(화면정의서 2. 예약/진료 배치 ①~④).
  // 단 EMPTY_LANE_STACK_CAP 이상 깊어진 칸은 1순위 후보에서 빼 밴드가 무한정 두꺼워지는 것을 막는다.
  function floatPlace(card: CardInput, groupDepth: number[], occupiedAtStart: number[]): void {
    const densityOf = (k: number): number => groupDepth[k] + occupiedAtStart[k]
    let minDensity = Infinity
    for (let k = 0; k < n; k++) minDensity = Math.min(minDensity, densityOf(k))

    let targetCol = 0
    let bestLonger = Infinity
    let bestDensity = Infinity
    for (let k = 0; k < n; k++) {
      const density = densityOf(k)
      // 상한을 넘게 깊어진 칸은 "긴 예약을 피한다"는 이유로 더 쌓지 않는다(가장 얕은 칸은 항상 후보).
      const longer = density - minDensity >= emptyLaneStackCap
        ? Infinity
        : longerOverlapCount(card, k)
      if (longer < bestLonger || (longer === bestLonger && density < bestDensity)) {
        bestLonger = longer
        bestDensity = density
        targetCol = k
      }
    }
    const occ = columns[targetCol]
    const floatOverId = occ ? occ.id : null
    const level = computeLevel(card, targetCol)
    floating.push({ id: card.id, column: targetCol, floatOverId, subRow: groupDepth[targetCol], floatLevel: level, isFloating: true })
    groupDepth[targetCol]++
    if (!occ || occ.endMin < card.endMin) {
      columns[targetCol] = { endMin: card.endMin, id: card.id, dur: card.endMin - card.startMin, startMin: card.startMin }
    }
    allCards.push({ startMin: card.startMin, endMin: card.endMin, level, column: targetCol })
  }

  for (const startMin of groupKeys) {
    const group = groupMap.get(startMin)!
    const availableCols: number[] = []
    // 이 시각에 이미 점유 중(이전 그룹 occupant)인 칸 — float 분산 시 시각적 밀도로 반영(subRow 는 미선점).
    const occupiedAtStart: number[] = Array.from({ length: n }, () => 0)
    for (let c = 0; c < n; c++) {
      const occ = columns[c]
      if (occ === null || occ.endMin <= startMin) availableCols.push(c)
      else occupiedAtStart[c] = 1
    }
    // 빈 칸 = 가장 왼쪽부터(fill order 1→2→3). availableCols 는 인덱스 오름차순으로 수집됨.
    // (누적 분산 X — 단일/연속 예약은 항상 col0 부터. 같은 시각 다건만 아래 float 로 row-major 분산.)

    // 같은 시각 카드를 N칸에 분산: 빈 칸 수만큼 base(좌→우), 나머지는 float 로 row-major 균형 분포.
    const groupDepth: number[] = Array.from({ length: n }, () => 0)
    const baseCount = Math.min(group.length, availableCols.length)
    for (let i = 0; i < baseCount; i++) placeBase(group[i], availableCols[i], groupDepth)
    for (let i = baseCount; i < group.length; i++) floatPlace(group[i], groupDepth, occupiedAtStart)

    // band 깊이 = 이 그룹의 칸별 최대 깊이(전역 누적 아님 → 분산으로 timeline 단축).
    const maxDepth = groupDepth.reduce((m, d) => Math.max(m, d), 0)
    if (maxDepth > 1) {
      expandedRows[startMin] = Math.max(expandedRows[startMin] || 1, maxDepth)
    }
  }

  // 안전망: 누락 카드 강제 floating
  if (placed.length + floating.length !== cards.length) {
    const seen = new Set<string>()
    placed.forEach(p => seen.add(p.id))
    floating.forEach(f => seen.add(f.id))
    for (const c of cards) {
      if (!seen.has(c.id)) {
        floating.push({ id: c.id, column: 0, floatOverId: null, subRow: 0, floatLevel: 0, isFloating: true })
      }
    }
  }

  return { placed, floating, expandedRows }
}

/** unit 의 자연 칸 수(>=1). resolveSlots 결과(min(maxConcurrent,N))를 그대로 신뢰. */
function unitSlotsOf(u: UnitLike): number {
  return Math.max(1, u.slots)
}

// ════════════════════════════════════════════════════════════
// 4. packPages — unit 경계 페이지 분할 (경계 unit 은 압축, 이월 없음)
//    한 unit(날짜×의사)은 절대 두 페이지에 걸치지 않는다. budget 을 다 못 채우고 남은 칸보다
//    큰 unit 이 오면 그 unit 을 **남은 칸수로 압축**해 이 페이지에 담고, 다음 페이지는 그 다음
//    unit 부터 시작한다 → 같은 담당자가 좌우 페이지에 중복 노출되지 않는다.
//    page.slotEnd - slotStart 는 budget 보다 클 수 있다(압축된 칸 수만큼). 전역 slot 시퀀스
//    (unit 당 slots 칸)는 그대로라 slotOffset/totalSlots 좌표계는 유지된다.
// ════════════════════════════════════════════════════════════

export function packPages(units: UnitLike[], budget: number): Page[] {
  const b = Math.max(1, budget)
  const pages: Page[] = []
  let ui = 0
  let slot = 0
  while (ui < units.length) {
    const start = slot
    let remaining = b
    // 남은 칸이 0 이 될 때까지 unit 을 통째로 담는다(마지막 unit 은 남은 칸수로 압축 표시).
    while (ui < units.length && remaining > 0) {
      const n = unitSlotsOf(units[ui])
      remaining -= Math.min(n, remaining)
      slot += n
      ui++
    }
    pages.push({ slotStart: start, slotEnd: slot })
  }
  return pages
}

// ════════════════════════════════════════════════════════════
// 5. buildPageColumns — 시작 slot + budget → 컬럼 (unit 경계)
//    startSlot 이 unit 중간을 가리키면 그 unit 의 처음으로 스냅한다(부분 노출 금지).
//    각 컬럼은 unit 전체를 담고(subColStart 는 항상 0), 남은 칸보다 큰 unit 은
//    subColCount 를 남은 칸수로 줄인다 — 카드는 그 칸수로 재배치되어 전량 표시된다.
// ════════════════════════════════════════════════════════════

export function buildPageColumns(units: UnitLike[], startSlot: number, budget: number): PageColumn[] {
  const cols: PageColumn[] = []
  const b = Math.max(1, budget)

  // startSlot → 시작 unit index (unit 경계로 스냅). 범위를 넘으면 빈 컬럼.
  let ui = 0
  let acc = 0
  while (ui < units.length && acc + unitSlotsOf(units[ui]) <= startSlot) {
    acc += unitSlotsOf(units[ui])
    ui++
  }
  if (ui >= units.length) return cols

  let remaining = b
  let slotsStartIdx = 0
  while (ui < units.length && remaining > 0) {
    const n = unitSlotsOf(units[ui])
    const count = Math.min(n, remaining)
    cols.push({ unitIndex: ui, subColStart: 0, subColCount: count, slotsStartIdx, unitSlots: n })
    slotsStartIdx += count
    remaining -= count
    ui++
  }
  return cols
}

/** 전역 slot 시퀀스에서 unit index → 그 unit 의 시작 slot. */
export function slotStartOfUnit(units: UnitLike[], unitIndex: number): number {
  let acc = 0
  for (let i = 0; i < unitIndex && i < units.length; i++) acc += unitSlotsOf(units[i])
  return acc
}
