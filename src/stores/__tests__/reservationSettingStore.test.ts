import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// reservationSettingsApi 는 모듈 로드 시 useApi()를 호출하므로 통째로 모킹해 부작용 차단.
vi.mock('@/api/reservationSettingsApi', () => ({
  getReservationSettings: vi.fn(),
}))

import { getReservationSettings } from '@/api/reservationSettingsApi'
import { useReservationSettingStore } from '../reservationSettingStore'

const mockGet = getReservationSettings as unknown as ReturnType<typeof vi.fn>

function resp(payload: Record<string, unknown>) {
  return { data: { payload } }
}

describe('reservationSettingStore — rowHeightLevel (BE 영속 + 방어 가드)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
  })

  it('기본값 = 3 (서버 기본값과 일치)', () => {
    const s = useReservationSettingStore()
    expect(s.rowHeightLevel).toBe(3)
  })

  it('setLocalRowHeightLevel: 1~5 clamp + 불량값 → 기본값(3)', () => {
    const s = useReservationSettingStore()
    s.setLocalRowHeightLevel(4)
    expect(s.rowHeightLevel).toBe(4)
    s.setLocalRowHeightLevel(9) // 상한
    expect(s.rowHeightLevel).toBe(5)
    s.setLocalRowHeightLevel(0) // 하한
    expect(s.rowHeightLevel).toBe(1)
    s.setLocalRowHeightLevel('x') // 비숫자 → 방어적으로 기본값
    expect(s.rowHeightLevel).toBe(3)
  })

  // 방어 가드: 응답에 rowHeightLevel 이 누락된 경우(예외적) optimistic 값을 덮어쓰지 않는다.
  it('load: 응답에 rowHeightLevel 없으면 optimistic 값 보존', async () => {
    const s = useReservationSettingStore()
    s.setLocalRowHeightLevel(5)
    mockGet.mockResolvedValue(resp({ slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] }))
    await s.load(true)
    expect(s.rowHeightLevel).toBe(5) // 보존
    expect(s.timeUnit).toBe(30) // 다른 필드는 정상 반영
  })

  it('load: 응답에 cardHeightLevel 있으면 반영(BE 영속) + 1~5 clamp', async () => {
    const s = useReservationSettingStore()
    mockGet.mockResolvedValue(resp({ slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'], cardHeightLevel: 4 }))
    await s.load(true)
    expect(s.rowHeightLevel).toBe(4)
  })
})
