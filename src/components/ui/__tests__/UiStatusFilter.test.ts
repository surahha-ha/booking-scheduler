/**
 * @vitest-environment happy-dom
 *
 * UiStatusFilter — 예약/진료 상태 체크 필터 (전체 + 상태별 버튼, 각 버튼에 건수 뱃지).
 *
 * UiDoctorFilter 와 달리 **v-model 이 없다**. 선택 상태를 직접 useSchedulerFilterStore.status 에
 * 읽고 쓴다 — 즉 이 컴포넌트를 두 군데에 놓으면 두 곳이 같은 상태를 공유한다.
 * 그래서 테스트도 emit 이 아니라 스토어 상태로 검증한다.
 *
 * ★핵심 규약(useCheckBoxSelection, isAllEmpty=true): **빈 배열 = 전체** — 전부 고르면 다시 빈 배열.
 * ★normalizeOnItemsChange=false: 상태 목록은 고정 코드값이라, 목록이 바뀌어도 선택을 정리하지 않는다.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UiStatusFilter from '@/components/ui/UiStatusFilter.vue'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'

const STATUS_ITEMS = [
  { value: 'REQUEST', label: '예약대기' },
  { value: 'CONFIRM', label: '예약확정' },
  { value: 'CANCEL', label: '예약취소' },
]

function mountFilter(props: Record<string, unknown> = {}) {
  return mount(UiStatusFilter, {
    props: { buttonItems: STATUS_ITEMS, ...props },
  })
}

function checks(wrapper: any) {
  return wrapper.findAll('.scheduleStatusChecks__check')
}

/** 라벨(건수 제외)로 버튼 찾기 — 첫 버튼은 항상 '전체' */
function findCheck(wrapper: any, label: string) {
  const found = checks(wrapper).find((el: any) => el.text().startsWith(label))
  expect(found, `"${label}" 버튼`).toBeTruthy()
  return found!
}

function isOn(wrapper: any, label: string) {
  return findCheck(wrapper, label).classes('is-on')
}

async function click(wrapper: any, label: string) {
  await findCheck(wrapper, label).trigger('click')
}

let store: ReturnType<typeof useSchedulerFilterStore>

beforeEach(() => {
  setActivePinia(createPinia())
  store = useSchedulerFilterStore()
})

describe('UiStatusFilter — 선택 규약 (빈 배열 = 전체)', () => {
  it('스토어 status 가 비어 있으면 "전체"만 켜진다', () => {
    const wrapper = mountFilter()

    expect(isOn(wrapper, '전체')).toBe(true)
    expect(isOn(wrapper, '예약대기')).toBe(false)
    expect(isOn(wrapper, '예약확정')).toBe(false)
  })

  it('전체 상태에서 하나를 고르면 스토어에 그 하나만 남는다', async () => {
    const wrapper = mountFilter()

    await click(wrapper, '예약확정')

    expect(store.status).toEqual(['CONFIRM'])
  })

  it('스토어에 담긴 상태가 그대로 화면에 켜진다 (스토어 → 화면 단방향)', async () => {
    const wrapper = mountFilter()

    store.status = ['CONFIRM']
    await wrapper.vm.$nextTick()

    expect(isOn(wrapper, '전체')).toBe(false)
    expect(isOn(wrapper, '예약확정')).toBe(true)
    expect(isOn(wrapper, '예약대기')).toBe(false)
  })

  it('켜진 것을 다시 누르면 꺼지고, 하나도 안 남으면 전체(빈 배열)로 돌아간다', async () => {
    store.status = ['CONFIRM']
    const wrapper = mountFilter()

    await click(wrapper, '예약확정')

    expect(store.status).toEqual([])
    expect(isOn(wrapper, '전체')).toBe(true)
  })

  it('★전부 고르면 빈 배열로 접힌다 — "전체"와 같은 뜻이기 때문', async () => {
    store.status = ['REQUEST', 'CONFIRM']
    const wrapper = mountFilter()

    await click(wrapper, '예약취소')

    expect(store.status).toEqual([])
  })

  it('여러 개를 겹쳐 고를 수 있다', async () => {
    store.status = ['REQUEST']
    const wrapper = mountFilter()

    await click(wrapper, '예약확정')

    expect(store.status).toEqual(['REQUEST', 'CONFIRM'])
  })

  it('"전체"를 누르면 개별 선택이 모두 풀린다', async () => {
    store.status = ['CONFIRM']
    const wrapper = mountFilter()

    await click(wrapper, '전체')

    expect(store.status).toEqual([])
  })

  it('이미 전체인데 "전체"를 눌러도 재조회를 일으키지 않는다', async () => {
    const wrapper = mountFilter()
    const before = store.searchVersion

    await click(wrapper, '전체')

    expect(store.searchVersion).toBe(before)
  })

  it('선택이 바뀌면 재조회 신호(searchVersion)가 올라간다', async () => {
    const wrapper = mountFilter()
    const before = store.searchVersion

    await click(wrapper, '예약대기')

    expect(store.searchVersion).toBe(before + 1)
  })
})

