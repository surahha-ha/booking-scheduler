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

export function arrangeCards(cards: CardInput[], subColumnCount: number): ArrangeResult {
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

  // 넘치는 카드 = float. 칸별 "시각적 깊이(groupDepth + 이전 그룹 occupant)"가 가장 얕은 칸으로 분산
  // → 같은 시각 카드가 N칸에 row-major 로 균형 분포(한 칸에 안 쌓임). 동률은 낮은 인덱스.
  // 첫 float 은 보통 col0(가장 긴 base) 위 → "가장 긴 칸 위 layering" 유지하며 나머지 분산.
  function floatPlace(card: CardInput, groupDepth: number[], occupiedAtStart: number[]): void {
    let targetCol = 0
    let best = Infinity
    for (let k = 0; k < n; k++) {
      const density = groupDepth[k] + occupiedAtStart[k]
      if (density < best) {
        best = density
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
// 4. packPages — sub-column 단위 연속 페이지 분할 (압축 아님)
//    모든 unit 의 sub-col 을 하나의 글로벌 시퀀스로 펼치고 budget 칸씩 자른다.
//    한 unit 의 칸 수가 budget 을 넘으면 그 unit 이 여러 페이지에 걸친다(carry-over).
//    REDESIGN §4 (재설계: 의사 단위 압축 → 칸 단위 분할).
// ════════════════════════════════════════════════════════════

export function packPages(units: UnitLike[], budget: number): Page[] {
  const b = Math.max(1, budget)
  let total = 0
  for (const u of units) total += unitSlotsOf(u)
  const pages: Page[] = []
  for (let s = 0; s < total; s += b) {
    pages.push({ slotStart: s, slotEnd: Math.min(s + b, total) })
  }
  return pages
}

// ════════════════════════════════════════════════════════════
// 5. buildPageColumns — 페이지(글로벌 slot 범위) → 컬럼
//    페이지 범위와 겹치는 unit 들을 컬럼으로. 경계에 걸친 unit 은 부분 sub-col 만(carry-over).
//    압축 없음 — 잔여 칸은 우측에 다음 unit(다음 의사/요일)이 이어진다.
// ════════════════════════════════════════════════════════════

export function buildPageColumns(units: UnitLike[], page: Page): PageColumn[] {
  const cols: PageColumn[] = []
  let globalSlot = 0
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui]
    const n = unitSlotsOf(u)
    const uStart = globalSlot
    const uEnd = globalSlot + n
    globalSlot = uEnd
    // 이 unit 의 글로벌 범위 [uStart,uEnd) 와 페이지 [slotStart,slotEnd) 의 겹침
    const ovStart = Math.max(uStart, page.slotStart)
    const ovEnd = Math.min(uEnd, page.slotEnd)
    if (ovStart < ovEnd) {
      cols.push({
        unitIndex: ui,
        subColStart: ovStart - uStart,
        subColCount: ovEnd - ovStart,
        slotsStartIdx: ovStart - page.slotStart,
        unitSlots: n,
      })
    }
    if (globalSlot >= page.slotEnd) break
  }
  return cols
}
