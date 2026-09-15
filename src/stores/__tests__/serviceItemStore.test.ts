import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// serviceItemApi 는 모듈 로드 시 useApi()를 호출하므로 통째로 모킹해 부작용 차단.
vi.mock('@/api/serviceItemApi', () => ({
  getGroups: vi.fn(),
  addGroup: vi.fn(),
  addItem: vi.fn(),
  modifyGroup: vi.fn(),
  modifyItem: vi.fn(),
  removeGroup: vi.fn(),
  removeItem: vi.fn(),
}))

import { getGroups } from '@/api/serviceItemApi'
import { useServiceItemStore } from '../serviceItemStore'

const mockGetGroups = getGroups as unknown as ReturnType<typeof vi.fn>

const GROUPS = [
  { serviceGroupId: 1, serviceGroupName: '상담', items: [{ serviceItemId: 11, serviceGroupId: 1, serviceItemName: '초회 상담', useYn: 'Y' }] },
  { serviceGroupId: 2, serviceGroupName: '점검', items: [] },
]

/** 응답 시점을 테스트가 쥐는 지연 응답 */
function deferredResponse() {
  let resolve!: (v: unknown) => void
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve: () => resolve({ data: { payload: GROUPS } }) }
}

describe('serviceItemStore.load — 동시 호출', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetGroups.mockReset()
  })

  it('조회가 진행 중일 때 들어온 load(true) 는 그 조회가 끝날 때까지 기다린다 (빈 그룹으로 돌아오지 않는다)', async () => {
    // 예약 팝업이 load() 를 부른 직후 설정 팝업이 load(true) 를 부르는 상황.
    const d = deferredResponse()
    mockGetGroups.mockReturnValueOnce(d.promise)
    const store = useServiceItemStore()

    const first = store.load()
    const second = store.load(true)

    let secondSettled = false
    second.then(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled, '진행 중 조회를 기다리지 않고 즉시 돌아왔다').toBe(false)

    d.resolve()
    await second
    expect(store.userGroups.map((g) => g.serviceGroupName)).toEqual(['상담', '점검'])
    await first
    // 같은 조회를 함께 기다렸으므로 서버 호출은 한 번뿐이다
    expect(mockGetGroups).toHaveBeenCalledTimes(1)
  })

  it('이미 적재된 뒤 load() 는 재조회하지 않고, load(true) 는 다시 조회한다', async () => {
    mockGetGroups.mockResolvedValue({ data: { payload: GROUPS } })
    const store = useServiceItemStore()

    await store.load()
    await store.load()
    expect(mockGetGroups).toHaveBeenCalledTimes(1)

    await store.load(true)
    expect(mockGetGroups).toHaveBeenCalledTimes(2)
  })

  it('조회가 실패해도 다음 load 가 다시 시도할 수 있다 (진행 중 표식이 남지 않는다)', async () => {
    mockGetGroups.mockRejectedValueOnce(new Error('503'))
    const store = useServiceItemStore()

    await expect(store.load()).rejects.toThrow('503')
    expect(store.loading).toBe(false)

    mockGetGroups.mockResolvedValueOnce({ data: { payload: GROUPS } })
    await store.load()
    expect(store.userGroups).toHaveLength(2)
  })
})
