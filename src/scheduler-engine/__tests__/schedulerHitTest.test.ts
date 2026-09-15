/**
 * hitTest — 컬럼별 sub-col 분모(레인 수) 규칙.
 *
 * 모델 A(레인폭 = 동시겹침)에서는 컬럼마다 레인 수가 다르다. hit 의 subColIndex 를
 * 전역 patientSlotSpan 으로 나누면 1레인 컬럼에서 좌표가 절반 폭으로 잡혀
 * 드롭 프리뷰·클릭 위치가 어긋난다 → 컬럼이 실은 몇 레인인지(column.slots)를 우선한다.
 */
import { describe, expect, it } from 'vitest'
import { hitTest } from '../schedulerHitTest'
import type { BandCompatible, FlatColumn } from '../types/scheduler.types'

const BANDS: BandCompatible[] = [
  { startMinute: 540, endMinute: 570, topPx: 0, heightPx: 80 },
]

function column(overrides: Partial<FlatColumn> = {}): FlatColumn {
  return {
    key: '2026-06-05__김대표',
    date: '2026-06-05',
    resourceId: '김대표',
    resourceLabel: '김대표',
    ancestors: [],
    index: 0,
    leftPx: 0,
    widthPx: 200,
    ...overrides,
  }
}

describe('hitTest — sub-col 분모', () => {
  it('column.slots 가 있으면 전역 patientSlotSpan 대신 그 값으로 나눈다', () => {
    // 200px 컬럼이 실제로는 2레인(100px씩). 전역 N=4 로 나누면 50px 씩이라 x=150 이 index 3 이 된다.
    const hit = hitTest({
      mouseX: 150,
      mouseY: 10,
      columns: [column({ slots: 2 })],
      bandInfos: BANDS,
      patientSlotSpan: 4,
    })
    expect(hit.subColIndex).toBe(1)
  })

  it('레인 1개 컬럼은 어디를 찍어도 subColIndex 0', () => {
    const hit = hitTest({
      mouseX: 195,
      mouseY: 10,
      columns: [column({ slots: 1 })],
      bandInfos: BANDS,
      patientSlotSpan: 5,
    })
    expect(hit.subColIndex).toBe(0)
  })

  it('column.slots 미전달(V2 경로)이면 전역 patientSlotSpan 으로 폴백', () => {
    const hit = hitTest({
      mouseX: 150,
      mouseY: 10,
      columns: [column()],
      bandInfos: BANDS,
      patientSlotSpan: 4,
    })
    expect(hit.subColIndex).toBe(3)
  })

  it('컬럼마다 레인 수가 달라도 각자 자기 분모로 계산한다', () => {
    const cols = [
      column({ key: 'A', leftPx: 0, widthPx: 100, slots: 1 }),
      column({ key: 'B', leftPx: 100, widthPx: 200, slots: 4 }),
    ]
    expect(hitTest({ mouseX: 90, mouseY: 10, columns: cols, bandInfos: BANDS, patientSlotSpan: 4 }).subColIndex).toBe(0)
    // B 컬럼: 200px / 4레인 = 50px. x=280 → 컬럼 내 offset 180 → index 3
    const hitB = hitTest({ mouseX: 280, mouseY: 10, columns: cols, bandInfos: BANDS, patientSlotSpan: 4 })
    expect(hitB.columnKey).toBe('B')
    expect(hitB.subColIndex).toBe(3)
  })
})
