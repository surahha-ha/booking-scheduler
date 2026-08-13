<script setup>
// ============================================================================
// 앱 공용 모달 — 외부 팝업 라이브러리 비의존 자체 구현
// ----------------------------------------------------------------------------
// 닫기 요청(외부클릭·ESC·닫기버튼)은 hiding 이벤트로 먼저 알리고, 핸들러가
// e.cancel = true 로 취소할 수 있다. 취소되지 않은 경우에만 update:visible(false).
// ============================================================================
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';

const props = defineProps({
    visible           : {type: Boolean, default: false},
    title             : {type: String, default: ''},
    /** 숫자는 px, 문자열은 그대로 (예: 'calc(100vw - 28px)') */
    width             : {type: [String, Number], default: 480},
    height            : {type: [String, Number], default: null},
    showCloseButton   : {type: Boolean, default: true},
    hideOnOutsideClick: {type: Boolean, default: false},
    /** 오버레이(클릭 차단막) 렌더 여부 */
    shading           : {type: Boolean, default: true},
    /** 'center' | 'top' */
    position          : {type: String, default: 'center'},
    /** position='top' 일 때 상단 여백(px) */
    topOffset         : {type: Number, default: 0},
    /** 최상위 wrapper 에 부여할 클래스 (스타일 훅) */
    wrapperClass      : {type: String, default: ''},
});

const emit = defineEmits(['hiding', 'shown', 'update:visible']);

const contentRef = ref(null);

const toCssSize = (v) => (v == null ? null : typeof v === 'number' ? `${v}px` : v);

const contentStyle = computed(() => ({
    width : toCssSize(props.width),
    height: toCssSize(props.height),
}));

const wrapperStyle = computed(() => (
    props.position === 'top' ? {alignItems: 'flex-start', paddingTop: `${props.topOffset}px`} : null
));

/** 닫기 시도 — hiding 이 취소되지 않은 경우에만 닫는다. */
function requestHide() {
    const e = {cancel: false};
    emit('hiding', e);
    if (e.cancel) return;
    emit('update:visible', false);
}

function onOverlayMouseDown(ev) {
    if (!props.hideOnOutsideClick) return;
    // content 내부에서 시작한 클릭은 무시 (drag 로 밖에서 놓는 경우 포함)
    if (contentRef.value?.contains(ev.target)) return;
    requestHide();
}

function onKeydown(ev) {
    if (ev.key === 'Escape') requestHide();
}

watch(() => props.visible, async (open) => {
    if (open) {
        document.addEventListener('keydown', onKeydown);
        await nextTick();
        emit('shown');
    } else {
        document.removeEventListener('keydown', onKeydown);
    }
}, {immediate: true});

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
        v-if="visible"
        :class="[ 'uiModal', wrapperClass, { 'uiModal--shaded': shading } ]"
        :style="wrapperStyle"
        role="presentation"
        @mousedown="onOverlayMouseDown"
    >
      <div ref="contentRef" :style="contentStyle" aria-modal="true" class="uiModal__content" role="dialog">
        <div class="uiModal__title">
          <slot name="title">
            <div class="uiModal__titleBar">
              <slot name="titleExtra"/>
              <span class="uiModal__titleText">{{ title }}</span>
            </div>
          </slot>

          <button
              v-if="showCloseButton"
              aria-label="닫기"
              class="uiModal__close"
              type="button"
              @click="requestHide"
          >✕
          </button>
        </div>

        <div class="uiModal__body">
          <slot name="content">
            <slot/>
          </slot>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss">
/* 전역 — wrapperClass 로 넘어온 훅 클래스에 각 화면 SCSS 가 붙는다(scoped 불가) */
.uiModal {
  position: fixed;
  inset: 0;
  z-index: 1501;
  display: flex;
  align-items: center;
  justify-content: center;
}

.uiModal--shaded {
  background: rgba(0, 0, 0, 0);
}

.uiModal__content {
  display: flex;
  flex-direction: column;
  max-width: 100vw;
  max-height: 100vh;
  overflow: hidden;
  background: #fff;
  border-radius: 8px;
  box-sizing: border-box;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
}

.uiModal__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  gap: 8px;
  padding: 14px 20px;
  font-size: 16px;
  font-weight: 700;
  color: #000;
  background-color: #fff;
}

.uiModal__titleBar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.uiModal__close {
  flex: 0 0 auto;
  padding: 0 4px;
  font-size: 18px;
  line-height: 1;
  color: #000;
  background: none;
  border: 0;
  cursor: pointer;
}

.uiModal__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 20px 20px;
  overflow: visible;
  box-sizing: border-box;
}
</style>
