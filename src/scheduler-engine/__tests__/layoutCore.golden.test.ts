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

  it('G-arrange-6: 같은 시각 10건(긴 1 + 동일 9), N=3 → row-major 분산(col×row)', () => {
    // 긴예약 1 + 동일 9건 → col0,1,2 에 row 별 균형 분포. 깊이 ceil(10/3)=4.
    const cards = [
      { id: 'long', startMin: 660, endMin: 780 }, // 긴 예약(dur 120) → col0 row0
      ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, startMin: 660, endMin: 690 })),
    ]
    const r = arrangeCards(cards, 3)
    // (column,subRow) 로 위치 확인 — 모든 카드
    const pos: Record<string, [number, number]> = {}
    for (const p of r.placed) pos[p.id] = [p.column, p.subRow]
    for (const f of r.floating) pos[f.id] = [f.column, f.subRow]
    // 긴예약 = col0 row0
    expect(pos.long).toEqual([0, 0])
    // row0: long(col0), s1(col1), s2(col2)
    expect(pos.s1).toEqual([1, 0])
    expect(pos.s2).toEqual([2, 0])
    // row1: s3(col0, long 위 layering), s4(col1), s5(col2)
    expect(pos.s3).toEqual([0, 1])
    expect(pos.s4).toEqual([1, 1])
    expect(pos.s5).toEqual([2, 1])
    // row2
    expect(pos.s6).toEqual([0, 2])
    expect(pos.s7).toEqual([1, 2])
    expect(pos.s8).toEqual([2, 2])
    // row3: s9(col0)
    expect(pos.s9).toEqual([0, 3])
    // band 깊이 = 4 (한 칸에 9개 쌓던 8 보다 짧음)
    expect(r.expandedRows[660]).toBe(4)
    // s3 은 긴예약 위 floating(layering), s4·s5 는 동일 길이 위 → floatLevel 로 구분(width 는 computeRects)
    const s3 = r.floating.find(f => f.id === 's3')!
    expect(s3.floatLevel).toBeGreaterThan(0) // long 위 → −10 layering
    const s4 = r.floating.find(f => f.id === 's4')!
    expect(s4.floatLevel).toBe(0) // 동일 길이 위 → full width
  })
})

describe('packPages — sub-column 단위 연속 페이지 분할 (압축 → 분할 재설계)', () => {
  const u = (key: string, slots: number): UnitLike => ({ key, slots })

  it('총 slots <= budget → 단일 페이지', () => {
    const units = [u('a', 3), u('b', 2), u('c', 2)] // total 7
    expect(packPages(units, 8)).toEqual([{ slotStart: 0, slotEnd: 7 }])
  })

  it('총 slots > budget → 글로벌 slot 을 budget 칸씩 분할', () => {
    const units = [u('a', 3), u('b', 2), u('c', 2), u('d', 1), u('e', 1)] // total 9
    expect(packPages(units, 8)).toEqual([
      { slotStart: 0, slotEnd: 8 },
      { slotStart: 8, slotEnd: 9 },
    ])
  })

  it('거대 unit(slots > budget) → 여러 페이지에 걸쳐 분할 (압축 아님)', () => {
    const units = [u('big', 20), u('next', 3)] // total 23, budget 8
    expect(packPages(units, 8)).toEqual([
      { slotStart: 0, slotEnd: 8 },
      { slotStart: 8, slotEnd: 16 },
      { slotStart: 16, slotEnd: 23 },
    ])
  })

  it('빈 units → 빈 페이지', () => {
    expect(packPages([], 8)).toEqual([])
  })
})

describe('buildPageColumns — 페이지 글로벌 slot 범위 → 컬럼 (carry-over)', () => {
  const u = (key: string, slots: number): UnitLike => ({ key, slots })

  it('페이지에 온전히 들어가는 unit 들', () => {
    const units = [u('a', 3), u('b', 2)] // a:[0,3) b:[3,5)
    const pages = packPages(units, 8) // [{0,5}]
    expect(buildPageColumns(units, pages[0])).toEqual([
      { unitIndex: 0, subColStart: 0, subColCount: 3, slotsStartIdx: 0, unitSlots: 3 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 3, unitSlots: 2 },
    ])
  })

  it('경계에 걸친 unit 은 부분 sub-col (carry-over)', () => {
    // a:5칸, budget 4 → 페이지0 [0,4): a sub0~3 / 페이지1 [4,5): a sub4
    const units = [u('a', 5)]
    const pages = packPages(units, 4) // [{0,4},{4,5}]
    expect(buildPageColumns(units, pages[0])).toEqual([
      { unitIndex: 0, subColStart: 0, subColCount: 4, slotsStartIdx: 0, unitSlots: 5 },
    ])
    expect(buildPageColumns(units, pages[1])).toEqual([
      { unitIndex: 0, subColStart: 4, subColCount: 1, slotsStartIdx: 0, unitSlots: 5 },
    ])
  })

  it('잔여 칸 + 다음 unit 이어짐 (날짜/의사 연속)', () => {
    // a:5 b:2 c:2, budget 4. global a[0,5) b[5,7) c[7,9)
    const units = [u('a', 5), u('b', 2), u('c', 2)]
    const pages = packPages(units, 4) // [{0,4},{4,8},{8,9}]
    // 페이지1 [4,8): a sub4 + b sub0~1 + c sub0
    expect(buildPageColumns(units, pages[1])).toEqual([
      { unitIndex: 0, subColStart: 4, subColCount: 1, slotsStartIdx: 0, unitSlots: 5 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 1, unitSlots: 2 },
      { unitIndex: 2, subColStart: 0, subColCount: 1, slotsStartIdx: 3, unitSlots: 2 },
    ])
    // 페이지2 [8,9): c sub1
    expect(buildPageColumns(units, pages[2])).toEqual([
      { unitIndex: 2, subColStart: 1, subColCount: 1, slotsStartIdx: 0, unitSlots: 2 },
    ])
  })

  it('중간 조각만 (거대 unit 양끝 잘림)', () => {
    // a:10칸, budget 4 → 페이지1 [4,8): a sub4~7
    const units = [u('a', 10)]
    const pages = packPages(units, 4) // [{0,4},{4,8},{8,10}]
    expect(buildPageColumns(units, pages[1])).toEqual([
      { unitIndex: 0, subColStart: 4, subColCount: 4, slotsStartIdx: 0, unitSlots: 10 },
    ])
  })
})
