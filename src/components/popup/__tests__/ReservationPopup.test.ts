/**
 * @vitest-environment happy-dom
 *
 * 예약 팝업 — 저장 직전 운영시간 재확인(confirmBlockedIfChanged)의 계약을 고정한다.
 *
 * 이 팝업은 hide-on-outside-click 이라, 확인 대화상자의 버튼 클릭이 "바깥 클릭"으로 잡혀
 * @hiding → handleClose → resetFormState 가 도는 사고가 있었다. 그러면 [확인]을 눌러도
 * form 이 비워진 뒤 payload 가 만들어져 "처리실패 되었습니다"로 끝났다.
 * 방어가 두 겹이라 두 겹을 각각 고정한다.
 *
 * 지키는 것:
 *  ① 확인을 받는 동안에는 바깥 클릭 닫힘을 끈다(hide-on-outside-click = false).
 *  ② 그래도 닫힘이 돌아버린 경우, 나가는 payload 는 온전하다
 *     — payload 는 await 앞에서 확정하므로 form 초기화의 영향을 받지 않는다.
 *  ③ 연 시점의 (일자·시작시각·담당자)와 같으면 묻지 않는다(진입 확인과 두 번 겹치지 않게).
 *  ④ 운영시간 안(reason 없음)이면 묻지 않는다.
 *  ⑤ 확인에서 [취소] 하면 저장하지 않는다.
 *  ⑥ 필수값이 비면 확인을 묻기 전에 멈춘다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

const mocks = vi.hoisted(() => ({
  confirm : vi.fn(),
  alert   : vi.fn(),
  /** schedulerFilterStore 의 dataType ref — mock 팩토리가 채운다(화면 전환 테스트용). */
  dataType: null as { value: string } | null,
  /** 서비스 항목 마스터 — 테스트마다 갈아끼운다(빈 그룹 저장 차단 검증용). */
  atclGroups: [] as { serviceGroupId: number; items: { serviceItemId: number }[] }[],
  /** 마스터 재조회 — 설정 팝업이 닫힐 때 팝업이 부른다. 테스트가 이 안에서 마스터를 바꿔 "지워진 뒤"를 만든다. */
  atclLoad: vi.fn(),
}))

// --- 외부 UI 의존 (모달 / datepicker / 공용 위젯) -----------------------
vi.mock('@/components/ui/UiModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name : 'UiModalStub',
      props: ['visible', 'hideOnOutsideClick'],
      emits: ['hiding', 'shown', 'update:visible'],
      setup(props, { slots }) {
        // 상태 뱃지는 title 영역의 named slot 에 실리므로 default 만 렌더하면 DOM 에 나타나지 않는다.
        return () => (props.visible
          ? h('div', { class: 'ui-modal-stub' }, [slots.title?.(), slots.titleExtra?.(), slots.titleBadge?.(), slots.content?.(), slots.default?.()])
          : null)
      },
    }),
  }
})

vi.mock('@vuepic/vue-datepicker', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    VueDatePicker: defineComponent({
      name : 'VueDatePickerStub',
      props: ['modelValue'],
      emits: ['update:modelValue'],
      setup: (props) => () => h('div', { class: 'date-picker-stub' }, props.modelValue),
    }),
  }
})

vi.mock('@/components/ui/UiTimeSelect.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name : 'UiTimeSelectStub',
      props: ['modelValue', 'options', 'readonly', 'invalid', 'maxHeight'],
      emits: ['update:modelValue'],
      setup: (props) => () => h('div', { class: 'time-select-stub' }, props.modelValue),
    }),
  }
})

vi.mock('@/components/popup/PatientAutocomplete.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name : 'PatientAutocompleteStub',
      props: ['modelValue', 'open', 'items', 'invalid', 'readonly', 'isPicking', 'placeholder'],
      emits: ['update:modelValue', 'update:open', 'blur', 'pick', 'search'],
      setup: (props) => () => h('div', { class: 'patient-ac-stub' }, props.modelValue),
    }),
  }
})

vi.mock('@/components/popup/TreatmentContentSelector.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name : 'TreatmentContentSelectorStub',
      props: ['groupId', 'itemId', 'active', 'maxLength', 'defaultFirstGroup'],
      emits: ['update:groupId', 'update:itemId', 'open-setting'],
      setup: () => () => h('div', { class: 'treatment-selector-stub' }),
    }),
  }
})

