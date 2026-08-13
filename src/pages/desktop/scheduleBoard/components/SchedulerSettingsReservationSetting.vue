<script setup>
import {computed, onMounted, ref} from 'vue';
import {cloneDeep, isEqual} from 'lodash-es';
import {push} from 'notivue';
import {getReservationSettings, saveReservationSettings} from '@/api/reservationSettingsApi';
import {useReservationSettingStore} from '@/stores/reservationSettingStore';
import {useListDragReorder, useRowHeightLevelDrag} from '@/composables';
import {rowHeightPx} from '@/scheduler-engine/redesign/layoutPipeline';
import UiSegmentedControl from '@/components/ui/UiSegmentedControl.vue';

/* ===== 상수 ===== */
/* 화면정의서(OSP_MD_APB034 §2) 기준 = 10 / 20 / 30 / 45 / 60분.
 * 15분은 정의서에 없어 노출하지 않는다(엔진은 값이 들어와도 처리 가능 — layoutPipeline cellDuration). */
const TIME_UNIT_ITEMS = [
  {value: 10, label: '10분'},
  // {value: 15, label: '15분'},
  {value: 20, label: '20분'},
  {value: 30, label: '30분'},
  {value: 45, label: '45분'},
  {value: 60, label: '60분'},
];

/* 카드 높이 단계 1~5 (작을수록 낮음 / 클수록 더 많은 정보 줄 노출). 엔진 ROW_HEIGHT_BY_LEVEL {1:50 … 5:110}px 단일 소스(rowHeightPx). */
const ROW_HEIGHT_ITEMS = [
  {value: 1, label: '1'},
  {value: 2, label: '2'},
  {value: 3, label: '3'},
  {value: 4, label: '4'},
  {value: 5, label: '5'},
];
const MIN_ROW_HEIGHT_LEVEL = 1;
const MAX_ROW_HEIGHT_LEVEL = 5;

function clampRowHeightLevel(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_ROW_HEIGHT_LEVEL, Math.min(MAX_ROW_HEIGHT_LEVEL, Math.trunc(n)));
}

const DISPLAY_INFO_ITEMS = [
  {value: 'NAME', label: '이름'},
  {value: 'BIRTH', label: '생년월일'},
  {value: 'AGE', label: '나이'},
  {value: 'GENDER', label: '성별'},
  {value: 'TREATMENT', label: '서비스 항목'},
  {value: 'PHONE', label: '전화번호'},
];
/* 코드 → 라벨, 기본 순서. 이름(NAME)은 항상 선두 고정(드래그 재정렬 제외). */
const DISPLAY_INFO_LABEL = Object.fromEntries(DISPLAY_INFO_ITEMS.map(i => [i.value, i.label]));
const DEFAULT_DISPLAY_ORDER = DISPLAY_INFO_ITEMS.map(i => i.value);
const FIXED_DISPLAY_HEAD = ['NAME']; // 고정 선두 개수 = 1

const OPERATING_START_MIN = 9 * 60;
const OPERATING_END_MIN = 24 * 60;
/* 카드 높이 단계(1~5) → 미리보기 슬롯 높이(px). level 2 = 65 = 기존 고정값(기본값 시각 회귀 0).
 * 드래그로 이 높이를 연속 조절 후 드롭 시 가장 가까운 단계로 스냅(useRowHeightLevelDrag). */
// 미리보기 슬롯 높이 = 엔진 ROW_HEIGHT_BY_LEVEL 단일 소스(rowHeightPx). 실제 보드 카드와 픽셀 일치.
const PREVIEW_SLOT_HEIGHTS = [1, 2, 3, 4, 5].map((lv) => rowHeightPx(lv));
/* 화면정의서(OSP_MD_APB034 §3) 기준 = 6~10칸.
 * 하한 1 은 한 Row 에 예약 1건만 보여 장부 기능을 잃는다. 서버값 로드 시에도 같은 clamp 를 탄다. */
const MIN_COLUMNS = 6;
const MAX_COLUMNS = 10;

