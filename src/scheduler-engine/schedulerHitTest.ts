/**
 * 스케줄러 HitTest — Band 기반
 *
 * 순수 계산 모듈. Vue 의존성 없음.
 *
 * 3-phase 엔진 전환 후:
 *   - TimeSlot 대신 BandCompatible (BandInfo 호환) 사용
 *   - subColIndex 산출 (N칸 보기)
 *   - minuteToBandTopPx / minuteToBandBottomPx: band 경계 기반 좌표
 */

import type {
  FlatColumn,
  BandCompatible,
  HitTestInput,
  HitTestResult,
} from './types/scheduler.types'
import { EMPTY_ROW_GAP_PX } from './redesign/layoutPipeline'

/**
 * hitTest에서 band를 찾지 못했을 때 사용하는 sentinel 값.
 */
export const INVALID_MINUTE = NaN

/** minute 값이 유효한지 확인 */
export function isValidMinute(minute: number): boolean {
  return !Number.isNaN(minute)
}

// ═══════════════════════════════════════════════════════════
// hitTest
// ═══════════════════════════════════════════════════════════

/**
 * 마우스 좌표 → 논리 위치 변환
 */
export function hitTest(input: HitTestInput): HitTestResult {
  const { mouseX, mouseY, columns, bandInfos, patientSlotSpan = 1 } = input

  // X → column 매핑
  const column = findColumnAtX(mouseX, columns)

  // sub-col 분모는 컬럼별 실제 레인 수(column.slots) 우선 — 모델 A 는 컬럼마다 레인폭이 다르다.
  // 전역 patientSlotSpan 으로 나누면 1레인 컬럼에서 hit 이 조각난 폭으로 잡힌다. 미전달(V2)이면 폴백.
  const N = Math.max(1, column?.slots ?? patientSlotSpan)

  // X → sub-column 매핑 (column 내부)
  let subColIndex = 0
  if (column && N > 1 && column.widthPx > 0) {
    const subColWidth = column.widthPx / N
    const offsetInCol = mouseX - column.leftPx
    subColIndex = Math.max(0, Math.min(N - 1, Math.floor(offsetInCol / subColWidth)))
  }

  // Y → band 매핑
  const bandResult = findBandAtY(mouseY, bandInfos)

  // band의 startMinute를 기본 minute로 사용
  let minute = INVALID_MINUTE
  if (bandResult.band) {
    // band 내부에서 시간 비례로 minute 계산 (snap 전)
    const ratio = bandResult.band.heightPx > 0
      ? (mouseY - bandResult.band.topPx) / bandResult.band.heightPx
      : 0
    const clampedRatio = Math.max(0, Math.min(1, ratio))
    const bandDuration = bandResult.band.endMinute - bandResult.band.startMinute
    minute = bandResult.band.startMinute + clampedRatio * bandDuration
  }

  return {
    columnKey: column?.key ?? null,
    column: column ?? null,
    date: column?.date ?? null,
    resourceId: column?.resourceId ?? null,
    minute,
    band: bandResult.band,
    bandIndex: bandResult.index,
    subColIndex,
  }
}

// ═══════════════════════════════════════════════════════════
// Band 경계 기반 좌표 함수
// ═══════════════════════════════════════════════════════════

/**
 * minute → 해당 band의 topPx (band 시작 경계)
 *
 * drag preview의 top 계산에 사용.
 * band 내부 시간 비례 아님 — band 시작 경계에 snap.
 */
export function minuteToBandTopPx(
  minute: number,
  bandInfos: BandCompatible[]
): number {
  if (bandInfos.length === 0) return 0

  for (const band of bandInfos) {
    if (minute >= band.startMinute && minute < band.endMinute) {
      return band.topPx
    }
  }

  // 범위 밖: 마지막 band 하단
  const last = bandInfos[bandInfos.length - 1]
  if (minute >= last.endMinute) {
    return last.topPx + last.heightPx
  }

  return bandInfos[0].topPx
}

/**
 * band 의 '카드 바닥' = 마지막 행의 바닥. band 하단 여백(EMPTY_ROW_GAP_PX)은 그 시간대에
 * 예약을 추가하는 클릭 자리라 카드가 쓰지 않으므로 제외한다 — 그래야 resize 프리뷰 바닥이
 * 실제 카드 바닥과 일치한다.
 * ⭐판정은 `hasGap`(여백이 실제로 붙었는가)이다. `maxRows > 0` 로 보면 카드가 지나가기만 하는
 * band(시작 카드 0 · 여백은 있음)에서 바닥을 여백까지 끌어내려 그 추가 자리를 덮는다.
 * hasGap 미전달(TimeSlot 등 구 호환)이면 종전대로 maxRows 로 떨어진다.
 */