vi.mock('@/components/popup/TreatmentItemSettingPopup.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name : 'TreatmentItemSettingPopupStub',
      props: ['visible', 'anchorSelector'],
      emits: ['close'],
      setup: () => () => h('div', { class: 'treatment-setting-stub' }),
    }),
  }
})

vi.mock('@/lib/useDialog', () => ({
  useDialog: () => ({ confirm: mocks.confirm, alert: mocks.alert }),
}))

// --- 스토어 ------------------------------------------------------------------
// storeToRefs 로 꺼내는 것만 ref, 직접 접근하는 것은 평문 — 실제 store 의 unwrap 과 같은 모양.
// ★null 값을 넣지 말 것: pinia storeToRefs 가 모든 키에 value.effect 를 읽어 TypeError 로 죽는다.
vi.mock('@/stores/staffStore', async () => {
  const { ref: r } = await import('vue')
  const doctors = r<unknown[]>([])
  const teams = r<unknown[]>([])
  return {
    useStaffStore: () => ({ doctors, teams }),
  }
})

vi.mock('@/stores/customerStore', async () => {
  const { ref: r } = await import('vue')
  const patients = r<unknown[]>([])
  return { useCustomerStore: () => ({ patients, loadCustomer: vi.fn() }) }
})

vi.mock('@/stores/useSchedulerFilterStore', async () => {
  const { ref: r } = await import('vue')
  const dataType = r('APPOINTMENT')
  const viewMode = r('DAY')
  mocks.dataType = dataType
  return {
    useSchedulerFilterStore: () => ({ dataType, viewMode, selectedTeamName: '' }),
  }
})

vi.mock('@/stores/serviceItemStore', () => ({
  useServiceItemStore: () => ({ groups: mocks.atclGroups, load: mocks.atclLoad }),
}))

import UiModal from '@/components/ui/UiModal.vue'
import ReservationPopup from '@/components/popup/ReservationPopup.vue'

const DOCTOR = '가온비'
/** 과거·미래 판정(readOnlyMode·minSelectableDate)에 흔들리지 않도록 충분히 뒤 날짜. */
const DATE = '2030-03-04'

function editPayload() {
  return {
    mode         : 'EDIT',
    id           : 8659,
    status       : '00', // 예약모드 EDIT 은 상태 00 이 아니면 readOnly
    doctorName   : DOCTOR,
    patientName  : '테스트고객',
    patientPhone : '01000000000',
    startDateTime: `${DATE} 10:00:00`,
    endDateTime  : `${DATE} 10:30:00`,
  }
}

/** getBlockedReason 기본값 — 휴게시간1 로 잡히게 한다. */
function blockedAsLunch() {
  return vi.fn(() => ({ reason: 'lunch' }))
}

async function openPopup(
  getBlockedReason: unknown = blockedAsLunch(),
  payloadOverride: Record<string, unknown> = {},
) {
  const wrapper = mount(ReservationPopup, {
    props: {
      visible: false,
      payload: { ...editPayload(), ...payloadOverride },
      getBlockedReason,
    },
    attachTo: document.body,
  })
  // watch 는 immediate 가 아니라 열림 전이 필요하다.
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

function findButton(wrapper: ReturnType<typeof mount>, label: string) {
  const btn = wrapper.findAll('button').find(b => b.text().trim() === label)
  if (!btn) throw new Error(`버튼을 찾지 못했다: ${label}`)
  return btn
}

/** 시작시각 UiTimeSelect(첫 번째)를 바꾼다 — 팝업 안에서 시간을 옮기는 조작. */
async function changeStartTime(wrapper: ReturnType<typeof mount>, time: string) {
  const selects = wrapper.findAll('.time-select-stub')
  expect(selects.length).toBeGreaterThanOrEqual(2)
  const startSelect = wrapper.findAllComponents({ name: 'UiTimeSelectStub' })[0]
  startSelect.vm.$emit('update:modelValue', time)
  await nextTick()
}

beforeEach(() => {
  mocks.confirm.mockReset()
  mocks.confirm.mockResolvedValue(true)
  mocks.alert.mockReset()
  mocks.alert.mockResolvedValue(true)
  mocks.atclLoad.mockReset()
  if (mocks.dataType) mocks.dataType.value = 'APPOINTMENT'
  mocks.atclGroups = []
  document.body.innerHTML = ''
})

describe('ReservationPopup — 고를 항목이 없는 그룹은 저장하지 않는다', () => {
  const withAtcl = { serviceGroupId: 10, serviceItemId: 101 }

  it('그룹에 항목이 하나도 없으면 서비스 항목을 null 로 보낸다', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), withAtcl)

    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    const payload = wrapper.emitted('modify')?.[0]?.[0] as Record<string, unknown>
    expect(payload.serviceGroupId).toBeNull()
    expect(payload.serviceItemId).toBeNull()
  })

  it('항목이 있는 그룹이면 그대로 보낸다', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), withAtcl)

    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    const payload = wrapper.emitted('modify')?.[0]?.[0] as Record<string, unknown>
    expect(payload.serviceGroupId).toBe(10)
    expect(payload.serviceItemId).toBe(101)
  })
})