/* 샘플 예약 1건 (Backend 매핑 전 임시) */
const SAMPLE_APPOINTMENT = {
  col      : 1,
  startMin : 9 * 60 + 50,
  endMin   : 10 * 60 + 20,
  name     : '홍길동',
  birth    : '1995-03-15',
  age      : 30,
  gender   : '남',
  treatment: '정기 점검',
  phone    : '5678',
};

const emit = defineEmits(['cancel', 'save']);

/* ===== 상태 ===== */
const reservationSettingStore = useReservationSettingStore();

const selectedTimeUnit = ref(30);
const totalColumns = ref(8);
const selectedDisplayInfo = ref(new Set(['NAME', 'AGE', 'GENDER', 'TREATMENT']));
/* 표시 정보 칩 순서(전체 6개, 이름 선두 고정). 활성 여부는 selectedDisplayInfo 가 따로 보유. */
const displayInfoOrder = ref([...DEFAULT_DISPLAY_ORDER]);
/* 카드 높이 단계. store 현재값으로 초기화 후 hydrateFromServer 에서 BE 영속 값으로 갱신. */
const selectedRowHeightLevel = ref(reservationSettingStore.rowHeightLevel);

/* 표시 정보 칩 드래그 재정렬 — 이름(선두 1개) 고정. */
const {
  dragIndex   : displayInfoDragIndex,
  overIndex   : displayInfoOverIndex,
  onDragStart : onDisplayInfoDragStart,
  onDragOver  : onDisplayInfoDragOver,
  onDrop      : onDisplayInfoDrop,
  onDragEnd   : onDisplayInfoDragEnd,
} = useListDragReorder(displayInfoOrder, {lockedHead: FIXED_DISPLAY_HEAD.length});

/* 행 경계 드래그 → 슬롯 높이 연속 조절 후 드롭 시 1~5 단계 스냅. 세그먼트 컨트롤과 동일 ref 구동. */
const {dragging: rowHeightDragging, slotHeightPx, startDrag: startRowHeightDrag} = useRowHeightLevelDrag({
  levelHeights: PREVIEW_SLOT_HEIGHTS,
  getLevel    : () => selectedRowHeightLevel.value,
  setLevel    : (level) => {
    selectedRowHeightLevel.value = level;
  },
});

/* ===== 계산 ===== */
const pxPerMin = computed(() =>
    slotHeightPx.value / selectedTimeUnit.value
);

