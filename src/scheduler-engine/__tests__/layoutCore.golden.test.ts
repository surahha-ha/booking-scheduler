import { describe, expect, it } from 'vitest'
import {
  arrangeCards,
  buildPageColumns,
  computeBudget,
  maxConcurrent,
  packPages,
  type UnitLike,
} from '../redesign/layoutCore'

/**
 * 골드마스터 — V2 엔진 코어 재설계 타겟 동작 고정.
 * 기준: src/scheduler-engine/REDESIGN.md §11.
 * 프로토타입(book_20260529.html) 동작 = 타겟. 단 프로토 버그(E,A,G)는 수정본 기준.
 */

describe('computeBudget — 보기단계 → 컬럼 예산 (명세 11-1 표)', () => {
  // 행=전체칸개수(6~10), 열=보기단계(1~5). 11-1 동그라미: min 2, max 14.
  const TABLE: Record<number, number[]> = {
    6: [10, 8, 6, 4, 2],
    7: [11, 9, 7, 5, 3],
    8: [12, 10, 8, 6, 4],
    9: [13, 11, 9, 7, 5],
    10: [14, 12, 10, 8, 6],
  }
  for (const tc of [6, 7, 8, 9, 10]) {
    for (let step = 1; step <= 5; step++) {
      it(`전체칸개수 ${tc} × ${step}단계 = ${TABLE[tc][step - 1]}`, () => {
        expect(computeBudget(tc, step)).toBe(TABLE[tc][step - 1])
      })
    }
  }

  it('프로토 버그 E 수정: 하한은 4가 아니라 2 (6×5단계)', () => {
    expect(computeBudget(6, 5)).toBe(2)
  })
  it('상한 14 클램프 (방어)', () => {
    expect(computeBudget(20, 1)).toBe(14)
  })
})

describe('maxConcurrent — 동시 최대 겹침 (sweep, cellDuration 무관)', () => {
  it('빈 배열 = 0', () => {
    expect(maxConcurrent([])).toBe(0)
  })
  it('겹치지 않는 연속 예약 = 1', () => {
    expect(maxConcurrent([
      { startMin: 600, endMin: 630 },
      { startMin: 630, endMin: 660 }, // [start,end) 반열림: 630 접점은 비겹침
    ])).toBe(1)
  })
  it('2건 겹침 = 2', () => {
    expect(maxConcurrent([
      { startMin: 600, endMin: 660 },
      { startMin: 630, endMin: 690 },
      { startMin: 700, endMin: 730 },
    ])).toBe(2)
  })
  it('긴 예약 안에 2건 = 3', () => {
    expect(maxConcurrent([
      { startMin: 600, endMin: 720 }, // 긴 예약
      { startMin: 610, endMin: 640 },
      { startMin: 620, endMin: 650 },
    ])).toBe(3)
  })
})

