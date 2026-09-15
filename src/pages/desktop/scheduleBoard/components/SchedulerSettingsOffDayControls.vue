<script setup>
/**
 * 휴무일 탭 컨트롤 3블록 — 요일별 / 특정일자 / 공휴일.
 *
 * 사업장과 담당자가 **같은 컨트롤**을 쓴다(계획서 §4-5-1·§4-5-3). 새 UI 를 만들지 않고
 * 사업장 것을 그대로 이식하기로 했으므로, 마크업을 복제하는 대신 이 컴포넌트를 owner 마다 세운다.
 *
 * 상태는 갖지 않는다 — 무엇이 휴무인지는 부모(`SchedulerSettingsTreatmentSetting.vue`)가 알고,
 * 여기는 받은 것을 그리고 조작을 되돌려 줄 뿐이다. 소유자별 표현 차이(사업장은 weekdayOffs 하나,
 * 담당자는 운영시간 표 + 매월 규칙 둘로 갈린다)는 부모가 흡수해 이 컴포넌트는 하나처럼 본다.
 *
 * 요일 드롭다운의 열림 상태만 이 컴포넌트가 갖는다 — 화면에 한 owner 패널만 떠 있고,
 * 선택이 바뀌면 컴포넌트째 사라져 열린 드롭다운도 함께 정리되기 때문이다.
 */
import {onBeforeUnmount, onMounted, ref} from 'vue';
import {RECURRING_OPTIONS, WEEKDAY_LABELS} from '../offDayOptions';

const props = defineProps({
  /* 이 패널이 편집하는 대상 — 'INSTITUTION' | 'STAFF:<staffId>'. key 생성용 */
  ownerKey: {type: String, required: true},
  /* Map<weekday, Set<'WEEKLY' | 'MONTHLY_n'>> — 그 요일에 걸린 반복 휴무 옵션 */
  optionsByWeekday: {type: Map, default: () => new Map()},
  /* Set<weekday> — 자기 값이 아니라 사업장에서 빌려 그리는 요일. 흐리게 그려 자기 값과 가른다 */
  inheritedWeekdays: {type: Set, default: () => new Set()},
  /* [{weekday, option, label}] — 반복 휴무 칩 */
  chips: {type: Array, default: () => []},
  /* [{type, label, ranges: [...]}] — 특정일자 칩을 휴무/운영으로 묶은 것 */
  dateGroups: {type: Array, default: () => []},
  /* 공휴일에 쉬는가. 담당자 미설정이면 부모가 사업장 값을 넣어 준다(§4-5-5) */
  holidayOff: {type: Boolean, default: false},
  /* 조회 완료 전에는 공휴일 체크박스를 그리지 않는다 — 기본값이 저장값으로 바뀌며 깜빡인다 */
  showHoliday: {type: Boolean, default: false},
  holidayTip: {type: String, default: ''},
});

const emit = defineEmits(['toggle-option', 'remove-range', 'set-holiday']);

const openWeekday = ref(null);
const dropdownPosition = ref({top: 0, left: 0});
const weekdayBtnRefs = new Map();

function setWeekdayBtnRef(idx, el) {
  if (el) weekdayBtnRefs.set(idx, el);
  else weekdayBtnRefs.delete(idx);
}

function hasOption(weekday, option) {
  return props.optionsByWeekday.get(weekday)?.has(option) ?? false;
}

function hasAnyOption(weekday) {
  return (props.optionsByWeekday.get(weekday)?.size ?? 0) > 0;
}

function toggleWeekdayDropdown(weekday) {
  if (openWeekday.value === weekday) {
    openWeekday.value = null;
    return;
  }

  const btn = weekdayBtnRefs.get(weekday);
  if (btn) {
    const rect = btn.getBoundingClientRect();
    dropdownPosition.value = {top: rect.bottom + 4, left: rect.left};
  }
  openWeekday.value = weekday;
}

function closeWeekdayDropdown() {
  openWeekday.value = null;
}

/* 드롭다운은 body 로 teleport 된 fixed 요소라, 바깥 클릭과 스크롤·리사이즈에 스스로 닫혀야 한다.
 * 버튼·패널에 @click.stop 이 걸려 있어 내부 클릭은 document 까지 올라오지 않는다. */
