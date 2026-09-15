import { describe, it, expect } from 'vitest'
import { buildCardMenu, toApiState } from '../appointmentCardMenu'

// ═══════════════════════════════════════════════════════════
// 카드 ⋮ 메뉴 구성 (화면 × 상태)
// ═══════════════════════════════════════════════════════════

describe('buildCardMenu — 항목 구성', () => {

  it('예약 화면: 변경/취소/초기화/삭제', () => {
    const buttons = buildCardMenu('APPOINTMENT', '00')
    expect(buttons.map(b => b.value)).toEqual(['EDIT', 'CANCEL', 'RESTORE', 'DELETE'])
  })

  it('진료 화면: 접수대기/완료/미이행/취소/초기화/삭제', () => {
    const buttons = buildCardMenu('TREATMENT', '01')
    expect(buttons.map(b => b.value)).toEqual(['WAITING', 'COMPLETE', 'NOSHOW', 'CANCEL', 'RESTORE', 'DELETE'])
  })

  it('삭제 라벨은 화면마다 다르다', () => {
    const label = (dataType: 'APPOINTMENT' | 'TREATMENT') =>
      buildCardMenu(dataType, '00').find(b => b.value === 'DELETE')!.displayLabel

    expect(label('APPOINTMENT')).toBe('예약 삭제')
    expect(label('TREATMENT')).toBe('진료 삭제')
  })
})

describe('buildCardMenu — 초기화 활성 여부', () => {

  const restoreDisabled = (dataType: 'APPOINTMENT' | 'TREATMENT', status: string) =>
    buildCardMenu(dataType, status).find(b => b.value === 'RESTORE')!.disabled

  it('상태 00: disabled (예약·진료 공통) — 되돌릴 대상이 없다', () => {
    expect(restoreDisabled('APPOINTMENT', '00')).toBe(true)
    expect(restoreDisabled('TREATMENT', '00')).toBe(true)
  })

  it('예약 화면 상태 03(취소): enabled', () => {
    expect(restoreDisabled('APPOINTMENT', '03')).toBe(false)
  })

  it('진료 화면 상태 01/02/03: enabled', () => {
    expect(restoreDisabled('TREATMENT', '01')).toBe(false)
    expect(restoreDisabled('TREATMENT', '02')).toBe(false)
    expect(restoreDisabled('TREATMENT', '03')).toBe(false)
  })

  it('진료 화면 상태 05(접수대기): enabled — 접수 취소 경로다', () => {
    expect(restoreDisabled('TREATMENT', '05')).toBe(false)
  })

  it('접수대기는 예약 화면에 없다 — hover 퀵액션과 같은 진료 전용 동작이다', () => {
    expect(buildCardMenu('APPOINTMENT', '00').some(b => b.value === 'WAITING')).toBe(false)
  })

  it('disabled 여도 항목은 사라지지 않는다 (메뉴 위치 고정)', () => {
    expect(buildCardMenu('TREATMENT', '00').map(b => b.value))
      .toEqual(buildCardMenu('TREATMENT', '02').map(b => b.value))
  })
})

describe('buildCardMenu — 접수대기 활성 여부', () => {

  const waitingDisabled = (status: string) =>
    buildCardMenu('TREATMENT', status).find(b => b.value === 'WAITING')!.disabled

  it('상태 05(접수대기): disabled — 이미 접수된 건이다', () => {
    expect(waitingDisabled('05')).toBe(true)
  })

  it('상태 00/01/02/03: enabled', () => {
    expect(waitingDisabled('00')).toBe(false)
    expect(waitingDisabled('01')).toBe(false)
    expect(waitingDisabled('02')).toBe(false)
    expect(waitingDisabled('03')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 액션 → API state
// ═══════════════════════════════════════════════════════════

describe('toApiState', () => {

  it('RESTORE(초기화)만 default_ 로 어긋난다', () => {
    expect(toApiState('RESTORE')).toBe('default_')
  })

  it('나머지는 소문자 변환', () => {
    expect(toApiState('COMPLETE')).toBe('complete')
    expect(toApiState('NOSHOW')).toBe('noshow')
    expect(toApiState('CANCEL')).toBe('cancel')
    // hover 퀵액션 [접수]와 같은 state 여야 한다
    expect(toApiState('WAITING')).toBe('waiting')
  })
})