describe('arrangeCards — unit 내부 배치', () => {
  it('G-arrange-1: 칸수 내 같은 시각 → 나란히, floating 0', () => {
    const r = arrangeCards([
      { id: 'a', startMin: 600, endMin: 630 },
      { id: 'b', startMin: 600, endMin: 630 },
    ], 2)
    expect(r.placed.map(p => [p.id, p.column])).toEqual([['a', 0], ['b', 1]])
    expect(r.floating).toHaveLength(0)
    expect(r.expandedRows).toEqual({})
  })

  it('G-arrange-2: 같은 시각 칸수 초과 → 1건 float + expandedRows 스택', () => {
    const r = arrangeCards([
      { id: 'a', startMin: 600, endMin: 630 },
      { id: 'b', startMin: 600, endMin: 630 },
      { id: 'c', startMin: 600, endMin: 630 },
    ], 2)
    expect(r.placed.map(p => p.id)).toEqual(['a', 'b'])
    expect(r.floating).toHaveLength(1)
    expect(r.floating[0].id).toBe('c')
    expect(r.floating[0].subRow).toBe(1)
    expect(r.expandedRows[600]).toBe(2)
  })

  it('G-arrange-3: 긴 예약 + 다른-시작 끼어듦 → 긴 예약 위 float', () => {
    const r = arrangeCards([
      { id: 'long', startMin: 600, endMin: 720 }, // dur 120
      { id: 'short', startMin: 630, endMin: 660 }, // 끼어듦
    ], 1)
    expect(r.placed.map(p => p.id)).toEqual(['long'])
    expect(r.floating).toHaveLength(1)
    expect(r.floating[0].id).toBe('short')
    expect(r.floating[0].floatOverId).toBe('long')
  })

  it('누락 없음: placed + floating = 입력 수', () => {
    const cards = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, startMin: 600, endMin: 630 }))
    const r = arrangeCards(cards, 2)
    expect(r.placed.length + r.floating.length).toBe(7)
  })

  it('G-arrange-4: 단일/연속(겹침 없음) → 항상 가장 왼쪽 빈 칸(fill order 1→2→3, 누적 드리프트 없음)', () => {
    // 🔑 겹치지 않는 예약은 매번 col0(가장 왼쪽). 하루 누적으로 col2 로 드리프트하면 안 됨(단일 예약 col0 보장).
    const r = arrangeCards([
      { id: 'a', startMin: 540, endMin: 570 }, // 09:00~09:30
      { id: 'b', startMin: 600, endMin: 630 }, // 10:00~10:30 (a 끝난 뒤)
      { id: 'c', startMin: 990, endMin: 1020 }, // 16:30~17:00 (한참 뒤 단일)
      { id: 'd', startMin: 1050, endMin: 1080 }, // 17:30~18:00
    ], 3)
    expect(r.placed.map(p => p.column)).toEqual([0, 0, 0, 0]) // 전부 col0
    expect(r.floating).toHaveLength(0)
  })

  it('G-arrange-4b: 긴 예약(col0 점유) + 연속 short → 다음 빈 칸 col1(좌→우, col0 점유라 건너뜀)', () => {
    const r = arrangeCards([
      { id: 'L', startMin: 540, endMin: 720 }, // 09:00~12:00 (col0 점유)
      { id: 'A', startMin: 540, endMin: 570 },
      { id: 'B', startMin: 570, endMin: 600 },
      { id: 'C', startMin: 600, endMin: 630 },
    ], 3)
    const colOf = Object.fromEntries(r.placed.map(p => [p.id, p.column]))
    expect(colOf.L).toBe(0)
    // col0 점유 → 남은 가장 왼쪽 col1. 연속이라 col1 재사용(겹침 없으니 한 칸이면 충분, col2 불필요).
    expect(colOf.A).toBe(1)
    expect(colOf.B).toBe(1)
    expect(colOf.C).toBe(1)
  })

  it('G-arrange-5: 동시(같은 시각) 카드는 좌→우 유지(count 동률 → index)', () => {
    const r = arrangeCards([
      { id: 'a', startMin: 600, endMin: 630 },
      { id: 'b', startMin: 600, endMin: 630 },
      { id: 'c', startMin: 600, endMin: 630 },
    ], 3)
    expect(r.placed.map(p => [p.id, p.column])).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })

  it('G-arrange-6: 같은 시각 10건(긴 1 + 동일 9), N=3 → 긴 예약 칸을 비우고 나머지 칸에 분산', () => {
    // 화면정의서 2. 예약/진료 배치 — 짧은 예약은 긴 예약 위에 얹기 전에 빈 칸부터 채운다.
    // col0 은 긴 예약이 점유하므로 짧은 9건이 col1·col2 에만 쌓인다 → 깊이 ceil(9/2)=5.
    // (분산만 보던 종전 규칙은 깊이 4 였다. 밴드 1행이 두꺼워지는 대신 긴 예약이 가려지지 않는다.)
    const cards = [
      { id: 'long', startMin: 660, endMin: 780 }, // 긴 예약(dur 120) → col0 row0
      ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, startMin: 660, endMin: 690 })),
    ]
    const r = arrangeCards(cards, 3)
    // (column,subRow) 로 위치 확인 — 모든 카드
    const pos: Record<string, [number, number]> = {}
    for (const p of r.placed) pos[p.id] = [p.column, p.subRow]
    for (const f of r.floating) pos[f.id] = [f.column, f.subRow]
    // 긴예약 = col0 row0. 그 위에는 아무것도 얹히지 않는다.
    expect(pos.long).toEqual([0, 0])
    expect(Object.entries(pos).filter(([id, p]) => id !== 'long' && p[0] === 0)).toEqual([])
    // row0: long(col0), s1(col1), s2(col2)
    expect(pos.s1).toEqual([1, 0])
    expect(pos.s2).toEqual([2, 0])
    // 이후 짧은 예약은 col1·col2 를 번갈아 채운다(동률은 낮은 인덱스).
    expect(pos.s3).toEqual([1, 1])
    expect(pos.s4).toEqual([2, 1])
    expect(pos.s5).toEqual([1, 2])
    expect(pos.s6).toEqual([2, 2])
    expect(pos.s7).toEqual([1, 3])
    expect(pos.s8).toEqual([2, 3])
    expect(pos.s9).toEqual([1, 4])
    // band 깊이 = 5 (긴 예약 칸을 비워 둔 대가)
    expect(r.expandedRows[660]).toBe(5)
    // 전부 동일 길이 위에 얹히므로 layering 없음 → floatLevel 0 (width 는 computeRects)
    for (const id of ['s3', 's4', 's5', 's6', 's7', 's8', 's9']) {
      expect(r.floating.find(f => f.id === id)!.floatLevel).toBe(0)
    }
  })
})

