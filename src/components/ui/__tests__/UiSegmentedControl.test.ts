/**
 * @vitest-environment happy-dom
 *
 * UiSegmentedControl — 한 줄짜리 배타 선택 버튼(주별/일별, 예약/진료 등 상단 전환 스위치).
 *
 * 스토어를 모르는 순수 표시 컴포넌트다. 선택 상태는 전적으로 부모가 쥐고 있고
 * 이 컴포넌트는 "눌렸다"만 알린다 — 즉 낙관적 자체 하이라이트가 없어서,
 * 부모가 modelValue 를 안 바꾸면 화면도 안 바뀐다(전환 실패 시 되돌림이 공짜).
 */

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import UiSegmentedControl from '@/components/ui/UiSegmentedControl.vue'

const ITEMS = [
  { value: 'WEEK', label: '주별' },
  { value: 'DAY', label: '일별' },
]

function mountControl(props: Record<string, unknown> = {}) {
  return mount(UiSegmentedControl, {
    props: { modelValue: 'WEEK', items: ITEMS, ...props },
  })
}

function buttons(wrapper: any) {
  return wrapper.findAll('.scheduleSegment__btn')
}

/** 각 버튼의 [라벨, 활성여부] */
function state(wrapper: any) {
  return buttons(wrapper).map((el: any) => [el.text(), el.classes('is-active')])
}

describe('UiSegmentedControl — 표시', () => {
  it('items 를 받은 순서 그대로 버튼으로 편다', () => {
    const wrapper = mountControl()

    expect(buttons(wrapper).map((el: any) => el.text())).toEqual(['주별', '일별'])
  })

  it('modelValue 와 값이 같은 버튼 하나만 활성이다', () => {
    const wrapper = mountControl({ modelValue: 'DAY' })

    expect(state(wrapper)).toEqual([['주별', false], ['일별', true]])
  })

  it('modelValue 가 목록에 없는 값이면 아무 버튼도 활성이 아니다', () => {
    const wrapper = mountControl({ modelValue: 'MONTH' })

    expect(buttons(wrapper).map((el: any) => el.classes('is-active'))).toEqual([false, false])
  })

  it('★값 비교는 타입까지 본다 — 숫자 1 과 문자열 "1" 은 다른 항목이다', () => {
    const wrapper = mountControl({
      modelValue: 1,
      items: [{ value: 1, label: '숫자' }, { value: '1', label: '문자' }],
    })

    expect(state(wrapper)).toEqual([['숫자', true], ['문자', false]])
  })

  it('items 가 비면 버튼 없이 껍데기만 남는다', () => {
    const wrapper = mountControl({ items: [] })

    expect(buttons(wrapper)).toHaveLength(0)
    expect(wrapper.find('.scheduleSegment').exists()).toBe(true)
  })

  it('항목이 하나뿐이어도 그 하나가 정상적으로 활성이 된다', () => {
    const wrapper = mountControl({ modelValue: 'WEEK', items: [ITEMS[0]] })

    expect(state(wrapper)).toEqual([['주별', true]])
  })

  it('폼 안에 놓여도 submit 되지 않도록 type=button 이다', () => {
    const wrapper = mountControl()

    expect(buttons(wrapper).map((el: any) => el.attributes('type'))).toEqual(['button', 'button'])
  })
})

describe('UiSegmentedControl — 선택 (v-model 계약)', () => {
  it('버튼을 누르면 그 항목의 value 를 내보낸다', async () => {
    const wrapper = mountControl({ modelValue: 'WEEK' })

    await buttons(wrapper)[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['DAY']])
  })

  it('★부모가 modelValue 를 안 바꾸면 화면도 그대로다 — 자체 상태를 갖지 않는다', async () => {
    const wrapper = mountControl({ modelValue: 'WEEK' })

    await buttons(wrapper)[1].trigger('click')

    expect(state(wrapper)).toEqual([['주별', true], ['일별', false]])
  })

  it('부모가 되돌려준 modelValue 로만 활성 표시가 옮겨간다', async () => {
    const wrapper = mountControl({ modelValue: 'WEEK' })

    await wrapper.setProps({ modelValue: 'DAY' })

    expect(state(wrapper)).toEqual([['주별', false], ['일별', true]])
  })

  it('이미 활성인 버튼을 눌러도 같은 값을 다시 내보낸다 (중복 클릭을 막지 않음)', async () => {
    const wrapper = mountControl({ modelValue: 'WEEK' })

    await buttons(wrapper)[0].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['WEEK']])
  })

  it('연속으로 누르면 누른 순서대로 쌓인다', async () => {
    const wrapper = mountControl({ modelValue: 'WEEK' })

    await buttons(wrapper)[1].trigger('click')
    await buttons(wrapper)[0].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['DAY'], ['WEEK']])
  })
})
