import { describe, expect, it } from 'vitest'
import { dateAtSlot, reanchorArgsForSlot, totalSlotsOf } from '../navSlots'

// 의사 5명(06-01) + 3명(06-02), 각 1칸 = 8 slots. 의사 多 → 하루가 budget 초과(within-day 페이징)를 모사.
const overflowUnits = [
  { date: '2026-06-01', slots: 1 }, // slot 0  A
  { date: '2026-06-01', slots: 1 }, // slot 1  B
  { date: '2026-06-01', slots: 1 }, // slot 2  C
  { date: '2026-06-01', slots: 1 }, // slot 3  D
  { date: '2026-06-01', slots: 1 }, // slot 4  E
  { date: '2026-06-02', slots: 1 }, // slot 5  A
  { date: '2026-06-02', slots: 1 }, // slot 6  B
  { date: '2026-06-02', slots: 1 }, // slot 7  C
]

describe('dateAtSlot — 전역 slot → {date, startSlot}', () => {
  it('하루 내 여러 slot 은 같은 날짜·같은 startSlot', () => {
    expect(dateAtSlot(overflowUnits, 0, 'x')).toEqual({ date: '2026-06-01', startSlot: 0 })
    expect(dateAtSlot(overflowUnits, 3, 'x')).toEqual({ date: '2026-06-01', startSlot: 0 })
    expect(dateAtSlot(overflowUnits, 4, 'x')).toEqual({ date: '2026-06-01', startSlot: 0 })
  })
  it('날짜 경계 — slot5 부터 06-02, startSlot=5', () => {
    expect(dateAtSlot(overflowUnits, 5, 'x')).toEqual({ date: '2026-06-02', startSlot: 5 })
    expect(dateAtSlot(overflowUnits, 7, 'x')).toEqual({ date: '2026-06-02', startSlot: 5 })
  })
  it('전체 초과 → 마지막 날짜로 clamp', () => {
    expect(dateAtSlot(overflowUnits, 99, 'x')).toEqual({ date: '2026-06-02', startSlot: 5 })
  })
  it('빈 units → fallbackDate', () => {
    expect(dateAtSlot([], 3, '2026-06-09')).toEqual({ date: '2026-06-09', startSlot: 0 })
  })
  it('slots>1 인 unit 누적 정확', () => {
    const units = [
      { date: '2026-06-01', slots: 2 }, // slot 0,1
      { date: '2026-06-01', slots: 3 }, // slot 2,3,4
      { date: '2026-06-02', slots: 1 }, // slot 5
    ]
    expect(dateAtSlot(units, 1, 'x')).toEqual({ date: '2026-06-01', startSlot: 0 })
    expect(dateAtSlot(units, 4, 'x')).toEqual({ date: '2026-06-01', startSlot: 0 })
    expect(dateAtSlot(units, 5, 'x')).toEqual({ date: '2026-06-02', startSlot: 5 })
  })
})

describe('reanchorArgsForSlot — within-day 페이징(의사 多)', () => {
  it('🔑 #1 within-day: budget4, 헤더> (target=4) → 06-01 유지·offset 4 (5번째 의사 E 노출)', () => {
    // colOffset 0 에서 06-01 A~D 보던 중 헤더 > → target = 0+4 = 4
    expect(reanchorArgsForSlot(overflowUnits, 4, 'x')).toEqual({ date: '2026-06-01', offset: 4 })
    // → selectedDate 06-01 유지, colOffset 4 → 06-01 E + 06-02 A,B,C (좌측 날짜 안 끌림)
  })
  it('🔑 날짜 경계 넘어감: budget3 두 번째 > (target=6) → 06-02 재고정·offset 1', () => {
    // colOffset 3 에서 06-01 D,E + 06-02 A 보던 중 > → target = 3+3 = 6 → 06-02 내부 2번째 컬럼
    expect(reanchorArgsForSlot(overflowUnits, 6, 'x')).toEqual({ date: '2026-06-02', offset: 1 })
    // → selectedDate 06-02 로 재구성, colOffset 1 (within-06-02 인덱스 = 불변)
  })
  it('target 0 → 첫 날짜 offset 0', () => {
    expect(reanchorArgsForSlot(overflowUnits, 0, 'x')).toEqual({ date: '2026-06-01', offset: 0 })
  })
  it('음수 target 방어 → 0 clamp', () => {
    expect(reanchorArgsForSlot(overflowUnits, -5, 'x')).toEqual({ date: '2026-06-01', offset: 0 })
  })
})

describe('totalSlotsOf', () => {
  it('slots 합 (각 최소 1)', () => {
    expect(totalSlotsOf(overflowUnits)).toBe(8)
    expect(totalSlotsOf([{ date: 'd', slots: 2 }, { date: 'd', slots: 3 }])).toBe(5)
    expect(totalSlotsOf([{ date: 'd', slots: 0 }])).toBe(1) // 0 → 1 보정
    expect(totalSlotsOf([])).toBe(0)
  })
})