/**
 * 화면정의서 「2. 예약/진료 배치」 매트릭스.
 * 배치 결과는 (n = 그려지는 레인 수, k = 같은 시각 카드 수, L = 긴 예약이 점유한 칸 수) 만의 함수라
 * N칸 보기 화면을 전수로 볼 필요가 없다 — N 은 n 을 통해서만 들어오고, 페이지 경계 압축도 n 을 줄일 뿐이다.
 */
describe('arrangeCards — 긴 예약 회피 배치 매트릭스 (n × k × L)', () => {
  const long = (id: string) => ({ id, startMin: 660, endMin: 780 }) // 11:00~13:00
  const short = (id: string) => ({ id, startMin: 660, endMin: 690 }) // 11:00~11:30

  /** id → [column, subRow] */
  function place(cards: { id: string, startMin: number, endMin: number }[], n: number, cap?: number) {
    const r = arrangeCards(cards, n, cap)
    const pos: Record<string, [number, number]> = {}
    for (const p of r.placed) pos[p.id] = [p.column, p.subRow]
    for (const f of r.floating) pos[f.id] = [f.column, f.subRow]
    return { pos, depth: r.expandedRows[660] ?? 1 }
  }

  it('n=1 — 빈 칸이 없으므로 규칙이 개입하지 않는다(종전과 동일하게 한 칸에 쌓임)', () => {
    const { pos, depth } = place([long('L'), short('a'), short('b')], 1)
    expect(pos.L).toEqual([0, 0])
    expect(pos.a).toEqual([0, 1])
    expect(pos.b).toEqual([0, 2])
    expect(depth).toBe(3)
  })

  it('② n=2·L=1 — 짧은 예약은 긴 예약 위가 아니라 빈 칸에 쌓인다', () => {
    const { pos, depth } = place([long('L'), short('a'), short('b')], 2)
    expect(pos.L).toEqual([0, 0])
    expect(pos.a).toEqual([1, 0])
    expect(pos.b).toEqual([1, 1]) // 종전에는 [0,1] = 긴 예약 위
    expect(depth).toBe(2)
  })

  it('③ n=2·L=2 — 빈 칸이 없으면 얹힌다(동률은 낮은 인덱스)', () => {
    const { pos, depth } = place([long('L1'), long('L2'), short('a')], 2)
    expect(pos.L1).toEqual([0, 0])
    expect(pos.L2).toEqual([1, 0])
    expect(pos.a).toEqual([0, 1])
    expect(depth).toBe(2)
  })

  it('④ n=2·L=2·k=4 — 긴 예약이 칸을 다 차지하면 짧은 예약이 두 칸에 분산돼 얹힌다', () => {
    const { pos, depth } = place([long('L1'), long('L2'), short('a'), short('b')], 2)
    expect(pos.a).toEqual([0, 1])
    expect(pos.b).toEqual([1, 1])
    expect(depth).toBe(2)
  })

  it('n=3·L=1 — 빈 칸 2개에 번갈아 쌓이고 긴 예약 칸은 비어 있다', () => {
    const { pos, depth } = place([long('L'), short('a'), short('b'), short('c')], 3)
    expect(pos.L).toEqual([0, 0])
    expect(pos.a).toEqual([1, 0])
    expect(pos.b).toEqual([2, 0])
    expect(pos.c).toEqual([1, 1])
    expect(depth).toBe(2)
  })

  it('빈 칸 1개에 짧은 예약이 몰리면 그 칸 깊이만큼 밴드가 두꺼워진다(수용한 대가)', () => {
    const shorts = ['a', 'b', 'c', 'd'].map(short)
    const { pos, depth } = place([long('L'), ...shorts], 2)
    for (const id of ['a', 'b', 'c', 'd']) expect(pos[id][0]).toBe(1)
    expect(depth).toBe(4)
  })

  it('EMPTY_LANE_STACK_CAP 을 낮추면 상한을 넘는 순간 종전 분산으로 돌아간다', () => {
    // 기본값 Infinity = 화면정의서 그대로. 세로가 과하면 이 값만 낮춘다(코드 재작성 없음).
    const shorts = ['a', 'b', 'c', 'd'].map(short)
    const { pos, depth } = place([long('L'), ...shorts], 2, 2)
    expect(pos.a).toEqual([1, 0])
    expect(pos.b).toEqual([1, 1])
    expect(pos.c).toEqual([1, 2]) // 여기까지는 빈 칸 우선(깊이 차 1)
    expect(pos.d[0]).toBe(0) // 깊이 차 2 도달 → 긴 예약 위로
    expect(depth).toBe(3) // 상한 없으면 4행
  })
})

