<script setup>
/**
 * 담당자 순서 변경 팝업 (화면정의서 4-2)
 *  - 검색필터 의사영역 ⇄ 버튼으로 오픈.
 *  - 소속 팀 | 담당자 테이블: 팀별 그룹, 드래그 핸들(≡)로 **팀 내에서만** 순서 변경(팀 변경 불가).
 *  - 저장: 순서 전용 API reorderTeamMembers(POST /book/v2/site/teams/member-order) 단일 호출.
 *          draft 의 팀별 doctors 순서를 { teamId, orderedStaffIds } 로 보내면 BE 가 그 index 로
 *          팀 멤버 SORT_ORD 만 UPDATE 한다(팀·운영시간·사업장(사업장 설정) 무관, 전체 치환/passthrough 없음).
 *          저장 후 staffStore.loadTeams() 재조회 → resolveVisibleDoctors(team.doctors 순서)로 검색필터/예약팝업/보드 반영.
 *  - 미지정 데이터 설정 버튼은 증분 3 에서 추가.
 */
import {computed, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import {push} from 'notivue';
import {useStaffStore} from '@/stores/staffStore';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {reorderTeamMembers} from '@/api/siteApi';
import {assignUnassigned, getUnassignedReservations} from '@/api/bookApi';

const props = defineProps({
  visible: {type: Boolean, default: false},
});
const emit = defineEmits(['close', 'saved']);

const staffStore = useStaffStore();
const {teams} = storeToRefs(staffStore);
const filterStore = useSchedulerFilterStore();

/* 드래그 재정렬 대상 draft — 오픈 시 staffStore.teams 를 깊은 복사(취소 시 원복). */
const draft = ref([]);

watch(
    () => props.visible,
    (v) => {
      if (v) {
        draft.value = teams.value.map(t => ({
          id      : t.id,
          name    : t.name,
          doctors : (t.doctors ?? []).map(d => ({staffId: d.staffId, staffName: d.staffName})),
        }));
        fetchUnassignedAssignable();
      }
    },
    {immediate: true},
);

/* ── 미지정 데이터 설정 (화면정의서 4-2 우상단 버튼, 설정화면 unassignedDataModal 과 동일 기능) ── */
/* 팀에 등록된 담당자(중복 제거, 팀/구성원 순서 유지) — 미지정 데이터 적용 대상 후보 */
const teamDoctors = computed(() => {
  const seen = new Set();
  const list = [];
  for (const t of draft.value) {
    for (const d of t.doctors) {
      if (seen.has(d.staffId)) continue;
      seen.add(d.staffId);
      list.push({staffId: d.staffId, name: d.staffName});
    }
  }
  return list;
});

/* 버튼 노출 = 미지정 데이터 有(assignable) + 팀 담당자 有 */
const unassignedAssignable = ref(false);
const showUnassignedBtn = computed(() => unassignedAssignable.value && teamDoctors.value.length > 0);

async function fetchUnassignedAssignable() {
  try {
    const res = await getUnassignedReservations();
    const body = res?.data ?? res;
    unassignedAssignable.value = body?.payload?.assignable === true;
  } catch (e) {
    unassignedAssignable.value = false;
    console.error('[미지정 데이터 지정 가능 여부 조회] 실패', e);
  }
}

const unassignedModal = ref({open: false, selectedStaffId: null});
const applyingUnassigned = ref(false);

function openUnassignedModal() {
  unassignedModal.value = {open: true, selectedStaffId: teamDoctors.value[0]?.staffId ?? null};
}

function closeUnassignedModal() {
  unassignedModal.value = {...unassignedModal.value, open: false};
}

async function applyUnassignedData() {
  if (applyingUnassigned.value) return;
  const staffId = unassignedModal.value.selectedStaffId;
  if (staffId == null) return;
  applyingUnassigned.value = true;
  try {
    const res = await assignUnassigned(staffId);
    const body = res?.data ?? res;
    if (body?.code && body.code !== 'succeed') {
      push.error(body.message || '미지정 데이터 적용에 실패했습니다.');
      return;
    }
    if (body?.message) push.success(body.message);
    closeUnassignedModal();
    unassignedAssignable.value = false; // 적용 후 재노출 방지(다음 오픈 시 재조회)
    // load() 직접 호출 금지 — searchVersion watch chain 으로 재조회
    filterStore.triggerSearch();
  } catch (e) {
    push.error(e?.response?.data?.message || '미지정 데이터 적용에 실패했습니다.');
    console.error('[미지정 데이터 적용] 실패', e);
  } finally {
    applyingUnassigned.value = false;
  }
}

/* ── 드래그 (팀 내 한정) ── */
const drag = ref({teamId: null, index: null});
/* 현재 커서가 올라가 있는 행(드롭 위치) — dragover 로 추적해 그 행만 강조. */
const dragOver = ref({teamId: null, index: null});

function onDragStart(teamId, index) {
  drag.value = {teamId, index};
}

function onDragOver(event, teamId, index) {
  // 같은 팀 행 위에서만 drop 허용(preventDefault) + 그 행을 드롭 위치로 표시.
  // 다른 팀 위에선 허용하지 않아 브라우저가 🚫(no-drop) 커서 표시 → "팀 변경 불가".
  if (drag.value.teamId !== null && drag.value.teamId === teamId) {
    event.preventDefault();
    dragOver.value = {teamId, index};
  } else {
    dragOver.value = {teamId: null, index: null};
  }
}

function onDrop(teamId, index) {
  const d = drag.value;
  drag.value = {teamId: null, index: null};
  dragOver.value = {teamId: null, index: null};
  // 팀 변경 불가 — 같은 팀 내에서만 재정렬.
  if (d.teamId === null || d.teamId !== teamId || d.index === index) return;
  const team = draft.value.find(t => t.id === teamId);
  if (!team) return;
  const arr = team.doctors;
  const [moved] = arr.splice(d.index, 1);
  arr.splice(index, 0, moved);
}

function onDragEnd() {
  drag.value = {teamId: null, index: null};
  dragOver.value = {teamId: null, index: null};
}

/* ── 저장 ── */
const saving = ref(false);

async function onSave() {
  if (saving.value) return;
  saving.value = true;
  try {
    // 1) draft 의 팀별 doctors 순서를 순서 전용 payload 로 구성
    //    orderedStaffIds index 가 그대로 팀 멤버 SORT_ORD 가 된다 (전체 치환·passthrough 없음).
    const payload = {
      teams: draft.value.map(t => ({
        teamId        : t.id,
        orderedStaffIds: t.doctors.map(d => d.staffId),
      })),
    };
    // 2) 순서 전용 API 단일 호출 (팀·운영시간·사업장 무관)
    const saveRes = await reorderTeamMembers(payload);
    const body = saveRes?.data ?? saveRes;
    if (body?.code !== 'succeed') {
      push.error(body?.message || '담당자 순서 저장에 실패했습니다.');
      return;
    }
    if (body?.message) push.success(body.message);
    // 3) 팀 재조회 → resolveVisibleDoctors 가 새 순서로 검색필터/예약팝업/보드 반영
    await staffStore.loadTeams();
    emit('saved');
    emit('close');
  } catch (e) {
    push.error(e?.response?.data?.message || '담당자 순서 저장에 실패했습니다.');
    console.error('[담당자 순서 변경 > 저장] 실패', e);
  } finally {
    saving.value = false;
  }
}

function onCancel() {
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div
        v-if="visible"
        class="doctorOrderPopup__overlay"
        @click.self="onCancel"
    >
      <div class="doctorOrderPopup__panel">
        <header class="doctorOrderPopup__header">
          <span class="doctorOrderPopup__title">담당자 순서 변경</span>
          <div class="doctorOrderPopup__headerRight">
            <button
                v-if="showUnassignedBtn"
                class="doctorOrderPopup__unassignedBtn"
                type="button"
                @click="openUnassignedModal"
            >미지정 데이터 설정</button>
            <button
                aria-label="닫기"
                class="doctorOrderPopup__close"
                type="button"
                @click="onCancel"
            >×</button>
          </div>
        </header>

        <p class="doctorOrderPopup__desc">
          담당자를 드래그하여 순서를 변경하세요<br>
          (팀 변경은 불가합니다)
        </p>

        <div class="doctorOrderPopup__tableWrap">
          <table class="doctorOrderPopup__table">
            <thead>
              <tr>
                <th class="doctorOrderPopup__thTeam">소속 팀</th>
                <th class="doctorOrderPopup__thDoctor">담당자</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="team in draft" :key="team.id">
                <tr
                    v-for="(doc, idx) in team.doctors"
                    :key="`${team.id}-${doc.staffId}`"
                    :class="{
                      'is-drag-source-team': drag.teamId === team.id,
                      'is-drag-over': dragOver.teamId === team.id && dragOver.index === idx && drag.index !== idx,
                      'is-drag-blocked': drag.teamId !== null && drag.teamId !== team.id,
                    }"
                    class="doctorOrderPopup__row"
                    draggable="true"
                    @dragstart="onDragStart(team.id, idx)"
                    @dragover="onDragOver($event, team.id, idx)"
                    @drop="onDrop(team.id, idx)"
                    @dragend="onDragEnd"
                >
                  <td
                      v-if="idx === 0"
                      :rowspan="team.doctors.length"
                      class="doctorOrderPopup__teamCell"
                  >{{ team.name }}</td>
                  <td class="doctorOrderPopup__doctorCell">
                    <span class="doctorOrderPopup__handle">≡</span>
                    <span class="doctorOrderPopup__doctorName">{{ doc.staffName }}</span>
                  </td>
                </tr>
              </template>
              <tr v-if="!draft.length">
                <td class="doctorOrderPopup__empty" colspan="2">팀에 등록된 담당자가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="doctorOrderPopup__actions">
          <button
              :disabled="saving"
              class="doctorOrderPopup__cancelBtn"
              type="button"
              @click="onCancel"
          >취소</button>
          <button
              :disabled="saving || !draft.length"
              class="doctorOrderPopup__saveBtn"
              type="button"
              @click="onSave"
          >{{ saving ? '저장 중...' : '저장' }}</button>
        </div>
      </div>
    </div>

    <!-- 미지정 데이터 설정 (중첩 모달) -->
    <div
        v-if="unassignedModal.open"
        class="doctorOrderPopup__overlay doctorOrderPopup__overlay--nested"
        @click.self="closeUnassignedModal"
    >
      <div class="doctorOrderPopup__panel doctorOrderPopup__panel--narrow">
        <header class="doctorOrderPopup__header">
          <span class="doctorOrderPopup__title">미지정 데이터 적용</span>
          <button
              aria-label="닫기"
              class="doctorOrderPopup__close"
              type="button"
              @click="closeUnassignedModal"
          >×</button>
        </header>
        <p class="doctorOrderPopup__desc">
          담당자가 미지정된 예약/진료건에 대해 일괄 적용할 대상을 선택해주세요.
        </p>
        <div class="doctorOrderPopup__radioList">
          <label
              v-for="doc in teamDoctors"
              :key="`unassigned-${doc.staffId}`"
              class="doctorOrderPopup__radioItem"
          >
            <input
                :checked="unassignedModal.selectedStaffId === doc.staffId"
                name="doctorOrderUnassigned"
                type="radio"
                @change="unassignedModal.selectedStaffId = doc.staffId"
            >
            <span>{{ doc.name }}</span>
          </label>
        </div>
        <div class="doctorOrderPopup__actions">
          <button
              :disabled="applyingUnassigned"
              class="doctorOrderPopup__cancelBtn"
              type="button"
              @click="closeUnassignedModal"
          >취소</button>
          <button
              :disabled="applyingUnassigned || unassignedModal.selectedStaffId == null"
              class="doctorOrderPopup__saveBtn"
              type="button"
              @click="applyUnassignedData"
          >{{ applyingUnassigned ? '적용 중...' : '적용' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.doctorOrderPopup__overlay {
  position: fixed;
  inset: 0;
  z-index: 60000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);

  &--nested { z-index: 60010; } /* 미지정 모달 — 순서변경 팝업 위 */
}

.doctorOrderPopup__headerRight {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.doctorOrderPopup__unassignedBtn {
  height: 28px;
  padding: 0 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  font-size: 12px;
  font-weight: 600;
  color: #555;
  cursor: pointer;

  &:hover { background: #f0f0f0; }
}

.doctorOrderPopup__radioList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
  margin-bottom: 4px;
}

.doctorOrderPopup__radioItem {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.doctorOrderPopup__panel {
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  padding: 20px;
  box-sizing: border-box;

  &--narrow { width: 360px; }
}

.doctorOrderPopup__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.doctorOrderPopup__title {
  font-size: 16px;
  font-weight: 700;
  color: #222;
}

.doctorOrderPopup__close {
  border: 0;
  background: none;
  font-size: 22px;
  line-height: 1;
  color: #888;
  cursor: pointer;
}

.doctorOrderPopup__desc {
  margin: 0 0 12px;
  font-size: 12px;
  color: #888;
  line-height: 1.4;
}

.doctorOrderPopup__tableWrap {
  flex: 1;
  overflow-y: auto;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}

.doctorOrderPopup__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    border-bottom: 1px solid #eee;
    padding: 8px 12px;
    text-align: left;
  }

  thead th {
    background: #f5f6f8;
    font-weight: 700;
    color: #555;
    position: sticky;
    top: 0;
  }
}

.doctorOrderPopup__thTeam { width: 35%; }

.doctorOrderPopup__teamCell {
  font-weight: 700;
  color: #444;
  vertical-align: middle;
  background: #fafbfc;
  border-right: 1px solid #eee;
}

.doctorOrderPopup__row {
  cursor: grab;

  /* 드래그 중 같은 팀(유효 드롭존) — 그룹 전체를 옅게 강조 */
  &.is-drag-source-team {
    background: #eef6ff;
  }

  /* 드롭될 위치(같은 팀 내 대상 행) — 더 진하게 (source-team 위에 덮어씀) */
  &.is-drag-over {
    background: #cfe2ff;
  }

  /* 드래그 중 다른 팀 = 드롭 불가 — 흐리게 + not-allowed (🚫 커서는 onDragOver 가 native 로 표시). */
  &.is-drag-blocked {
    opacity: 0.4;
    cursor: not-allowed;
  }

  &:active { cursor: grabbing; }
}

/* 유효 드롭존(같은 팀)일 때 팀 이름 셀도 함께 강조 — 기본 배경(#fafbfc)보다 우선 */
.doctorOrderPopup__row.is-drag-source-team .doctorOrderPopup__teamCell {
  background: #e1ecff;
}

.doctorOrderPopup__doctorCell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.doctorOrderPopup__handle {
  color: #b0b4bd;
  font-size: 15px;
  cursor: grab;
  user-select: none;
}

.doctorOrderPopup__doctorName {
  color: #5b6cb8;
  font-weight: 600;
}

.doctorOrderPopup__empty {
  text-align: center;
  color: #aaa;
  padding: 24px 0;
}

.doctorOrderPopup__actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}

.doctorOrderPopup__cancelBtn,
.doctorOrderPopup__saveBtn {
  min-width: 72px;
  height: 34px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.doctorOrderPopup__cancelBtn {
  border: 1px solid #ccc;
  background: #fff;
  color: #555;
}

.doctorOrderPopup__saveBtn {
  border: 0;
  background: #f47725;
  color: #fff;

  &:disabled { opacity: 0.5; cursor: default; }
}
</style>
