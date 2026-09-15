/**
 * @vitest-environment happy-dom
 */
// 방문내용 선택기 — 그룹/항목 선택, memo 독립성, 빈 그룹 처리, 항목 페이징.
//
// 이 화면의 사고는 전부 "보이는 것과 저장되는 것이 다르다"에서 났다.
// 그래서 emit 계약(무엇이 form 으로 나가나)과 표시 상태(무엇이 눌리나·보이나)를 함께 고정한다.
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  load: vi.fn().mockResolvedValue(undefined),
}))

const GROUP_WITH_ITEMS = 1
const GROUP_EMPTY = 2
const GROUP_MANY = 3
const ITEM_FIRST = 11
const ITEM_SECOND = 12

function seedGroups() {
  return [
    {
      serviceGroupId: GROUP_WITH_ITEMS,
      serviceGroupName: '점검',
      items: [
        {serviceItemId: ITEM_FIRST, serviceItemName: '정밀상담'},
        {serviceItemId: ITEM_SECOND, serviceItemName: '장치조정'},
      ],
    },
    {serviceGroupId: GROUP_EMPTY, serviceGroupName: '빈그룹', items: []},
    {
      serviceGroupId: GROUP_MANY,
      serviceGroupName: '관리',
      // 페이지당 8개 — 9개면 페이저가 뜬다
      items: Array.from({length: 9}, (_, i) => ({serviceItemId: 30 + i, serviceItemName: `항목${i}`})),
    },
  ]
}

vi.mock('@/stores/serviceItemStore', async () => {
  const {ref} = await import('vue')
  const groups = ref<any[]>([])
  return {
    useServiceItemStore: () => ({groups, userGroups: groups, load: mocks.load}),
    __groups: groups,
  }
})
vi.mock('notivue', () => ({push: {error: vi.fn()}}))

import TreatmentContentSelector from '@/components/popup/TreatmentContentSelector.vue'

async function storeGroups() {
  const mod = await import('@/stores/serviceItemStore') as unknown as { __groups: { value: any[] } }
  return mod.__groups
}

async function mountSelector(props: Record<string, unknown> = {}) {
  const wrapper = mount(TreatmentContentSelector, {props: {active: true, ...props}})
  await mocks.load()
  await wrapper.vm.$nextTick()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountSelector>>

const chips = (w: Wrapper) => w.findAll('.tcs-groupChip')
const items = (w: Wrapper) => w.findAll('.tcs-itemChip')
const lastEmit = (w: Wrapper, event: string) => {
  const list = w.emitted(event)
  return list?.[list.length - 1]?.[0]
}

beforeEach(async () => {
  const groups = await storeGroups()
  groups.value = seedGroups()
})

describe('초기 선택', () => {
  it('그룹은 있고 항목이 비어 있으면 그 그룹의 첫 항목을 채운다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: null})
    expect(wrapper.emitted('update:itemId')?.[0]).toEqual([ITEM_FIRST])
  })

  it('항목이 이미 선택돼 있으면 건드리지 않는다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_SECOND})
    expect(wrapper.emitted('update:itemId')).toBeUndefined()
  })

  it('항목이 0개인 그룹이 지정돼 있으면 그룹까지 해제한다 — 고를 항목이 없다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_EMPTY, itemId: null})
    expect(wrapper.emitted('update:groupId')?.[0]).toEqual([null])
    expect(wrapper.emitted('update:itemId')?.[0]).toEqual([null])
  })

  it('등록 진입(defaultFirstGroup)은 항목이 있는 첫 그룹과 그 첫 항목을 고른다', async () => {
    const wrapper = await mountSelector({defaultFirstGroup: true})
    expect(wrapper.emitted('update:groupId')?.[0]).toEqual([GROUP_WITH_ITEMS])
    expect(wrapper.emitted('update:itemId')?.[0]).toEqual([ITEM_FIRST])
  })

  it('첫 그룹이 빈 그룹이면 건너뛰고 다음 선택 가능한 그룹을 고른다', async () => {
    const groups = await storeGroups()
    groups.value = [{serviceGroupId: 9, serviceGroupName: '빈그룹', items: []}, ...seedGroups()]

    const wrapper = await mountSelector({defaultFirstGroup: true})
    expect(wrapper.emitted('update:groupId')?.[0]).toEqual([GROUP_WITH_ITEMS])
  })

  it('선택 가능한 그룹이 하나도 없으면 아무것도 고르지 않는다', async () => {
    const groups = await storeGroups()
    groups.value = [{serviceGroupId: GROUP_EMPTY, serviceGroupName: '빈그룹', items: []}]

    const wrapper = await mountSelector({defaultFirstGroup: true})
    expect(wrapper.emitted('update:groupId')).toBeUndefined()
  })

  it('등록 진입이 아니면(EDIT) 지정된 그룹이 없을 때 아무것도 고르지 않는다', async () => {
    const wrapper = await mountSelector({defaultFirstGroup: false})
    expect(wrapper.emitted('update:groupId')).toBeUndefined()
    expect(wrapper.emitted('update:itemId')).toBeUndefined()
  })
})