describe('packPages — unit 경계 페이지 분할 (경계 unit 은 압축, 이월 없음)', () => {
  const u = (key: string, slots: number): UnitLike => ({ key, slots })

  it('총 slots <= budget → 단일 페이지', () => {
    const units = [u('a', 3), u('b', 2), u('c', 2)] // total 7
    expect(packPages(units, 8)).toEqual([{ slotStart: 0, slotEnd: 7 }])
  })

  it('unit 경계에서만 자른다 — 딱 맞아떨어지면 기존과 동일', () => {
    const units = [u('a', 3), u('b', 2), u('c', 2), u('d', 1), u('e', 1)] // total 9
    // 페이지0 = a+b+c+d (3+2+2+1 = 8칸), 페이지1 = e
    expect(packPages(units, 8)).toEqual([
      { slotStart: 0, slotEnd: 8 },
      { slotStart: 8, slotEnd: 9 },
    ])
  })

  it('마지막 unit 이 남은 칸보다 크면 쪼개지 않고 압축 — 다음 페이지는 그 다음 unit 부터', () => {
    // a:5 b:2 c:2, budget 4. a 는 4칸으로 압축되어 페이지0 을 혼자 채운다.
    const units = [u('a', 5), u('b', 2), u('c', 2)]
    expect(packPages(units, 4)).toEqual([
      { slotStart: 0, slotEnd: 5 }, // a 통째 (표시는 4칸)
      { slotStart: 5, slotEnd: 9 }, // b + c
    ])
  })

  it('거대 unit(slots > budget) → 그 unit 이 한 페이지를 통째로 쓴다(budget 칸으로 압축)', () => {
    const units = [u('big', 20), u('next', 3)] // budget 8
    expect(packPages(units, 8)).toEqual([
      { slotStart: 0, slotEnd: 20 },
      { slotStart: 20, slotEnd: 23 },
    ])
  })

  it('빈 units → 빈 페이지', () => {
    expect(packPages([], 8)).toEqual([])
  })
})

describe('buildPageColumns — 시작 slot + budget → 컬럼 (unit 경계 · 경계 unit 압축)', () => {
  const u = (key: string, slots: number): UnitLike => ({ key, slots })

  it('페이지에 온전히 들어가는 unit 들', () => {
    const units = [u('a', 3), u('b', 2)]
    expect(buildPageColumns(units, 0, 8)).toEqual([
      { unitIndex: 0, subColStart: 0, subColCount: 3, slotsStartIdx: 0, unitSlots: 3 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 3, unitSlots: 2 },
    ])
  })

  it('남은 칸보다 큰 마지막 unit 은 남은 칸수로 압축(카드는 전량 그 안에 배치)', () => {
    // budget 8: a(1) + b(5) 로 6칸 사용, c(3)는 남은 2칸으로 압축
    const units = [u('a', 1), u('b', 5), u('c', 3)]
    expect(buildPageColumns(units, 0, 8)).toEqual([
      { unitIndex: 0, subColStart: 0, subColCount: 1, slotsStartIdx: 0, unitSlots: 1 },
      { unitIndex: 1, subColStart: 0, subColCount: 5, slotsStartIdx: 1, unitSlots: 5 },
      { unitIndex: 2, subColStart: 0, subColCount: 2, slotsStartIdx: 6, unitSlots: 3 },
    ])
  })

  it('시작 slot 이 unit 중간을 가리키면 그 unit 의 처음으로 스냅한다', () => {
    // a[0,1) b[1,6) c[6,9). startSlot 3 은 b 의 중간 → b 부터 시작
    const units = [u('a', 1), u('b', 5), u('c', 3)]
    expect(buildPageColumns(units, 3, 8)).toEqual([
      { unitIndex: 1, subColStart: 0, subColCount: 5, slotsStartIdx: 0, unitSlots: 5 },
      { unitIndex: 2, subColStart: 0, subColCount: 3, slotsStartIdx: 5, unitSlots: 3 },
    ])
  })

  it('unit.slots > budget → 그 unit 하나만, budget 칸으로 압축', () => {
    const units = [u('a', 20), u('b', 3)]
    expect(buildPageColumns(units, 0, 8)).toEqual([
      { unitIndex: 0, subColStart: 0, subColCount: 8, slotsStartIdx: 0, unitSlots: 20 },
    ])
  })

  it('시작 slot 이 범위를 넘으면 빈 컬럼', () => {
    expect(buildPageColumns([u('a', 2)], 5, 8)).toEqual([])
    expect(buildPageColumns([], 0, 8)).toEqual([])
  })
})
