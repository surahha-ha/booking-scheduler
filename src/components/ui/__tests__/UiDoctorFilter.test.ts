/**
 * @vitest-environment happy-dom
 *
 * UiDoctorFilter — 의사 체크박스 필터 (예약장부 검색필터 / 운영일정 보기 공용).
 *
 * 선택 상태는 v-model 로 오간다. 이 컴포넌트는 어떤 스토어에도 묶여 있지 않다 —
 * 두 화면이 각자의 상태를 연결하고, 서로 연동되지 않아야 하기 때문이다.
 *
 * ★핵심 규약: **빈 배열 = 전체 선택** 이다(useCheckBoxSelection 의 isAllEmpty).
 *   "아무도 안 골랐다"가 아니라 "거르지 않는다"는 뜻이라, 전원을 고르면 다시 빈 배열이 된다.
 *
 * 현재 구현 기준(componentConstants): FIX_ALL=false — '전체'가 목록 맨 앞에 끼어 함께 페이징된다.
 * PAGE_SIZE_DOCTOR_FILTER=5.
 */

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import UiDoctorFilter from '@/components/ui/UiDoctorFilter.vue'

const DOCTORS = [
  { value: 'A의사', label: 'A의사' },
  { value: 'B의사', label: 'B의사' },
  { value: 'C의사', label: 'C의사' },
]

function mountFilter(props: Record<string, unknown> = {}) {
  return mount(UiDoctorFilter, {
    props: { buttonItems: DOCTORS, modelValue: [], ...props },
  })
}

/** 화면에 보이는 항목 라벨 (뱃지 텍스트 제외) */
function labels(wrapper: any) {
  return wrapper.findAll('.scheduleDoctorFilter__label').map((el: any) => el.text())
}

/** 라벨로 항목을 찾아 클릭 */
async function clickItem(wrapper: any, label: string) {
  const item = wrapper.findAll('.scheduleDoctorFilter__item')
    .find((el: any) => el.find('.scheduleDoctorFilter__label').text().startsWith(label))
  expect(item, `"${label}" 항목`).toBeTruthy()
  await item!.trigger('click')
}

/** 마지막으로 emit 된 update:modelValue 값 */
function lastEmitted(wrapper: any) {
  const events = wrapper.emitted('update:modelValue')
  expect(events, 'update:modelValue 가 emit 되지 않았다').toBeTruthy()
  return events![events!.length - 1][0]
}

/** 그 라벨의 체크박스가 켜져 있는가 */
function isChecked(wrapper: any, label: string) {
  const item = wrapper.findAll('.scheduleDoctorFilter__item')
    .find((el: any) => el.find('.scheduleDoctorFilter__label').text().startsWith(label))
  return item!.find('.scheduleDoctorFilter__check').classes('is-checked')
}

describe('UiDoctorFilter — 선택 규약 (빈 배열 = 전체)', () => {
  it('빈 배열이면 "전체"가 켜지고 개별 의사는 꺼진다', () => {
    const wrapper = mountFilter({ modelValue: [] })

    expect(isChecked(wrapper, '전체')).toBe(true)
    expect(isChecked(wrapper, 'A의사')).toBe(false)
    expect(isChecked(wrapper, 'B의사')).toBe(false)
  })

  it('전체 상태에서 한 명을 고르면 그 한 명만 나간다', async () => {
    const wrapper = mountFilter({ modelValue: [] })

    await clickItem(wrapper, 'B의사')
    expect(lastEmitted(wrapper)).toEqual(['B의사'])
  })

  it('선택 상태를 modelValue 로 받아 그대로 표시한다 (v-model 계약)', () => {
    const wrapper = mountFilter({ modelValue: ['B의사'] })

    expect(isChecked(wrapper, '전체')).toBe(false)
    expect(isChecked(wrapper, 'B의사')).toBe(true)
    expect(isChecked(wrapper, 'A의사')).toBe(false)
  })

  it('고른 사람을 다시 누르면 선택이 풀리고 전체(빈 배열)로 돌아간다', async () => {
    const wrapper = mountFilter({ modelValue: ['B의사'] })

    await clickItem(wrapper, 'B의사')
    expect(lastEmitted(wrapper)).toEqual([])
  })

  it('★전원을 고르면 빈 배열로 접힌다 — "전체"와 같은 뜻이기 때문', async () => {
    const wrapper = mountFilter({ modelValue: ['A의사', 'B의사'] })

    await clickItem(wrapper, 'C의사')
    expect(lastEmitted(wrapper)).toEqual([])
  })

  it('"전체"를 누르면 빈 배열이 나간다', async () => {
    const wrapper = mountFilter({ modelValue: ['B의사'] })

    await clickItem(wrapper, '전체')
    expect(lastEmitted(wrapper)).toEqual([])
  })

  it('이미 전체인 상태에서 "전체"를 눌러도 아무 일도 없다', async () => {
    const wrapper = mountFilter({ modelValue: [] })

    await clickItem(wrapper, '전체')
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })

  it('여러 명을 순서대로 고를 수 있다', async () => {
    const wrapper = mountFilter({ modelValue: ['A의사'] })

    await clickItem(wrapper, 'B의사')
    expect(lastEmitted(wrapper)).toEqual(['A의사', 'B의사'])
  })

  it('★의사가 한 명뿐이면 그를 눌러도 전체 그대로다 — 그 한 명이 곧 전원이라 바뀔 것이 없다', async () => {
    // 1인 병원. [값] 을 내보내면 화면은 계속 '전체'인데 조회 조건만 달라지고,
    // 다시 눌러도 같은 값이 재-emit 되어 되돌릴 수 없게 된다.
    const wrapper = mountFilter({ buttonItems: [DOCTORS[0]], modelValue: [] })

    await clickItem(wrapper, 'A의사')

    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
    expect(isChecked(wrapper, '전체')).toBe(true)
    expect(isChecked(wrapper, 'A의사')).toBe(false)
  })
})