onMounted(() => {
  document.addEventListener('click', closeWeekdayDropdown);
  window.addEventListener('scroll', closeWeekdayDropdown, true);
  window.addEventListener('resize', closeWeekdayDropdown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', closeWeekdayDropdown);
  window.removeEventListener('scroll', closeWeekdayDropdown, true);
  window.removeEventListener('resize', closeWeekdayDropdown);
});
</script>

<template>
  <div class="schedulerTreatmentSetting__offPanel">
    <div class="schedulerTreatmentSetting__field">
      <span class="schedulerTreatmentSetting__fieldLabel">요일별</span>

      <div class="schedulerTreatmentSetting__weekdayList">
        <div
            v-for="(label, idx) in WEEKDAY_LABELS"
            :key="label"
            class="schedulerTreatmentSetting__weekdayItem"
        >
          <button
              :ref="(el) => setWeekdayBtnRef(idx, el)"
              :class="{
                'is-active': hasAnyOption(idx),
                'is-inherited': inheritedWeekdays.has(idx),
                'is-open'  : openWeekday === idx,
                'is-sunday': idx === 0,
                'is-saturday': idx === 6,
              }"
              class="schedulerTreatmentSetting__weekdayBtn"
              type="button"
              @click.stop="toggleWeekdayDropdown(idx)"
          >
            {{ label }}
          </button>

          <Teleport to="body">
            <div
                v-if="openWeekday === idx"
                :style="{
                  top : `${dropdownPosition.top}px`,
                  left: `${dropdownPosition.left}px`,
                }"
                class="schedulerTreatmentSetting__weekdayDropdown"
                @click.stop
                @mousedown.stop
                @pointerdown.stop
            >
              <!-- 모두 체크박스지만 매주와 매월은 배타다(부모의 토글 함수가 강제).
                   매주를 켜면 매월 n번째는 선택할 수 없다. -->
              <label
                  v-for="opt in RECURRING_OPTIONS"
                  :key="opt.value"
                  :class="{ 'is-disabled': opt.value !== 'WEEKLY' && hasOption(idx, 'WEEKLY') }"
                  class="schedulerTreatmentSetting__weekdayDropdownItem"
              >
                <input
                    :checked="hasOption(idx, opt.value)"
                    :disabled="opt.value !== 'WEEKLY' && hasOption(idx, 'WEEKLY')"
                    type="checkbox"
                    @change="emit('toggle-option', idx, opt.value)"
                />
                <span>{{ opt.label }}</span>
              </label>
            </div>
          </Teleport>
        </div>
      </div>
    </div>

    <ul class="schedulerTreatmentSetting__chipList">
      <li
          v-for="chip in chips"
          :key="`recurring-${ownerKey}-${chip.weekday}-${chip.option}`"
          :class="{'is-inherited': chip.locked}"
          class="schedulerTreatmentSetting__chip"
      >
        <span>{{ chip.label }}</span>
        <!-- 사업장에서 상속해 보여주는 규칙은 여기서 지울 것이 없다 — × 를 두면 눌러도 사라지지 않는다. -->
        <button
            v-if="!chip.locked"
            aria-label="삭제"
            class="schedulerTreatmentSetting__chipRemove"
            type="button"
            @click="emit('toggle-option', chip.weekday, chip.option)"
        >×</button>
      </li>
    </ul>

    <div class="schedulerTreatmentSetting__field specific-date-field">
      <span class="schedulerTreatmentSetting__fieldLabel">특정일자</span>

      <!-- 지정은 오른쪽 달력에서 한다 — 지정된 일자가 없을 때만 조작법을 안내하고, 있으면 칩으로 대체한다 -->
      <div class="schedulerTreatmentSetting__fieldBody">
        <p v-if="!dateGroups.length" class="schedulerTreatmentSetting__fieldHint">
          * 달력의 일자 선택 및 드래그 시 휴무일로 설정 가능
        </p>

        <!-- 목록이 길어질 수 있어 전부 노출하되(숨기면 저장에서도 빠져 원천 행이 지워진다)
             운영/휴무 구분선 + 스크롤로 정리한다. -->
        <div v-else class="schedulerTreatmentSetting__specificDates">
          <template v-for="group in dateGroups" :key="`override-type-${ownerKey}-${group.type}`">
            <p
                :class="[
                  'schedulerTreatmentSetting__specificDatesGroup',
                  group.type === 'OFF' ? 'is-off' : 'is-work',
                ]"
            >{{ group.label }}</p>

            <ul class="schedulerTreatmentSetting__chipList schedulerTreatmentSetting__chipList--inline">
              <li
                  v-for="range in group.ranges"
                  :key="`override-${ownerKey}-${range.startKey}-${range.endKey}-${range.type}`"
                  :class="{'is-inherited': range.locked}"
                  class="schedulerTreatmentSetting__chip"
              >
                <span>{{ range.label }}</span>
                <!-- 상속분은 지울 것이 없다. 뒤집으려면 오른쪽 달력에서 그 날짜를 누른다. -->
                <button
                    v-if="!range.locked"
                    aria-label="삭제"
                    class="schedulerTreatmentSetting__chipRemove"
                    type="button"
                    @click="emit('remove-range', range)"
                >×</button>
              </li>
            </ul>
          </template>
        </div>
      </div>
    </div>

    <div class="schedulerTreatmentSetting__field">
      <span class="schedulerTreatmentSetting__fieldLabel">공휴일</span>

      <!-- 커버리지·상속 안내는 hover tooltip 으로 — 인라인 문구는 패널 폭에서 2줄로 깨진다. -->
      <label
          v-if="showHoliday"
          :data-tip="holidayTip"
          class="schedulerTreatmentSetting__check schedulerTreatmentSetting__check--tip"
      >
        <input
            :checked="holidayOff"
            type="checkbox"
            @change="emit('set-holiday', $event.target.checked)"
        />
      </label>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;