// 필수값 표시는 한 규약이다 — 저장을 시도(tried)한 뒤 비어 있는 필드는 data-invalid="true" 로 붉게 켠다.
// 고객명은 PatientAutocomplete 안쪽 input 이 그 속성을 받고(invalid prop 경유), 전화번호는 input 이 직접 받는다.
// 두 자리가 같은 규약을 타는지 한 테스트로 본다 — 한쪽만 켜지면 사용자는 하나만 고치고 다시 막힌다.
// 기대값 출처: 템플릿의 :invalid / :data-invalid 바인딩(tried.formSubmit && !ok) + 사전 조건(시도 전엔 꺼짐).
describe('ReservationPopup — 필수값 미입력 표시(data-invalid)는 고객명·전화번호가 같은 규약', () => {
  const patientAc = (wrapper: ReturnType<typeof mount>) =>
    wrapper.findComponent({ name: 'PatientAutocompleteStub' })
  const phoneInput = (wrapper: ReturnType<typeof mount>) => wrapper.find('input[autocomplete="tel"]')

  it('저장을 시도하기 전에는 둘 다 꺼져 있다', async () => {
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), { patientName: '', patientPhone: '' })

    expect(patientAc(wrapper).props('invalid')).toBe(false)
    expect(phoneInput(wrapper).attributes('data-invalid')).toBe('false')
  })

  it('고객명·전화번호를 비운 채 저장하면 둘 다 켜지고 저장은 나가지 않는다', async () => {
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), { patientName: '', patientPhone: '' })

    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(patientAc(wrapper).props('invalid')).toBe(true)
    expect(phoneInput(wrapper).attributes('data-invalid')).toBe('true')
    expect(wrapper.emitted('modify')).toBeUndefined()
  })

  it('전화번호만 채워져 있으면 고객명만 켜진다 — 필드별로 따로 판정한다', async () => {
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), { patientName: '' })

    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(patientAc(wrapper).props('invalid')).toBe(true)
    expect(phoneInput(wrapper).attributes('data-invalid')).toBe('false')
  })
})

// 설정 팝업에서 마스터를 고친 뒤 닫으면 예약 팝업이 마스터를 다시 읽고 고른 값을 맞춘다.
// 항목 삭제 시 BE 도 참조 예약의 그룹·항목을 함께 지우므로(clearBookItemRef) 화면도 같은 규칙이다.
// 기대값 출처: onSettingPopupClosed 주석 — 그룹 없음·항목 전멸 → 둘 다 해제 / 고른 항목만 없음 → 첫 항목.
describe('ReservationPopup — 설정 팝업을 닫으면 고른 서비스 항목을 마스터에 맞춘다', () => {
  const picked = { serviceGroupId: 10, serviceItemId: 101 }
  const closeSetting = async (wrapper: ReturnType<typeof mount>) => {
    wrapper.findComponent({ name: 'TreatmentItemSettingPopupStub' }).vm.$emit('close')
    await flushPromises()
  }
  const savedAtcl = async (wrapper: ReturnType<typeof mount>) => {
    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()
    const payload = wrapper.emitted('modify')?.[0]?.[0] as Record<string, unknown>
    return { grp: payload.serviceGroupId, item: payload.serviceItemId }
  }
  /** 마스터를 제자리에서 바꾼다 — 팝업은 store 가 준 배열 참조를 들고 있어 재할당은 보이지 않는다. */
  const replaceMaster = (next: typeof mocks.atclGroups) => {
    mocks.atclGroups.splice(0, mocks.atclGroups.length, ...next)
  }

  it('그룹이 지워졌으면 그룹·항목을 모두 해제한다', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }, { serviceItemId: 102 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), picked)
    mocks.atclLoad.mockImplementation(async () => replaceMaster([]))

    await closeSetting(wrapper)

    expect(mocks.atclLoad).toHaveBeenCalledTimes(1)
    expect(await savedAtcl(wrapper)).toEqual({ grp: null, item: null })
  })

  it('그룹은 남았는데 항목이 하나도 없으면 그룹까지 해제한다', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }, { serviceItemId: 102 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), picked)
    mocks.atclLoad.mockImplementation(async () => replaceMaster([{ serviceGroupId: 10, items: [] }]))

    await closeSetting(wrapper)

    expect(await savedAtcl(wrapper)).toEqual({ grp: null, item: null })
  })

  it('고른 항목만 지워졌으면 남은 첫 항목으로 바꾼다', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }, { serviceItemId: 102 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), picked)
    mocks.atclLoad.mockImplementation(async () => replaceMaster([{ serviceGroupId: 10, items: [{ serviceItemId: 102 }] }]))

    await closeSetting(wrapper)

    expect(await savedAtcl(wrapper)).toEqual({ grp: 10, item: 102 })
  })

  // 대조군 — 마스터가 그대로면 고른 값도 그대로다(위 세 분기가 "닫기만 해도 바뀐다"가 아님을 보인다)
  it('마스터가 그대로면 고른 값을 건드리지 않는다', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }, { serviceItemId: 102 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), picked)
    mocks.atclLoad.mockResolvedValue(undefined)

    await closeSetting(wrapper)

    expect(await savedAtcl(wrapper)).toEqual({ grp: 10, item: 101 })
  })
})