function cardBottomOfBand(band: BandCompatible): number {
  const bottom = band.topPx + band.heightPx
  const hasGap = band.hasGap ?? (band.maxRows ?? 0) > 0
  return hasGap ? bottom - EMPTY_ROW_GAP_PX : bottom
}

/**
 * minute → band 내부까지 시간 비례로 보간한 topPx
 *
 * 현재 시각선처럼 band 경계에 걸리지 않는 임의의 분을 그릴 때 사용.
 * minuteToBandTopPx 는 band 시작 경계로 snap 하므로, 예약단위가 커질수록
 * (45분 등) 선이 최대 '단위-1분' 만큼 위로 밀린다 — 그 용도로는 쓰지 않는다.
 *
 * band 높이는 시간 비례가 아니라 예약 행 수로 정해지므로(computeBandHeights),
 * 보간은 band 안에서의 상대 위치만 시간 비례로 맞춘다.
 */
export function minuteToBandOffsetPx(
  minute: number,
  bandInfos: BandCompatible[]
): number {
  if (bandInfos.length === 0) return 0

  for (const band of bandInfos) {
    if (minute >= band.startMinute && minute < band.endMinute) {
      const span = band.endMinute - band.startMinute
      if (span <= 0) return band.topPx
      return band.topPx + ((minute - band.startMinute) / span) * band.heightPx
    }
  }

  // 범위 밖: 마지막 band 하단
  const last = bandInfos[bandInfos.length - 1]
  if (minute >= last.endMinute) {
    return last.topPx + last.heightPx
  }

  return bandInfos[0].topPx
}

/**
 * minute → 해당 band의 bottomPx (band 종료 경계)
 *
 * resize/drag preview의 height 계산에 사용.
 * endMinute가 band 경계에 정확히 일치하면 해당 band의 하단 반환.
 */
export function minuteToBandBottomPx(
  minute: number,
  bandInfos: BandCompatible[]
): number {
  if (bandInfos.length === 0) return 0

  // endMinute는 band.endMinute와 같을 수 있음 (exclusive)
  // 이 경우 해당 band의 하단을 반환
  for (const band of bandInfos) {
    if (minute > band.startMinute && minute <= band.endMinute) {
      return cardBottomOfBand(band)
    }
  }

  // 정확히 첫 band.startMinute인 경우
  if (bandInfos.length > 0 && minute <= bandInfos[0].startMinute) {
    return bandInfos[0].topPx
  }

  // 범위 밖
  return cardBottomOfBand(bandInfos[bandInfos.length - 1])
}

/**
 * minute 범위 → height 계산 (band 경계 기반)
 */
export function minuteRangeToBandHeight(
  startMinute: number,
  endMinute: number,
  bandInfos: BandCompatible[]
): number {
  return minuteToBandBottomPx(endMinute, bandInfos) - minuteToBandTopPx(startMinute, bandInfos)
}

// ═══════════════════════════════════════════════════════════
// 내부 검색 함수
// ═══════════════════════════════════════════════════════════

function findColumnAtX(
  x: number,
  columns: FlatColumn[]
): FlatColumn | null {
  if (columns.length === 0) return null
  if (x < 0) return null
  const lastCol = columns[columns.length - 1]
  if (x >= lastCol.leftPx + lastCol.widthPx) return null

  let lo = 0
  let hi = columns.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const col = columns[mid]
    if (x < col.leftPx) hi = mid - 1
    else if (x >= col.leftPx + col.widthPx) lo = mid + 1
    else return col
  }
  return null
}

function findBandAtY(
  y: number,
  bands: BandCompatible[]
): { band: BandCompatible | null; index: number } {
  if (bands.length === 0) return { band: null, index: -1 }
  if (y < 0) return { band: null, index: -1 }

  const last = bands[bands.length - 1]
  if (y >= last.topPx + last.heightPx) return { band: null, index: -1 }

  let lo = 0
  let hi = bands.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const band = bands[mid]
    if (y < band.topPx) hi = mid - 1
    else if (y >= band.topPx + band.heightPx) lo = mid + 1
    else return { band, index: mid }
  }
  return { band: null, index: -1 }
}