describe('그룹·항목 선택', () => {
  it('그룹을 고르면 그 그룹의 첫 항목이 함께 선택된다 — 짝이 깨진 채 남지 않는다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})

    await chips(wrapper)[2].trigger('click') // 관리
    expect(lastEmit(wrapper, 'update:groupId')).toBe(GROUP_MANY)
    expect(lastEmit(wrapper, 'update:itemId')).toBe(30)
  })

  it('선택된 그룹을 다시 누르면 그룹·항목이 함께 해제된다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})

    await chips(wrapper)[0].trigger('click')
    expect(lastEmit(wrapper, 'update:groupId')).toBeNull()
    expect(lastEmit(wrapper, 'update:itemId')).toBeNull()
  })

  it('항목을 바꿔도 그룹과 memo 는 그대로다 — 서비스 항목과 직접입력은 독립이다', async () => {
    const wrapper = await mountSelector({
      groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST, modelValue: '기본진단',
    })

    await items(wrapper)[1].trigger('click')
    expect(lastEmit(wrapper, 'update:itemId')).toBe(ITEM_SECOND)
    expect(lastEmit(wrapper, 'update:groupId')).toBe(GROUP_WITH_ITEMS)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('같은 항목을 다시 눌러도 해제되지 않는다 — 그룹만 남는 반쪽 상태를 만들지 않는다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    const before = wrapper.emitted('update:itemId')?.length ?? 0

    await items(wrapper)[0].trigger('click')
    expect(wrapper.emitted('update:itemId')?.length ?? 0).toBe(before)
  })

  it('memo 입력은 서비스 항목 선택을 건드리지 않는다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    const groupEmits = wrapper.emitted('update:groupId')?.length ?? 0

    const memo = wrapper.find('.tcs-memo')
    ;(memo.element as HTMLTextAreaElement).value = '설치 상담'
    await memo.trigger('input')

    expect(lastEmit(wrapper, 'update:modelValue')).toBe('설치 상담')
    expect(wrapper.emitted('update:groupId')?.length ?? 0).toBe(groupEmits)
  })
})

describe('빈 그룹은 고를 수 없다', () => {
  it('항목이 0개인 그룹 칩은 disabled 다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    expect(chips(wrapper)[0].attributes('disabled')).toBeUndefined()
    expect(chips(wrapper)[1].attributes('disabled')).toBeDefined()
  })

  it('선택 중인 그룹이라도 항목이 모두 지워지면 곧바로 disabled 가 된다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    expect(chips(wrapper)[0].attributes('disabled')).toBeUndefined()

    const groups = await storeGroups()
    groups.value = groups.value.map((g) => (g.serviceGroupId === GROUP_WITH_ITEMS ? {...g, items: []} : g))
    await wrapper.vm.$nextTick()

    expect(chips(wrapper)[0].attributes('disabled')).toBeDefined()
  })

  it('선택 중이던 그룹의 항목이 모두 지워지면 안내 문구가 보인다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    expect(wrapper.find('.tcs-empty').exists()).toBe(false)

    const groups = await storeGroups()
    groups.value = groups.value.map((g) => (g.serviceGroupId === GROUP_WITH_ITEMS ? {...g, items: []} : g))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.tcs-empty').text()).toContain('등록된 서비스 항목이 없습니다')
  })
})