// 서비스 항목은 입력칸이 없어 다른 필수값처럼 테두리로 알릴 수 없다 — 이 경로만 alert 다.
// 이전까지 useDialog mock 에 alert 자체가 없어 어떤 테스트도 이 분기를 밟지 않았다.
describe('ReservationPopup — 그룹은 골랐는데 항목을 안 고르면 alert 로 막는다', () => {
  const groupOnly = { serviceGroupId: 10, serviceItemId: null }

  // 기대값 출처: 문구는 TREATMENT_ITEM_REQUIRED_MSG(ReservationPopup.vue) 현행 고정.
  // 버튼 계약은 템플릿 주석 — "필수값 미입력이어도 클릭은 받는다, 비활성은 saving 중에만".
  it('항목이 있는 그룹을 골라 두고 항목 없이 수정하면 alert 1회·저장 없음·버튼은 미완성 표시만', async () => {
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), groupOnly)

    const button = findButton(wrapper, '수정')
    expect(button.classes()).toContain('is-incomplete')
    expect(button.attributes('disabled')).toBeUndefined()

    await button.trigger('click')
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith(
      '선택한 그룹의 서비스 항목을 선택해주세요.',
      expect.objectContaining({ title: '서비스 항목 선택' }),
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('modify')).toBeUndefined()
  })

  // alert 도 이 팝업이 띄운 다이얼로그라 확인창과 같은 가드를 탄다 — 빠지면 alert 의 [확인]
  // 클릭이 바깥 클릭으로 잡혀 팝업이 닫힌다(confirm 에서 실제로 났던 사고).
  it('alert 가 떠 있는 동안 바깥 클릭 닫힘이 꺼진다', async () => {
    let release: (_v: boolean) => void = () => {}
    mocks.alert.mockImplementation(() => new Promise<boolean>(r => { release = r }))
    mocks.atclGroups = [{ serviceGroupId: 10, items: [{ serviceItemId: 101 }] }]
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })), groupOnly)
    const popup = wrapper.findComponent(UiModal)

    await findButton(wrapper, '수정').trigger('click')
    await nextTick()
    expect(popup.props('hideOnOutsideClick')).toBe(false)

    release(true)
    await flushPromises()
    expect(popup.props('hideOnOutsideClick')).toBe(true)
  })
})

