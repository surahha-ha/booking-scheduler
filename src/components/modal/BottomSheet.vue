<script setup>
import { ref } from 'vue';

defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['update:open']);

const close = () => {
  emit('update:open', false);
};

/** drag state */
const sheetRef = ref(null);
const startY = ref(0);
const currentY = ref(0);
const dragging = ref(false);

/** sheet 높이의 절반을 닫힘 기준으로 사용 */
const getCloseThreshold = () => {
  if (!sheetRef.value) return 0;
  return sheetRef.value.getBoundingClientRect().height / 2;
};

const onTouchStart = (e) => {
  startY.value = e.touches[0].clientY;
  currentY.value = startY.value;
  dragging.value = true;
};

const onTouchMove = (e) => {
  if (!dragging.value || !sheetRef.value) return;

  currentY.value = e.touches[0].clientY;
  const diff = currentY.value - startY.value;

  if (diff > 0) {
    sheetRef.value.style.transform = `translateY(${diff}px)`;
  }
};

const onTouchEnd = () => {
  if (!sheetRef.value) return;

  const diff = currentY.value - startY.value;
  const threshold = getCloseThreshold();

  dragging.value = false;

  if (diff > threshold) {
    close();
  } else {
    sheetRef.value.style.transform = 'translateY(0)';
  }

  startY.value = 0;
  currentY.value = 0;
};
</script>

<template>
  <Teleport to="body">
    <!-- Overlay -->
    <Transition name="fade">
      <div
        v-if="open"
        class="bottom-sheet-overlay"
        @click="close"
      />
    </Transition>

    <!-- Sheet -->
    <Transition name="slide-up">
      <div
        v-if="open"
        ref="sheetRef"
        class="bottom-sheet"
        @click.stop
      >
        <!-- drag handle -->
        <div
          class="sheet-control-bar"
          @touchstart="onTouchStart"
          @touchmove="onTouchMove"
          @touchend="onTouchEnd"
        >
          <div class="sheet-header-line" />
        </div>

        <div v-if="$slots.header" class="bottom-sheet-header">
          <slot name="header" />
        </div>

        <div class="bottom-sheet-content">
          <slot />
        </div>

        <div v-if="$slots.footer" class="bottom-sheet-footer">
          <slot name="footer" />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style lang="scss" scoped>
.bottom-sheet-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

.bottom-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #fff;
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  z-index: 1000;
  display: flex;
  flex-direction: column;

  transition: transform 0.05s linear;
  will-change: transform;
}

.sheet-control-bar {
  touch-action: pan-y;
}

.sheet-header-line {
  position: relative;
  margin: 10px 0;
  width: 80px;
  height: 4px;
  background-color: #e5e5e5;
  left: 50%;
  transform: translateX(-50%);
}

.bottom-sheet-header {
  padding: 20px 16px 12px;
  border-bottom: 1px solid #e5e5e5;
}

.bottom-sheet-content {
  flex: 1;
  overflow-y: auto;
  padding-bottom: env(safe-area-inset-bottom, 20px);
}

.bottom-sheet-footer {
  border-top: 1px solid #e5e5e5;
  padding: 12px 16px;
}

/* Transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.15s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