const slots = computed(() => {
  const unit = selectedTimeUnit.value;
  const list = [];

  for (let m = OPERATING_START_MIN; m < OPERATING_END_MIN; m += unit) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    list.push({
      key   : m,
      minute: m,
      label : `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    });
  }

  return list;
});

const columns = computed(() =>
    Array.from({length: totalColumns.value}, (_, i) => i + 1)
);

const gridHeightPx = computed(() =>
    slots.value.length * slotHeightPx.value
);

const appointmentStyle = computed(() => {
  const a = SAMPLE_APPOINTMENT;
  const n = totalColumns.value;
  const top = (a.startMin - OPERATING_START_MIN) * pxPerMin.value;
  const height = (a.endMin - a.startMin) * pxPerMin.value;
  const left = ((a.col - 1) / n) * 100;
  const width = (1 / n) * 100;

  return {
    top   : `${top}px`,
    height: `${height}px`,
    left  : `${left}%`,
    width : `${width}%`,
  };
});

/* 코드 → 카드에 찍을 값(이름 제외). 칩 순서대로 노출. */
const SECONDARY_VALUE = {
  BIRTH    : SAMPLE_APPOINTMENT.birth,
  AGE      : String(SAMPLE_APPOINTMENT.age),
  GENDER   : SAMPLE_APPOINTMENT.gender,
  TREATMENT: SAMPLE_APPOINTMENT.treatment,
  PHONE    : SAMPLE_APPOINTMENT.phone,
};

const appointmentSecondaryParts = computed(() =>
    displayInfoOrder.value
        .filter(code => code !== 'NAME' && selectedDisplayInfo.value.has(code))
        .map(code => SECONDARY_VALUE[code]),
);

const showAppointmentName = computed(() =>
    selectedDisplayInfo.value.has('NAME')
);

/* ===== 핸들러 ===== */
function toggleDisplayInfo(value) {
  const next = new Set(selectedDisplayInfo.value);
  next.has(value) ? next.delete(value) : next.add(value);
  selectedDisplayInfo.value = next;
}

function onColumnInput(e) {
  const raw = Number(e.target.value);
  if (Number.isNaN(raw)) return;
  totalColumns.value = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.trunc(raw)));
}

/* 범용 확인 다이얼로그 — 운영일정 설정과 동일 shape */
const confirmDialog = ref(null);
// shape: {title, sub?, confirmLabel, onConfirm}

function askConfirm(config) {
  confirmDialog.value = {
    title       : config.title,
    sub         : config.sub ?? '',
    confirmLabel: config.confirmLabel ?? '확인',
    onConfirm   : config.onConfirm,
  };
}

function closeConfirmDialog() {
  confirmDialog.value = null;
}

function executeConfirm() {
  const fn = confirmDialog.value?.onConfirm;
  closeConfirmDialog();
  fn?.();
}

/* origin 스냅샷 — 마운트 시 1회 캡처, onCancel에서 isEqual로 변경 여부 비교.
 * Set 은 lodash isEqual 이 구조적으로 비교하므로 평탄화 불필요 */
function captureState() {
  return cloneDeep({
    selectedTimeUnit     : selectedTimeUnit.value,
    totalColumns         : totalColumns.value,
    selectedDisplayInfo  : selectedDisplayInfo.value,
    displayInfoOrder     : displayInfoOrder.value,
    selectedRowHeightLevel: selectedRowHeightLevel.value,
  });
}

let originState = null;

function isDirty() {
  return !isEqual(captureState(), originState);
}

/* 서버 → 내부 state 변환.
 * displayInfo 의 NAME 누락 시 UI 가 disabled 처리이므로 강제 포함시켜 round-trip 무손실. */
async function hydrateFromServer() {
  try {
    const res = await getReservationSettings();
    const body = res?.data ?? res;
    const payload = body?.payload;
    if (!payload) return;

    if (typeof payload.slotUnitMinutes === 'number') {
      selectedTimeUnit.value = payload.slotUnitMinutes;
    }
    if (typeof payload.totalColumnCount === 'number') {
      totalColumns.value = Math.max(
          MIN_COLUMNS,
          Math.min(MAX_COLUMNS, Math.trunc(payload.totalColumnCount)),
      );
    }
    if (Array.isArray(payload.displayInfo)) {
      /* displayInfo = "표시할 항목, 표시 순서". 저장 순서를 그대로 복원하고,
       * 비활성(누락) 코드는 기본 순서로 뒤에 붙여 칩 전체 순서를 재구성. NAME 선두 고정. */
      const saved = payload.displayInfo.filter(code => DEFAULT_DISPLAY_ORDER.includes(code));
      const ordered = ['NAME', ...saved.filter(code => code !== 'NAME')];
      for (const code of DEFAULT_DISPLAY_ORDER) {
        if (!ordered.includes(code)) ordered.push(code);
      }
      displayInfoOrder.value = ordered;

      const next = new Set(saved);
      next.add('NAME');
      selectedDisplayInfo.value = next;
    }
    /* cardHeightLevel(카드 높이): BE 영속 값. 응답에 있으면 반영, (예외적) 누락 시 store 초기값 유지. */
    const hydratedLevel = clampRowHeightLevel(payload.cardHeightLevel);
    if (hydratedLevel != null) selectedRowHeightLevel.value = hydratedLevel;
  } catch (e) {
    console.error('[예약장부 설정 > 조회] 실패', e);
  }
}

onMounted(async () => {
  await hydrateFromServer();
  /* origin 은 hydrate 후 캡처 — 서버 데이터 기준으로 dirty 비교 */
  originState = captureState();
});

function onCancel() {
  if (!isDirty()) {
    emit('cancel');
    return;
  }

  askConfirm({
    title       : '수정한 설정값이 있습니다.',
    sub         : '저장하지 않고 화면을 닫으시겠습니까?',
    confirmLabel: '확인',
    onConfirm   : () => emit('cancel'),
  });
}

const saving = ref(false);

async function onSave() {
  if (saving.value) return;
  saving.value = true;

  const payload = {
    slotUnitMinutes: selectedTimeUnit.value,
    totalColumnCount: totalColumns.value,
    /* 활성 코드를 "칩 순서대로" 직렬화 — 배열 순서 = 카드 표시 순서로 BE(DISP_ITEM_ORD)에 영속.
     * NAME 은 선두 고정(BE 가 NAME 제외 콤마 저장 + 응답에서 항상 [0] 재부착). */
    displayInfo  : displayInfoOrder.value.filter(code => selectedDisplayInfo.value.has(code)),
    /* 카드 높이 단계 — BE 영속 field(ROW_HEIGHT_LEVEL). 생략 시 BE 기본값 3. */
    cardHeightLevel: selectedRowHeightLevel.value,
  };

  try {
    const res = await saveReservationSettings(payload);
    const body = res?.data ?? res;
    /* 백엔드가 HTTP 200 + code 실패로 내려주는 케이스 처리 */
    if (body?.code && body.code !== 'succeed') {
      push.error(body.message || '저장에 실패했습니다.');
      return;
    }
    if (body?.message) push.success(body.message);
    /* 보드에 즉시 반영(optimistic) — 이어지는 reloadSchedulerData 의 load(true) 가 BE 영속 값으로 확정(동일 값). */
    reservationSettingStore.setLocalRowHeightLevel(selectedRowHeightLevel.value);
    /* 성공 시에만 팝업 닫기 */
    emit('save', payload);
  } catch (e) {
    push.error(e?.response?.data?.message || '저장에 실패했습니다.');
    console.error('[예약장부 설정 > 저장] 실패', e);
  } finally {
    saving.value = false;
  }
}

/* 부모(모달 hiding/외부 클릭/닫기 버튼)에서 호출 — onCancel 흐름과 동일 */
defineExpose({
  isDirty,
  attemptClose: onCancel,
});
</script>

<template>
  <div class="schedulerReservationSetting">
    <!-- ===== 상단 컨트롤 ===== -->
    <header class="schedulerReservationSetting__controls">
      <div class="schedulerReservationSetting__field">
        <span class="schedulerReservationSetting__fieldLabel">예약시간 단위</span>
        <UiSegmentedControl
            v-model="selectedTimeUnit"
            :items="TIME_UNIT_ITEMS"
        />
      </div>

      <div class="schedulerReservationSetting__field">
        <span class="schedulerReservationSetting__fieldLabel">전체 칸 개수</span>
        <span
            :data-tip="`${MIN_COLUMNS}~${MAX_COLUMNS}칸까지 설정할 수 있습니다`"
            class="schedulerReservationSetting__numberInputWrap"
        >
          <input
              :max="MAX_COLUMNS"
              :min="MIN_COLUMNS"
              :value="totalColumns"
              class="schedulerReservationSetting__numberInput"
              type="number"
              @input="onColumnInput"
          />
        </span>
      </div>

      <div class="schedulerReservationSetting__field">
        <span class="schedulerReservationSetting__fieldLabel">예약 표시 정보</span>
        <div class="schedulerReservationSetting__chipGroup">
          <button
              v-for="(code, idx) in displayInfoOrder"
              :key="code"
              :class="{
                'is-active': selectedDisplayInfo.has(code),
                'is-fixed': code === 'NAME',
                'is-dragging': displayInfoDragIndex === idx,
                'is-drag-over': displayInfoOverIndex === idx,
              }"
              :disabled="code === 'NAME'"
              :draggable="code !== 'NAME'"
              class="schedulerReservationSetting__infoChip"
              type="button"
              @click="toggleDisplayInfo(code)"
              @dragstart="onDisplayInfoDragStart(idx, $event)"
              @dragover="onDisplayInfoDragOver(idx, $event)"
              @drop="onDisplayInfoDrop(idx)"
              @dragend="onDisplayInfoDragEnd"
          >
            {{ DISPLAY_INFO_LABEL[code] }}
          </button>
        </div>
      </div>

      <div class="schedulerReservationSetting__field">
        <span class="schedulerReservationSetting__fieldLabel">예약 카드 높이</span>
        <UiSegmentedControl
            v-model="selectedRowHeightLevel"
            :items="ROW_HEIGHT_ITEMS"
        />
      </div>
    </header>

    <!-- ===== 스케줄러 미리보기 ===== -->
    <div class="schedulerReservationSetting__board">
      <div class="schedulerReservationSetting__headerRow">
        <div class="schedulerReservationSetting__cornerCell">
          시간
        </div>

        <div
            :style="{ gridTemplateColumns: `repeat(${totalColumns}, 1fr)` }"
            class="schedulerReservationSetting__colHeader"
        >
          <div
              v-for="col in columns"
              :key="col"
              class="schedulerReservationSetting__colHeaderCell"
          >
            {{ col }}
          </div>
        </div>
      </div>

      <div
          class="schedulerReservationSetting__scrollBody"
          @wheel.stop
      >
        <div class="schedulerReservationSetting__timeAxis">
          <div
              v-for="slot in slots"
              :key="slot.key"
              :style="{ height: `${slotHeightPx}px` }"
              class="schedulerReservationSetting__timeCell"
          >
            {{ slot.label }}
          </div>
        </div>

        <div
            :style="{
              gridTemplateColumns: `repeat(${totalColumns}, 1fr)`,
              gridTemplateRows: `repeat(${slots.length}, ${slotHeightPx}px)`,
              height: `${gridHeightPx}px`,
            }"
            class="schedulerReservationSetting__grid"
        >
          <div
              v-for="i in slots.length * totalColumns"
              :key="i"
              class="schedulerReservationSetting__gridCell"
          />

          <div
              :style="appointmentStyle"
              class="schedulerReservationSetting__appointment"
          >
            <div
                v-if="showAppointmentName"
                class="schedulerReservationSetting__appointmentName"
            >
              {{ SAMPLE_APPOINTMENT.name }}
            </div>

            <div
                v-if="appointmentSecondaryParts.length"
                class="schedulerReservationSetting__appointmentMeta"
            >
              <template
                  v-for="(part, idx) in appointmentSecondaryParts"
                  :key="idx"
              >
                <span>{{ part }}</span>
                <span
                    v-if="idx < appointmentSecondaryParts.length - 1"
                    class="schedulerReservationSetting__appointmentDivider"
                >|</span>
              </template>
            </div>
          </div>
        </div>

        <!-- 행 경계 드래그 핸들(전체 너비) — 시간축+그리드 위에 겹쳐 행 구분선 전체를 잡는다.
             모든 row 균일 조절 → 드롭 시 1~5 단계 스냅. -->
        <div
            :style="{ height: `${gridHeightPx}px` }"
            class="schedulerReservationSetting__rowResizeLayer"
        >
          <span
              v-for="(slot, idx) in slots"
              :key="`rh-${slot.key}`"
              :class="{ 'is-dragging': rowHeightDragging }"
              :style="{ top: `${(idx + 1) * slotHeightPx}px` }"
              class="schedulerReservationSetting__rowResizeHandle"
              title="드래그하여 행 높이 조절"
              @pointerdown="startRowHeightDrag"
          />
        </div>
      </div>
    </div>

    <!-- ===== 푸터 ===== -->
    <footer class="schedulerReservationSetting__footer">
      <button
          class="schedulerReservationSetting__cancelBtn"
          type="button"
          @click="onCancel"
      >취소</button>

      <button
          :disabled="saving"
          class="schedulerReservationSetting__saveBtn"
          type="button"
          @click="onSave"
      >{{ saving ? '저장 중...' : '저장' }}</button>
    </footer>

    <!-- 변경사항 확인 다이얼로그 (저장하지 않고 닫기) -->
    <Teleport to="body">
      <div
          v-if="confirmDialog"
          class="schedulerReservationSetting__confirmOverlay"
          @click.stop
          @mousedown.stop
      >
        <div class="schedulerReservationSetting__confirmPanel">
          <p class="schedulerReservationSetting__confirmMessage">{{ confirmDialog.title }}</p>
          <p
              v-if="confirmDialog.sub"
              class="schedulerReservationSetting__confirmSubMessage"
          >{{ confirmDialog.sub }}</p>
          <div class="schedulerReservationSetting__confirmActions">
            <button
                class="schedulerReservationSetting__confirmCancelBtn"
                type="button"
                @click="closeConfirmDialog"
            >취소</button>
            <button
                class="schedulerReservationSetting__confirmOkBtn"
                type="button"
                @click="executeConfirm"
            >{{ confirmDialog.confirmLabel }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

$time-col-width: 60px;

.schedulerReservationSetting {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;

  /* ---------- 상단 컨트롤 ---------- */
  &__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 28px;
    padding: 8px 14px 12px;
    border-bottom: 1px solid $color-border-light;
    background: #fff;
  }

  &__field {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  &__fieldLabel {
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-default;
    white-space: nowrap;
  }

  /* number input + 위쪽(top) 커스텀 tooltip 래퍼. 네이티브 title 은 방향 고정이 안 돼 CSS tooltip 으로 대체. */
  &__numberInputWrap {
    position: relative;
    display: inline-flex;

    /* hover 시 input 위쪽에 말풍선(data-tip) 표시 */
    &:hover::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      padding: 5px 9px;
      border-radius: $radius-2;
      background: rgba(33, 33, 33, 0.92);
      color: #fff;
      font-size: $font-size-12;
      font-weight: $font-weight-medium;
      line-height: 1.3;
      white-space: nowrap;
      pointer-events: none;
      z-index: 10;
    }

    /* 말풍선 아래쪽 화살표 */
    &:hover::before {
      content: '';
      position: absolute;
      bottom: calc(100% + 3px);
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: rgba(33, 33, 33, 0.92);
      pointer-events: none;
      z-index: 10;
    }
  }

  &__numberInput {
    width: 56px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    font-size: $font-size-13;
    color: $color-text-default;
    text-align: right;

    &:focus-visible {
      outline: 2px solid rgba(0, 0, 0, 0.2);
      outline-offset: 1px;
    }
  }

  &__chipGroup {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  &__infoChip {
    height: 24px;
    padding: 0 12px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    cursor: grab; /* 드래그 재정렬 가능 표시 */
    font-size: $font-size-12;
    color: $color-text-default;
    transition: opacity 0.12s, box-shadow 0.12s;

    &.is-active {
      background: #E88B1D;
      border-color: #E88B1D;
      color: #fff;
      font-weight: $font-weight-bold;
    }

    /* 드래그 중인 칩 */
    &.is-dragging {
      opacity: 0.4;
      cursor: grabbing;
    }

    /* 드롭 위치 표시 — 좌측 삽입 가이드 */
    &.is-drag-over {
      box-shadow: inset 2px 0 0 #E88B1D;
    }

    /* 이름(고정) — 드래그 불가, 토글 불가 */
    &.is-fixed,
    &:disabled {
      cursor: default;
      opacity: 1;

      &.is-active {
        background: #bbb;
        border-color: #bbb;
        color: #fff;
      }
    }
  }

  /* ---------- Board ---------- */
  &__board {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #fff;
    overflow: hidden;
  }

  &__headerRow {
    flex: 0 0 auto;
    display: flex;
    height: 32px;
    background: $color-bg-scheduler-header;
    border-bottom: 1px solid $color-border-light;
  }

  &__cornerCell {
    flex: 0 0 $time-col-width;
    display: flex;
    align-items: center;
    justify-content: center;
    border-right: 1px solid $color-border-light;
    font-size: $font-size-12;
    font-weight: $font-weight-medium;
    color: $color-text-default;
  }

  &__colHeader {
    flex: 1;
    min-width: 0;
    display: grid;
  }

  &__colHeaderCell {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 0;
    border-right: 1px solid $color-border-light;
    font-size: $font-size-12;
    font-weight: $font-weight-medium;
    color: $color-text-default;

    &:last-child {
      border-right: 0;
    }
  }

  &__scrollBody {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  &__timeAxis {
    flex: 0 0 $time-col-width;
    background: #fff;
    border-right: 1px solid $color-border-light;
  }

  &__timeCell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: $font-size-12;
    color: $color-text-default;
    border-bottom: 1px solid $color-divider;
  }

  /* 행 경계 드래그 오버레이 — 시간축+그리드 전체 너비를 덮고, 스크롤 콘텐츠와 함께 이동.
     레이어 자체는 클릭 통과(pointer-events:none), 핸들 줄만 잡힌다. */
  &__rowResizeLayer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    pointer-events: none;
    z-index: 2;
  }

  &__rowResizeHandle {
    position: absolute;
    left: 0;
    right: 0;
    height: 7px;
    transform: translateY(-50%); /* 경계선 중앙 정렬 */
    cursor: row-resize;
    touch-action: none;
    pointer-events: auto;

    &::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 2px;
      transform: translateY(-50%);
      background: transparent;
      transition: background 0.12s;
    }

    &:hover::after,
    &.is-dragging::after {
      background: #E88B1D;
    }
  }

  &__grid {
    flex: 1;
    min-width: 0;
    position: relative;
    display: grid;
  }

  &__gridCell {
    border-right: 1px solid $color-divider;
    border-bottom: 1px solid $color-divider;
    background: #fff;
  }

  /* ---------- 예약 카드 ---------- */
  &__appointment {
    position: absolute;
    box-sizing: border-box;
    padding: 2px 6px;
    border: 1px solid #BBDEFB;
    background: #E3F2FD;
    border-radius: $radius-2;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  &__appointmentName {
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: #000;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 카드 높이(단계)만큼 줄바꿈 노출 — 한 줄 고정이 아니라 흐르듯 wrap 되고,
     카드 overflow:hidden 이 높이에 맞춰 잘라낸다(낮으면 1줄·높으면 여러 줄). */
  &__appointmentMeta {
    display: block;
    min-width: 0;
    font-size: $font-size-11;
    color: #666;
    line-height: 1.3;
    white-space: normal;
    word-break: break-all;
  }

  &__appointmentDivider {
    margin: 0 4px;
    color: #ccc;
  }

  /* ---------- Footer ---------- */
  &__footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid $color-border-light;
    background: #fff;
  }

  &__cancelBtn,
  &__saveBtn {
    height: 32px;
    padding: 0 24px;
    border-radius: $radius-2;
    cursor: pointer;
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
  }

  &__cancelBtn {
    border: 1px solid $color-border-light;
    background: #fff;
    color: $color-text-default;

    &:hover { background: $color-surface-hover; }
  }

  &__saveBtn {
    border: 1px solid #E88B1D;
    background: #E88B1D;
    color: #fff;
    font-weight: $font-weight-bold;

    &:hover { filter: brightness(0.95); }
  }

  /* ---------- 확인 다이얼로그 ---------- */
  &__confirmOverlay {
    position: fixed;
    inset: 0;
    z-index: 2100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.3);
  }

  &__confirmPanel {
    min-width: 280px;
    padding: 24px 20px 16px;
    background: #fff;
    border-radius: $radius-2;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }

  &__confirmMessage {
    margin: 0;
    text-align: center;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;
  }

  &__confirmSubMessage {
    margin: 4px 0 0;
    text-align: center;
    font-size: $font-size-12;
    color: $color-text-muted;
  }

  &__confirmActions {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 16px;
  }

  &__confirmCancelBtn,
  &__confirmOkBtn {
    height: 28px;
    padding: 0 18px;
    border-radius: $radius-2;
    cursor: pointer;
    font-size: $font-size-12;
  }

  &__confirmCancelBtn {
    border: 1px solid #E88B1D;
    background: #fff;
    color: #E88B1D;

    &:hover { background: rgba(232, 139, 29, 0.08); }
  }

  &__confirmOkBtn {
    border: 1px solid #E88B1D;
    background: #E88B1D;
    color: #fff;
    font-weight: $font-weight-bold;

    &:hover { filter: brightness(0.95); }
  }
}
</style>