describe('ReservationPopup — 저장 직전 운영시간 재확인', () => {
  it('③ 연 시점과 일자·시작시각·담당자가 같으면 확인을 묻지 않는다', async () => {
    const wrapper = await openPopup()

    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('modify')).toHaveLength(1)
  })

  it('④ 운영시간 안이면 시간을 옮겨도 묻지 않는다', async () => {
    const wrapper = await openPopup(vi.fn(() => ({ reason: 'none' })))

    await changeStartTime(wrapper, '13:00')
    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('modify')).toHaveLength(1)
  })

  it('휴게시간대로 옮기면 사유 문구로 확인을 묻는다', async () => {
    const wrapper = await openPopup()

    await changeStartTime(wrapper, '13:00')
    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    const [text, opts] = mocks.confirm.mock.calls[0]
    expect(text).toContain(`${DOCTOR}님은 휴게시간1입니다`)
    expect(opts).toMatchObject({ title: '예약 확인' })
  })

  it('⑤ 확인에서 [취소] 하면 저장하지 않는다', async () => {
    mocks.confirm.mockResolvedValue(false)
    const wrapper = await openPopup()

    await changeStartTime(wrapper, '13:00')
    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('modify')).toBeUndefined()
  })

  it('⑥ 필수값이 비면 확인을 묻기 전에 멈춘다', async () => {
    const wrapper = await openPopup()

    // 고객명을 비운다
    wrapper.findComponent({ name: 'PatientAutocompleteStub' }).vm.$emit('update:modelValue', '')
    await nextTick()

    await findButton(wrapper, '수정').trigger('click')
    await flushPromises()

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('modify')).toBeUndefined()
  })

  it('① 확인을 받는 동안에는 바깥 클릭 닫힘이 꺼진다', async () => {
    let release: (v: boolean) => void = () => {}
    mocks.confirm.mockImplementation(() => new Promise<boolean>(r => { release = r }))

    const wrapper = await openPopup()
    const popup = wrapper.findComponent(UiModal)
    expect(popup.props('hideOnOutsideClick')).toBe(true)

    await changeStartTime(wrapper, '13:00')
    await findButton(wrapper, '수정').trigger('click')
    await nextTick()

    expect(popup.props('hideOnOutsideClick')).toBe(false)

    release(true)
    await flushPromises()
    expect(popup.props('hideOnOutsideClick')).toBe(true)
  })

  it('② 확인 중 팝업이 닫혀도 나가는 payload 는 온전하다', async () => {
    let release: (v: boolean) => void = () => {}
    mocks.confirm.mockImplementation(() => new Promise<boolean>(r => { release = r }))

    const wrapper = await openPopup()

    await changeStartTime(wrapper, '13:00')
    await findButton(wrapper, '수정').trigger('click')
    await nextTick()

    // ①이 뚫린 상황을 재현 — 확인 도중 닫힘이 돌아 form 이 초기화된다.
    wrapper.findComponent(UiModal).vm.$emit('hiding')
    await nextTick()

    release(true)
    await flushPromises()

    const events = wrapper.emitted('modify')
    expect(events).toHaveLength(1)
    const payload = events![0][0] as Record<string, unknown>
    expect(payload).toMatchObject({
      id          : 8659,
      doctorName  : DOCTOR,
      patientName : '테스트고객',
      patientPhone: '01000000000',
      dateStr     : DATE,
      startTimeStr: '13:00',
    })
    expect(payload.startDate).toBeTruthy()
    expect(payload.endDate).toBeTruthy()
  })
})

/**
 * 상태 뱃지(팝업 헤더) — 방문 화면의 대기(05)가 빠져 있었다.
 * 표기 규칙은 dataType 에 따라 갈린다. 예약 화면은 toDisplayStatus 가 00·03 외를 00 으로 접으므로
 * 대기 건에 뱃지가 없는 것이 정상이다.
 */
describe('ReservationPopup — 상태 뱃지', () => {
  function badge(wrapper: ReturnType<typeof mount>) {
    return wrapper.find('.popupTitleBadge')
  }

  // 뱃지 글자는 용어 사전(ko.json terms.status)의 값 — 05 대기 · 01 완료
  it('방문 화면 대기(05): 대기 뱃지를 is-receipt 로 보여준다', async () => {
    mocks.dataType!.value = 'TREATMENT'
    const wrapper = await openPopup(blockedAsLunch(), { status: '05' })

    const el = badge(wrapper)
    expect(el.exists()).toBe(true)
    expect(el.text()).toBe('대기')
    expect(el.classes()).toContain('is-receipt')
    expect(el.attributes('style') ?? '').not.toContain('display: none')
  })

  it('방문 화면 완료(01): 기존 표기가 그대로 유지된다', async () => {
    mocks.dataType!.value = 'TREATMENT'
    const wrapper = await openPopup(blockedAsLunch(), { status: '01' })

    const el = badge(wrapper)
    expect(el.text()).toBe('완료')
    expect(el.classes()).toContain('is-done')
  })

  it('예약 화면 대기(05): 뱃지를 감춘다 — 00·03 만 구분하는 규칙이다', async () => {
    const wrapper = await openPopup(blockedAsLunch(), { status: '05' })

    const el = badge(wrapper)
    expect(el.text()).toBe('')
    expect(el.attributes('style') ?? '').toContain('display: none')
  })
})