describe('UiStatusFilter — 건수 표시', () => {
  it('★전체는 "전체" 키로, 개별 버튼은 value 가 아니라 label 키로 건수를 찾는다', () => {
    const wrapper = mountFilter({
      statistics: { '전체': 12, '예약대기': 5, '예약확정': 7, 'CONFIRM': 999 },
    })

    expect(findCheck(wrapper, '전체').text()).toBe('전체 12')
    expect(findCheck(wrapper, '예약대기').text()).toBe('예약대기 5')
    // value(CONFIRM) 로 넣은 999 는 무시되고 label 로 찾은 7 이 뜬다
    expect(findCheck(wrapper, '예약확정').text()).toBe('예약확정 7')
  })

  it('통계에 없는 항목은 0 으로 채운다 (빈칸 방지)', () => {
    const wrapper = mountFilter({ statistics: { '예약대기': 5 } })

    expect(findCheck(wrapper, '전체').text()).toBe('전체 0')
    expect(findCheck(wrapper, '예약취소').text()).toBe('예약취소 0')
  })

  it('통계를 아예 안 넘기면 전부 0 이다', () => {
    const wrapper = mountFilter()

    expect(checks(wrapper).map((el: any) => el.find('.scheduleStatusChecks__count').text()))
      .toEqual(['0', '0', '0', '0'])
  })
})

describe('UiStatusFilter — 경계', () => {
  it('상태 목록이 비면 "전체" 버튼만 남고, 고를 것이 없으니 켜지지도 않는다', () => {
    const wrapper = mountFilter({ buttonItems: [] })

    expect(checks(wrapper)).toHaveLength(1)
    expect(isOn(wrapper, '전체')).toBe(false)
  })

  it('★항목이 하나뿐이면 그것을 눌러도 전체 그대로다 — 그 하나가 곧 전 항목이라 바뀔 것이 없다', async () => {
    const wrapper = mountFilter({ buttonItems: [STATUS_ITEMS[0]] })
    const before = store.searchVersion

    await click(wrapper, '예약대기')

    // 화면에 보이는 것('전체')과 나가는 조회 조건이 어긋나지 않는다. 재조회도 돌지 않는다.
    expect(store.status).toEqual([])
    expect(store.searchVersion).toBe(before)
    expect(isOn(wrapper, '전체')).toBe(true)
    expect(isOn(wrapper, '예약대기')).toBe(false)
  })

  it('★선택이 모든 항목을 덮으면 화면은 "전체"와 똑같아진다 (빈 배열이 아니어도)', async () => {
    store.status = ['REQUEST']
    const wrapper = mountFilter({ buttonItems: [STATUS_ITEMS[0]] })
    const before = store.searchVersion

    expect(isOn(wrapper, '전체')).toBe(true)
    expect(isOn(wrapper, '예약대기')).toBe(false)

    // 이미 전체로 간주되는 상태라 개별 클릭은 아무것도 바꾸지 않는다(재조회도 없다)
    await click(wrapper, '예약대기')
    expect(store.status).toEqual(['REQUEST'])
    expect(store.searchVersion).toBe(before)
  })

  it('★목록이 바뀌어도 선택을 정리하지 않는다 (normalizeOnItemsChange=false)', async () => {
    store.status = ['CANCEL']
    const wrapper = mountFilter()
    const before = store.searchVersion

    // 방문 장부용 상태 목록으로 갈아끼워도 사라진 CANCEL 이 그대로 남는다
    await wrapper.setProps({ buttonItems: [STATUS_ITEMS[0], STATUS_ITEMS[1]] })

    expect(store.status).toEqual(['CANCEL'])
    expect(store.searchVersion).toBe(before)
  })

  it('폼 안에 놓여도 submit 되지 않도록 모든 버튼이 type=button 이다', () => {
    const wrapper = mountFilter()

    expect(checks(wrapper).every((el: any) => el.attributes('type') === 'button')).toBe(true)
  })
})
