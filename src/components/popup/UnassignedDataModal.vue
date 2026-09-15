<script setup>
/**
 * 미지정 데이터 적용 모달 (공용)
 *  - 진입점 2곳 공용: 메인 화면(담당자 순서 변경 팝업) · 설정 화면(운영일정 설정).
 *    두 곳이 서로 다른 vue/CSS 로 같은 기능을 중복 구현하던 것을 메인 화면 UI 기준으로 통합.
 *  - 담당자 목록은 prop 주입 — 호출측마다 소스가 다르다(메인=저장된 팀, 설정=저장 전 편집 draft).
 *    컴포넌트가 스토어를 직접 읽으면 설정화면의 '편집 중 목록'이 반영되지 않는다.
 *  - 버튼 노출 판정(getUnassignedReservations)은 호출측 책임. 여기서는 적용만 하고 applied 를 올린다.
 */
import {ref, watch} from 'vue';
import {push} from 'notivue';
import {assignUnassigned} from '@/api/bookApi';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';

const props = defineProps({
  visible: {type: Boolean, default: false},
  /** 적용 대상 후보 — [{staffId, name}] */
  doctors: {type: Array, default: () => []},
});
const emit = defineEmits(['close', 'applied']);

const filterStore = useSchedulerFilterStore();

const selectedStaffId = ref(null);
const applying = ref(false);

/* 열릴 때마다 첫 담당자를 기본 선택 */
watch(
    () => props.visible,
    (v) => {
      if (v) selectedStaffId.value = props.doctors[0]?.staffId ?? null;
    },
    {immediate: true},
);

function onClose() {
  emit('close');
}

async function onApply() {
  if (applying.value) return;
  const staffId = selectedStaffId.value;
  if (staffId == null) return;

  applying.value = true;
  try {
    const res = await assignUnassigned(staffId);
    const body = res?.data ?? res;
    /* 백엔드가 HTTP 200 + code 실패로 내려주는 케이스 처리 */
    if (body?.code && body.code !== 'succeed') {
      push.error(body.message || '미지정 데이터 적용에 실패했습니다.');
      return;
    }
    if (body?.message) push.success(body.message);
    emit('applied');
    emit('close');
    /* 적용 결과를 스케줄러에 반영 — load() 직접 호출 금지, searchVersion watch chain 으로 재조회 */
    filterStore.triggerSearch();
  } catch (e) {
    push.error(e?.response?.data?.message || '미지정 데이터 적용에 실패했습니다.');
    console.error('[미지정 데이터 적용] 실패', e);
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
        v-if="visible"
        class="unassignedModal__overlay"
        @click.self="onClose"
        @mousedown.stop
    >
      <div class="unassignedModal__panel schedule-popup">
        <header class="unassignedModal__header schedule-popup__header">
          <span class="unassignedModal__title schedule-popup__title">미지정 데이터 적용</span>
          <button
              aria-label="닫기"
              class="unassignedModal__close schedule-popup__close-button"
              type="button"
              @click="onClose"
          >×</button>
        </header>

        <div class="unassigned-modal__body schedule-popup__body">
          <p class="unassignedModal__desc">
            담당자가 미지정된 예약/방문 건에 대해 일괄 적용할 대상을 선택해주세요.
          </p>

          <div class="unassignedModal__radioList">
          <label
              v-for="doc in doctors"
              :key="`unassigned-${doc.staffId}`"
              class="unassignedModal__radioItem"
          >
            <input
                :checked="selectedStaffId === doc.staffId"
                name="unassignedDoctor"
                type="radio"
                @change="selectedStaffId = doc.staffId"
            >
            <span>{{ doc.name }}</span>
          </label>
          <p
              v-if="doctors.length === 0"
              class="unassignedModal__empty"
          >팀에 등록된 담당자가 없습니다.</p>
          </div>
        </div>

        <div class="unassignedModal__actions schedule-popup__footer">
          <button
              :disabled="applying"
              class="unassignedModal__laterBtn schedule-popup__button"
              type="button"
              @click="onClose"
          >나중에 설정</button>
          <button
              :disabled="applying || selectedStaffId == null"
              class="unassignedModal__applyBtn schedule-popup__button schedule-popup__button--primary"
              type="button"
              @click="onApply"
          >{{ applying ? '적용 중...' : '적용' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

/* 설정 화면은 DxPopup(DevExtreme overlay) 안에서 열린다 — 그 위에 뜨도록 단일 상위값 사용. */
.unassignedModal__overlay {
  position: fixed;
  inset: 0;
  z-index: 60010;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.unassignedModal__panel {
  width: 360px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
}

.unassigned-modal__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.unassignedModal__desc {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 700;
  color: #393939;
  line-height: 1.4;
}

/* 담당자 多(예: 100명) 시 모달 무한 확장 방지 — 리스트만 스크롤 */
.unassignedModal__radioList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
  margin-bottom: 4px;
}

.unassignedModal__radioItem {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.unassignedModal__radioItem input[type="radio"] {
  accent-color: $color-primary;
}

.unassignedModal__empty {
  margin: 0;
  font-size: 12px;
  color: #aaa;
}

</style>