@use '@/scss/schedule/setting-chip' as chip;

/* 클래스 이름은 부모와 같은 계열을 쓴다 — 같은 패널의 연속이라 이름이 갈리면 대조가 어렵다.
 * `&__x` 는 자손 선택자가 아니라 이름 결합이므로 부모 요소를 요구하지 않는다. */
.schedulerTreatmentSetting {
  @include chip.scheduler-setting-chip-base;

  /* 선택된 대상 아래 인라인으로 펼쳐지는 패널 (§4-5-3) */
  &__offPanel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__field {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* 특정일자만 위 정렬 — 목록이 세로로 자라는 필드다(퍼블리싱 규격). */
  .specific-date-field {
    align-items: flex-start;
  }

  &__fieldLabel {
    flex: 0 0 56px;
    font-size: $font-size-14;
    font-weight: $font-weight-regular;
    color: #565656;
  }

  &__fieldBody {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* 조작이 오른쪽 달력에서 이뤄지는 항목의 사용법 안내 */
  &__fieldHint {
    margin: 0;
    padding-top: 4px;
    font-size: $font-size-11;
    line-height: 1.5;
    color: $color-text-muted;
  }

  /* 특정일자 목록 — 원천이 공휴일을 여러 해 치 전개해 두므로 길어진다.
     전부 노출하되 높이를 묶고 스크롤한다(숨기면 저장에서도 빠져 원천 행이 지워진다). */
  &__specificDates {
    max-height: 132px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* 운영/휴무 구분 머리글. 이 목록에서 가장 먼저 읽혀야 하는 정보라 색으로 갈라 준다. */
  &__specificDatesGroup {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    padding: 2px 0;
    background: #fafafa;
    font-size: $font-size-14;
    font-weight: 700;

    &.is-off {
      color: #e54848;
    }

    &.is-work {
      color: $color-text-muted;
    }
  }

  &__chipList--inline {
    flex: 1;

    .schedulerTreatmentSetting__chip {
      width: auto;
      flex: 0 0 auto;
    }
  }

  /* 사업장에서 빌려 그리는 칩 — 이 담당자에게 저장된 값이 아니다. 지울 자기 값이 없어 × 도 없다.
     운영시간 탭의 빌린 값 표기와 같은 회색·이탤릭을 쓴다(같은 뜻이면 같은 표기여야 한다). */
  &__chip.is-inherited {
    background: $color-surface-alt;
    color: #9e9e9e;
    font-style: italic;
  }

  &__weekdayList {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  &__weekdayItem {
    position: relative;
    display: inline-flex;
  }

  &__weekdayBtn {
    width: 28px;
    height: 28px;
    border: 1px solid $color-border-default;
    border-radius: $radius-2;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-14;
    color: $color-text-default;

    &.is-sunday {
      color: $color-danger;
    }

    &.is-saturday {
      color: $color-now;
    }

    &.is-active {
      background: $color-primary;
      border-color: $color-primary;
      color: #fff;
      font-weight: $font-weight-bold;
    }

    /* 빌려 그리는 요일 — 체크는 되어 있되 자기 값이 아니다. 칩과 같은 회색으로 농도만 낮춘다.
       is-active 뒤에 둬야 채움색을 덮는다. */
    &.is-active.is-inherited {
      background: #9e9e9e;
      border-color: #9e9e9e;
    }

    &.is-open {
      border-color: $color-primary;
    }
  }

  &__weekdayDropdown {
    position: fixed;
    z-index: 2000;
    min-width: 90px;
    padding: 0;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: $radius-4;
    box-shadow: 0 4px 10px 0 rgba(0, 0, 0, 0.24);
    display: flex;
    flex-direction: column;
  }

  &__weekdayDropdownItem {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: $font-size-12;
    font-weight: $font-weight-semibold;
    color: $color-text-default;
    user-select: none;
    white-space: nowrap;

    /* 매주 휴무를 고르면 매월 n번째는 의미가 없어져 선택할 수 없다. */
    &.is-disabled {
      cursor: not-allowed;
      color: $color-text-muted;
    }

    &:first-child {
      border-bottom: 1px solid #e9e9e9;
    }

    &:hover:not(.is-disabled) {
      color: #000;
    }

    input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      margin: 0;
      border: 1px solid #c4c4c4;
      border-radius: 2px;
      background: #fff;
      cursor: pointer;

      &:checked {
        border-color: $color-primary;
        background-color: $color-primary;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: center;
        background-size: 100% 100%;
      }

      &:disabled {
        border-color: $color-border-light;
        background: $color-surface-alt;
        cursor: not-allowed;
      }
    }
  }

  &__check {
    display: inline-flex;
    align-items: center;
    padding-top: 4px;

    input[type='checkbox'] {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      margin: 0;
      border: 1px solid #c4c4c4;
      border-radius: 2px;
      background: #fff;
      cursor: pointer;

      &:checked {
        border-color: $color-primary;
        background-color: $color-primary;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: center;
        background-size: 100% 100%;
      }
    }
  }

  /* 체크박스 오른쪽 커스텀 tooltip — 네이티브 title 은 방향 고정이 안 된다.
     위가 아니라 오른쪽에 띄우는 이유: 바로 위 필드와 겹치지 않고, 오른쪽은 빈 공간이라 잘리지 않는다. */
  &__check--tip {
    position: relative;

    &:hover::after {
      content: attr(data-tip);
      position: absolute;
      left: calc(100% + 8px);
      top: 50%;
      transform: translateY(-50%);
      padding: 5px 9px;
      border-radius: $radius-2;
      background: rgba(33, 33, 33, 0.92);
      color: #fff;
      font-size: $font-size-12;
      font-weight: $font-weight-medium;
      line-height: 1.4;
      /* 사이드바가 400px 고정이라 nowrap 이면 말풍선이 잘린다. 말풍선 안에서는 줄바꿈이 자연스럽다.
       * keep-all — 한글을 어절 중간에서 끊지 않는다. */
      width: max-content;
      max-width: 220px;
      white-space: normal;
      word-break: keep-all;
      pointer-events: none;
      z-index: 10;
    }

    /* 말풍선 왼쪽 화살표 */
    &:hover::before {
      content: '';
      position: absolute;
      left: calc(100% + 3px);
      top: 50%;
      transform: translateY(-50%);
      border: 5px solid transparent;
      border-right-color: rgba(33, 33, 33, 0.92);
      pointer-events: none;
      z-index: 10;
    }
  }
}
</style>
