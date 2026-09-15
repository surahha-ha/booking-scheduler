<script setup>
/* 캘린더 셀 entries 더보기 popover 셸.
 * 헤더(날짜 + 휴무 라벨 + 닫기)와 스크롤 컨테이너만 제공.
 * entry 렌더링은 호출처가 slot 으로 주입 (View: 읽기 전용 div, Setting: 편집 트리거 button).
 *
 * 외부 클릭/스크롤 close 는 호출처 책임 — 여러 popover 를 함께 닫는 호출처 통합 로직과 충돌 방지
 *
 * 단 ESC 닫기는 여기서 처리한다. 닫기 버튼과 똑같이 close 를 emit 할 뿐이라 호출처 통합 로직과
 * 충돌하지 않고, 마우스 없이 빠져나갈 수단이 이것뿐이다(카드 ⋮ 팝오버는 이미 ESC 로 닫힌다). */
import {onBeforeUnmount, watch} from 'vue';

const props = defineProps({
  open     : {type: Boolean, default: false},
  top      : {type: Number, default: 0},
  left     : {type: Number, default: 0},
  dayNumber: {type: Number, default: 0},
  isOff    : {type: Boolean, default: false},
});

const emit = defineEmits(['close']);

function onKeyDown(e) {
  if (e.key === 'Escape') emit('close');
}

// 열려 있는 동안만 구독한다 — 닫힌 popover 가 다른 화면의 ESC 를 가로채지 않게.
// immediate 필수: 호출처가 이미 열린 상태로 마운트하면(v-if) 초기값에는 watch 가 돌지 않아
// 리스너가 아예 안 붙는다.
watch(() => props.open, (open) => {
  if (open) document.addEventListener('keydown', onKeyDown);
  else document.removeEventListener('keydown', onKeyDown);
}, {immediate: true});

onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown));
</script>

<template>
  <Teleport to="body">
    <div
        v-if="open"
        :style="{
          top : `${top}px`,
          left: `${left}px`,
        }"
        class="cellMorePopover"
        @click.stop
        @mousedown.stop
        @pointerdown.stop
    >
      <header class="cellMorePopover__header">
        <span class="cellMorePopover__date">{{ dayNumber }}</span>
        <span
            v-if="isOff"
            class="cellMorePopover__offLabel"
        >휴무</span>
        <button
            aria-label="닫기"
            class="cellMorePopover__close schedule-popup__close-button schedule-popup__close-button--small"
            type="button"
            @click="emit('close')"
        >×</button>
      </header>
      <div class="cellMorePopover__list">
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.cellMorePopover {
  position: fixed;
  z-index: 2000;
  min-width: 180px;
  max-width: 280px;
  padding: 0;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-shadow: 0 4px 10px 0 rgba(0, 0, 0, 0.24);
  display: flex;
  flex-direction: column;

  &__header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
  }

  &__date {
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-default;
  }

  &__offLabel {
    font-size: $font-size-11;
    font-weight: $font-weight-bold;
    color: $color-danger;
    padding: 1px 4px;
    border: 1px solid $color-danger;
    border-radius: $radius-2;
    line-height: 1;
  }

  &__close {
    margin-left: auto;
  }

  &__list {
    display: flex;
    flex-direction: column;
    max-height: 320px;
    overflow-y: auto;

    :deep(.schedulerTreatmentView__appt),
    :deep(.schedulerTreatmentSetting__monthCellEntry) {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      font-size: $font-size-14;
    }

    :deep(.schedulerTreatmentView__apptDoctor),
    :deep(.schedulerTreatmentSetting__monthCellEntryName) {
      color: #000;
      font-weight: $font-weight-bold;
    }

    :deep(.schedulerTreatmentView__apptTime),
    :deep(.schedulerTreatmentSetting__monthCellEntryTime) {
      color: #727272;
      font-weight: 400;
    }
  }
}
</style>