describe('UiDoctorFilter — 표시할 의사가 없을 때', () => {
  // 팀 표시 필터(resolveVisibleDoctors) 결과가 비는 경우 — 선택한 팀에 멤버가 0명이거나,
  // 전원이 팀 소속이라 '미지정' 그룹이 빌 때. (담당자 원장 0명은 bookStore 게이트가
  //  사업장 설정로 내보내므로 이 화면에 도달하지 않는다.)
  // 규약상 빈 배열 = 전체이므로 '전체'는 켜진 채로 보여야 한다(꺼져 보이면 필터가 걸린 것처럼 읽힌다).
  it('표시할 의사가 없어도 "전체"가 나오고 켜져 있다', () => {
    const wrapper = mountFilter({ buttonItems: [], modelValue: [] })

    expect(labels(wrapper)).toEqual(['전체'])
    expect(isChecked(wrapper, '전체')).toBe(true)
  })

  it('표시할 의사가 없을 때 "전체"를 눌러도 아무 일도 없다 — 이미 전체라 재조회를 부르지 않는다', async () => {
    const wrapper = mountFilter({ buttonItems: [], modelValue: [] })

    await clickItem(wrapper, '전체')
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })

  it('의사가 있다가 사라지면 선택이 풀리고 "전체"가 켜진다', async () => {
    const wrapper = mountFilter({ modelValue: ['B의사'] })

    await wrapper.setProps({ buttonItems: [] })

    expect(lastEmitted(wrapper)).toEqual([])
    expect(isChecked(wrapper, '전체')).toBe(true)
  })
})

describe('UiDoctorFilter — 목록이 바뀔 때 (normalize)', () => {
  it('목록에서 사라진 의사는 선택에서 빠진다', async () => {
    const wrapper = mountFilter({ modelValue: ['A의사', 'C의사'] })

    // C의사가 없는 팀으로 교체 — 남은 선택만 유지되어야 한다
    await wrapper.setProps({ buttonItems: [DOCTORS[0], DOCTORS[1]] })
    expect(lastEmitted(wrapper)).toEqual(['A의사'])
  })

  it('선택이 전부 사라지면 전체(빈 배열)로 되돌아간다', async () => {
    const wrapper = mountFilter({ modelValue: ['C의사'] })

    await wrapper.setProps({ buttonItems: [DOCTORS[0]] })
    expect(lastEmitted(wrapper)).toEqual([])
  })

  it('전체(빈 배열)일 때는 목록이 바뀌어도 그대로 둔다', async () => {
    const wrapper = mountFilter({ modelValue: [] })

    await wrapper.setProps({ buttonItems: [DOCTORS[0]] })
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })
})

describe('UiDoctorFilter — 표시', () => {
  it('"전체"가 목록 맨 앞에 함께 나온다 (FIX_ALL=false)', () => {
    const wrapper = mountFilter()
    expect(labels(wrapper)).toEqual(['전체', 'A의사', 'B의사', 'C의사'])
  })

  it('비공개 담당자에는 뱃지가 붙는다', () => {
    const wrapper = mountFilter({
      buttonItems: [{ value: 'A의사', label: 'A의사', isPrivate: true }, DOCTORS[1]],
    })

    const badges = wrapper.findAll('.scheduleDoctorFilter__badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('비공개')
  })
})

describe('UiDoctorFilter — 페이지 이동 (한 쪽 5개)', () => {
  const MANY = Array.from({ length: 7 }, (_, i) => ({ value: `의사${i}`, label: `의사${i}` }))

  it('5개를 넘으면 나눠 보여준다 — "전체"도 한 자리를 차지한다', () => {
    const wrapper = mountFilter({ buttonItems: MANY })
    // [전체, 의사0..의사3] = 5개
    expect(labels(wrapper)).toEqual(['전체', '의사0', '의사1', '의사2', '의사3'])
  })

  it('다음을 누르면 나머지가 나온다', async () => {
    const wrapper = mountFilter({ buttonItems: MANY })

    await wrapper.findAll('.scheduleDoctorFilter__arrow')[1].trigger('click')
    expect(labels(wrapper)).toEqual(['의사4', '의사5', '의사6'])
  })

  it('첫 쪽에서는 이전이, 끝 쪽에서는 다음이 막힌다', async () => {
    const wrapper = mountFilter({ buttonItems: MANY })
    const [prev, next] = wrapper.findAll('.scheduleDoctorFilter__arrow')

    expect(prev.attributes('disabled')).toBeDefined()
    expect(next.attributes('disabled')).toBeUndefined()

    await next.trigger('click')
    expect(prev.attributes('disabled')).toBeUndefined()
    expect(next.attributes('disabled')).toBeDefined()
  })

  it('목록이 줄어 쪽수가 모자라면 보던 쪽을 되돌린다', async () => {
    const wrapper = mountFilter({ buttonItems: MANY })
    await wrapper.findAll('.scheduleDoctorFilter__arrow')[1].trigger('click')
    expect(labels(wrapper)).toEqual(['의사4', '의사5', '의사6'])

    // 한 쪽에 다 들어가는 크기로 줄이면 첫 쪽으로 돌아와야 한다(빈 화면 방지)
    await wrapper.setProps({ buttonItems: MANY.slice(0, 2) })
    expect(labels(wrapper)).toEqual(['전체', '의사0', '의사1'])
  })
})
