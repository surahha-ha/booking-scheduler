import { describe, expect, it } from 'vitest'
import type { BandInfo, Rect } from '@/scheduler-engine/redesign/layoutTypes'
import type { ResolvedColumn } from '@/scheduler-engine/redesign/layoutPipeline'
import { formatDateLabel, toV2Bands, toV2Columns, toV2HeaderTree, toV2Rects } from '../v3ParityAdapter'

// redesign ResolvedColumn 의 테스트 최소 형태(어댑터가 읽는 필드만)
function col(columnIndex: number, date: string, doctorId: string, doctorName: string, leftPx = 0, widthPx = 100): ResolvedColumn {
  return {
    columnIndex,
    unitIndex: columnIndex,
    unit: { key: `${date}__${doctorId}`, date, doctorId, doctorName, weekday: 1, slots: 1 },
    subColCount: 1,
    subColStart: 0,
    unitSlots: 1,
    cards: [],
    arrange: { placed: [], floating: [], expandedRows: {} },
    leftPx,
    widthPx,
  } as ResolvedColumn
}

describe('v3ParityAdapter — formatDateLabel', () => {
  it('YYYY-MM-DD → MM-DD (요일)', () => {
    expect(formatDateLabel('2026-06-05')).toBe('06-05 (금)') // 2026-06-05 = 금요일
  })
  it('불량 입력은 원문 반환', () => {
    expect(formatDateLabel('bad')).toBe('bad')
  })
})

describe('v3ParityAdapter — toV2Bands', () => {
  const bands: BandInfo[] = [
    { index: 0, startMin: 540, endMin: 570, isBreak: false, maxRows: 1, heightPx: 50, topPx: 0 },
    { index: 1, startMin: 720, endMin: 750, isBreak: true, breakLabel: '점심시간', maxRows: 0, heightPx: 30, topPx: 50 },
  ]
  it('startMin/endMin→startMinute/endMinute, isBreak→blocked, index→bandIndex', () => {
    const out = toV2Bands(bands)
    expect(out[0]).toMatchObject({ startMinute: 540, endMinute: 570, topPx: 0, heightPx: 50, bandIndex: 0, blocked: false, time: '09:00' })
    expect(out[1]).toMatchObject({ startMinute: 720, endMinute: 750, bandIndex: 1, blocked: true, blockLabel: '점심시간', time: '12:00' })
  })
})

describe('v3ParityAdapter — toV2Columns', () => {
  it('ResolvedColumn → FlatColumn (key=unit.key, resourceId=doctorId)', () => {
    const cols = [col(0, '2026-06-05', '김원장', '김원장', 0, 120), col(1, '2026-06-05', '이원장', '이원장', 120, 120)]
    const out = toV2Columns(cols)
    expect(out[0]).toMatchObject({
      key: '2026-06-05__김원장',
      date: '2026-06-05',
      resourceId: '김원장',
      resourceLabel: '김원장',
      index: 0,
      leftPx: 0,
      widthPx: 120,
    })
    expect(out[0].ancestors[0]).toMatchObject({ type: 'date', id: '2026-06-05' })
    expect(out[1].leftPx).toBe(120)
  })
})

describe('v3ParityAdapter — toV2HeaderTree', () => {
  it('날짜 > 의사 트리, leaf.key=unit.key=FlatColumn.key 통일', () => {
    const cols = [col(0, '2026-06-05', '김원장', '김원장'), col(1, '2026-06-05', '이원장', '이원장')]
    const tree = toV2HeaderTree(cols)
    expect(tree).toHaveLength(1) // 날짜 1개
    expect(tree[0]).toMatchObject({ key: '2026-06-05', type: 'date', colSpan: 2, depth: 0 })
    expect(tree[0].children).toHaveLength(2)
    const leaf = tree[0].children![0]
    expect(leaf).toMatchObject({ key: '2026-06-05__김원장', type: 'doctor', colSpan: 1, depth: 1 })
    expect(leaf.leafMeta).toMatchObject({ date: '2026-06-05', resourceId: '김원장', resourceLabel: '김원장' })
    // leaf.key 와 toV2Columns 의 key 가 동일해야 Header/Grid 매칭
    expect(leaf.key).toBe(toV2Columns(cols)[0].key)
  })

  it('여러 날짜: 날짜 순서 보존 + 날짜별 의사 그룹핑', () => {
    const cols = [
      col(0, '2026-06-05', 'A', 'A'),
      col(1, '2026-06-05', 'B', 'B'),
      col(2, '2026-06-06', 'A', 'A'),
    ]
    const tree = toV2HeaderTree(cols)
    expect(tree.map(n => n.key)).toEqual(['2026-06-05', '2026-06-06'])
    expect(tree[0].colSpan).toBe(2)
    expect(tree[1].colSpan).toBe(1)
  })
})

describe('v3ParityAdapter — toV2Rects', () => {
  const cols = [col(0, '2026-06-05', '김원장', '김원장'), col(1, '2026-06-05', '이원장', '이원장')]
  const rects: Rect[] = [
    { id: 'appt-1', columnIndex: 0, top: 0, left: 4, width: 96, height: 38, z: 0, isFloating: false, isLayered: false },
    { id: 'appt-2', columnIndex: 1, top: 38, left: 124, width: 86, height: 38, z: 10, isFloating: true, isLayered: true },
  ]
  it('id→appointmentId, z→zIndex, columnIndex→columnKey(unit.key), cardDisplayTier=standard', () => {
    const out = toV2Rects(rects, cols)
    expect(out[0]).toMatchObject({
      appointmentId: 'appt-1',
      columnKey: '2026-06-05__김원장',
      top: 0,
      left: 4,
      width: 96,
      height: 38,
      zIndex: 0,
      cardDisplayTier: 'standard',
    })
    expect(out[1]).toMatchObject({ appointmentId: 'appt-2', columnKey: '2026-06-05__이원장', zIndex: 10 })
  })
  it('columnKey 는 toV2Columns 의 key 와 동일(Layer↔Grid 매칭)', () => {
    const out = toV2Rects(rects, cols)
    expect(out[0].columnKey).toBe(toV2Columns(cols)[0].key)
  })
  it('범위 밖 columnIndex 는 columnKey 빈 문자열 fallback', () => {
    const out = toV2Rects([{ id: 'x', columnIndex: 99, top: 0, left: 0, width: 10, height: 10, z: 0, isFloating: false, isLayered: false }], cols)
    expect(out[0].columnKey).toBe('')
  })
})
