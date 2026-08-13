// — 예약장부 설정값(reservationSettingStore) → 엔진 settings 주입 검증.
// buildStoreRunLayoutInput 은 adapter(buildRunLayoutInput) 에 settings 를 passthrough 하므로
// 결과 RunLayoutInput.settings 로 주입 결과를 직접 검증한다(라이브 store 불필요).
import { describe, expect, it } from 'vitest'
import { buildStoreRunLayoutInput, type StoreInputParams } from '../v3StoreInput'

const baseParams: StoreInputParams = {
  doctors: [{ id: '김원장', text: '김원장' }],
  appts: [],
  weekly: undefined,
  availableWidth: 1000,
  selectedDate: '2026-06-12',
  viewState: {
    dataType: 'APPOINTMENT',
    selectedDate: '2026-06-12',
    viewStep: 3,
    slotDivision: 3,
  },
}

describe('v3StoreInput buildStoreRunLayoutInput 예약장부 설정 주입', () => {
  it('store 설정값(timeUnit/totalColumns/displayInfo/rowHeightLevel)을 settings 로 주입한다', () => {
    const input = buildStoreRunLayoutInput({
      ...baseParams,
      totalColumns: 10,
      timeUnit: 20,
      displayInfo: ['NAME', 'AGE'],
      rowHeightLevel: 4,
    })
    expect(input.settings.slotUnitMinutes).toBe(20)
    expect(input.settings.totalColumnCount).toBe(10)
    expect(input.settings.displayInfo).toEqual(['NAME', 'AGE'])
    expect(input.settings.cardHeightLevel).toBe(4)
  })

  it('미전달 필드는 DEFAULT fallback (timeUnit30/totalColumns8/displayInfo[NAME]/rowHeightLevel3)', () => {
    const input = buildStoreRunLayoutInput(baseParams)
    expect(input.settings.slotUnitMinutes).toBe(30)
    expect(input.settings.totalColumnCount).toBe(8)
    expect(input.settings.displayInfo).toEqual(['NAME'])
    expect(input.settings.cardHeightLevel).toBe(3)
  })

  it('빈 displayInfo 는 DEFAULT([NAME]) 로 폴백한다', () => {
    const input = buildStoreRunLayoutInput({ ...baseParams, displayInfo: [] })
    expect(input.settings.displayInfo).toEqual(['NAME'])
  })

  it('일부 필드만 주입 시 나머지는 DEFAULT 유지(부분 주입 격리)', () => {
    const input = buildStoreRunLayoutInput({ ...baseParams, rowHeightLevel: 5 })
    expect(input.settings.cardHeightLevel).toBe(5)
    expect(input.settings.slotUnitMinutes).toBe(30)
    expect(input.settings.totalColumnCount).toBe(8)
    expect(input.settings.displayInfo).toEqual(['NAME'])
  })
})
