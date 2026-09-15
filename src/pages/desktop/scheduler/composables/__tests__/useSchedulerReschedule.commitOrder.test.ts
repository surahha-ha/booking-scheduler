/**
 * useSchedulerReschedule — 커밋이 중단되면 변경 모드가 살아남는다 (회귀 B-4)
 *
 * 예전에는 pickSlot 이 onCommit 을 부르기 *전에* cancel() 로 배너와 lock 을 걷었다.
 * 그래서 커밋 쪽에서 확인창 '아니오' 등으로 중단되면, 사용자 눈에는
 * "슬롯을 골랐고 확인창을 닫았는데 배너가 사라졌고 예약은 그대로"인 상태만 남았다.
 * 다시 하려면 ⋮ → 변경부터 밟아야 하는데 그 안내도 없었다.
 *
 * 규약: 모드를 끝내는 것은 pickSlot 이 아니라 커밋 쪽이다.
 * - 커밋이 중단(return)되면 → active 유지, lock 유지 → 다른 자리를 곧바로 다시 고를 수 있다
 * - 커밋이 저장까지 갔을 때만 cancel() → active/lock 해제
 */

import { describe, expect, it, vi } from 'vitest'
import { useSchedulerReschedule, type RescheduleResult } from '../useSchedulerReschedule'

const ORIGIN = { appointmentId: '77', fromColumnKey: '2026-06-12|김대표', startMinute: 600, endMinute: 630 }
const SLOT = {
  columnKey  : '2026-06-12|박대표',
  date       : '2026-06-12',
  resourceId : '박대표',
  startMinute: 780,
  endMinute  : 810,
}

/** onCommit 을 테스트가 직접 지정해 "중단" / "저장까지 진행" 을 갈라 쓴다. */
function setup(onCommit: (_r: RescheduleResult) => void | Promise<void>) {
  const unlock = vi.fn()
  const acquireLock = vi.fn(() => ({ unlock }))
  const reschedule = useSchedulerReschedule({
    acquireLock,
    getOrigin: () => ({ ...ORIGIN }),
    onCommit,
  })
  return { reschedule, unlock, acquireLock }
}

describe('useSchedulerReschedule — 커밋 중단 시 변경 모드 유지', () => {
  it('🔑 커밋이 아무것도 하지 않고 끝나면(확인창 아니오) 모드와 lock 이 유지된다', () => {
    const onCommit = vi.fn() // 확인창 '아니오' → cancel 없이 그냥 return 하는 커밋
    const { reschedule, unlock } = setup(onCommit)

    reschedule.begin('77')
    expect(reschedule.active.value).toBe(true)

    reschedule.pickSlot(SLOT)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(reschedule.active.value).toBe(true)      // 배너가 살아 있다
    expect(reschedule.targetId.value).toBe('77')
    expect(unlock).not.toHaveBeenCalled()           // lock 도 유지
  })

  it('🔑 모드가 유지되므로 다른 자리를 곧바로 다시 고를 수 있다', () => {
    const picked: RescheduleResult[] = []
    const onCommit = vi.fn((r: RescheduleResult) => { picked.push(r) })
    const { reschedule } = setup(onCommit)

    reschedule.begin('77')
    reschedule.pickSlot(SLOT)                                   // 첫 시도 — 중단됐다고 가정
    reschedule.pickSlot({ ...SLOT, startMinute: 900, endMinute: 930 }) // 다른 자리 재선택

    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(picked[1].newStartMinute).toBe(900)
    // 원 예약 길이(30분)는 재선택에서도 유지된다
    expect(picked[1].newEndMinute).toBe(930)
  })

  it('커밋이 저장까지 가면(cancel 호출) 모드와 lock 이 풀린다', () => {
    // 실제 페이지는 저장 직전에 reschedule.cancel() 을 부른다 — 그 지점을 흉내낸다.
    let ref: ReturnType<typeof useSchedulerReschedule>
    const onCommit = vi.fn(() => { ref.cancel() })
    const created = setup(onCommit)
    ref = created.reschedule

    created.reschedule.begin('77')
    created.reschedule.pickSlot(SLOT)

    expect(created.reschedule.active.value).toBe(false)
    expect(created.reschedule.targetId.value).toBe(null)
    expect(created.unlock).toHaveBeenCalledTimes(1)
  })

  it('pickSlot 은 원 예약 길이를 유지한 결과를 넘긴다', () => {
    const onCommit = vi.fn()
    const { reschedule } = setup(onCommit)

    reschedule.begin('77')
    reschedule.pickSlot(SLOT)

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId : '77',
      fromColumnKey : '2026-06-12|김대표',
      toColumnKey   : '2026-06-12|박대표',
      toResourceId  : '박대표',
      newStartMinute: 780,
      newEndMinute  : 810, // 슬롯 endMinute 가 아니라 원 duration(30분) 기준
    }))
  })
})