describe('항목 페이징', () => {
  it('한 페이지(8개) 이하면 페이저를 숨긴다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    expect(wrapper.findAll('.tcs-itemPager')).toHaveLength(0)
  })

  it('9개부터 페이저가 뜨고 첫 페이지에는 8개만 보인다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_MANY, itemId: 30})
    expect(wrapper.findAll('.tcs-itemPager')).toHaveLength(2)
    expect(items(wrapper)).toHaveLength(8)
  })

  it('다음 페이지로 넘기면 나머지가 보이고, 첫 페이지에서는 이전이 잠긴다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_MANY, itemId: 30})
    const [prev, next] = wrapper.findAll('.tcs-itemPager')
    expect(prev.attributes('disabled')).toBeDefined()

    await next.trigger('click')
    expect(items(wrapper)).toHaveLength(1)
    expect(wrapper.findAll('.tcs-itemPager')[1].attributes('disabled')).toBeDefined()
  })

  it('그룹을 바꾸면 페이지가 첫 장으로 돌아간다', async () => {
    const wrapper = await mountSelector({groupId: GROUP_MANY, itemId: 30})
    await wrapper.findAll('.tcs-itemPager')[1].trigger('click')
    expect(items(wrapper)).toHaveLength(1)

    await wrapper.setProps({groupId: GROUP_WITH_ITEMS, itemId: ITEM_FIRST})
    await wrapper.vm.$nextTick()
    expect(items(wrapper)).toHaveLength(2)
  })
})

// 그룹명은 최대 50자까지 저장되는데 칩 폭에는 상한이 있다. 화면에서 잘리는 것 자체는
// 레이아웃이라 여기서 잴 수 없지만, "잘린 뒤 전체 이름을 어디서도 얻을 수 없게 되는 것"은
// 잡을 수 있다 — 실제 결함이 그것이었다(긴 그룹명 칩이 잘린 채 구분이 불가능해짐).
describe('긴 이름도 전체를 잃지 않는다', () => {
  const LONG = '12345678901234567890123456789012345678901234567890'

  it('그룹 칩은 잘려도 전체 이름을 tooltip 으로 남긴다', async () => {
    const groups = await storeGroups()
    groups.value = [{serviceGroupId: 99, serviceGroupName: LONG, items: [{serviceItemId: 1, serviceItemName: '상담'}]}]
    const wrapper = await mountSelector()

    expect(chips(wrapper)[0].attributes('data-tooltip')).toBe(LONG)
  })

  it('항목 칩도 같은 규칙을 지킨다 — 칩 종류마다 규칙이 갈리지 않는다', async () => {
    const groups = await storeGroups()
    groups.value = [{serviceGroupId: 99, serviceGroupName: '그룹', items: [{serviceItemId: 1, serviceItemName: LONG}]}]
    const wrapper = await mountSelector({groupId: 99, itemId: 1})

    expect(items(wrapper)[0].attributes('data-tooltip')).toBe(LONG)
  })

  it('칩에 보이는 글자와 tooltip 의 원본이 같은 값에서 나온다', async () => {
    const groups = await storeGroups()
    groups.value = [{serviceGroupId: 99, serviceGroupName: LONG, items: [{serviceItemId: 1, serviceItemName: '상담'}]}]
    const wrapper = await mountSelector()

    // 잘림은 CSS 가 하므로 DOM 텍스트는 원본 그대로여야 한다.
    // 여기서 잘라 넣으면 tooltip 과 어긋나고 검색·비교가 깨진다.
    expect(chips(wrapper)[0].text()).toBe(LONG)
  })
})
