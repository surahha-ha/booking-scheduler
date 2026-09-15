<script setup>
/**
 * 담당자 순서 변경 팝업 (화면정의서 4-2)
 *  - 검색필터 의사영역 ⇄ 버튼으로 오픈.
 *  - 소속 팀 | 담당자 테이블: 팀별 그룹, 드래그 핸들(≡)로 **팀 내에서만** 순서 변경(팀 변경 불가).
 *  - 저장: 순서 전용 API reorderTeamMembers(POST /book/v2/site/teams/member-order) 단일 호출.
 *          draft 의 팀별 doctors 순서를 { teamId, orderedStaffIds } 로 보내면 BE 가 그 index 로
 *          팀 멤버 SORT_ORD 만 UPDATE 한다(팀·운영시간·사업장(사업장 설정) 무관, 전체 치환/passthrough 없음).
 *          저장 후 staffStore.loadTeams() 재조회 → resolveVisibleDoctors(team.doctors 순서)로 검색필터/예약팝업/보드 반영.
 *  - 미지정 데이터 설정 버튼 → 공용 UnassignedDataModal (설정 화면과 동일 컴포넌트).
 */
import {computed, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import {push} from 'notivue';
import {useStaffStore} from '@/stores/staffStore';
import {reorderTeamMembers} from '@/api/siteApi';
import {getUnassignedReservations} from '@/api/bookApi';
import UnassignedDataModal from '@/components/popup/UnassignedDataModal.vue';

const props = defineProps({
  visible: {type: Boolean, default: false},
});
const emit = defineEmits(['close', 'saved']);

const staffStore = useStaffStore();
const {teams} = storeToRefs(staffStore);

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

/* ── 미지정 데이터 설정 (화면정의서 4-2 우상단 버튼) ── */
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

const unassignedModalOpen = ref(false);

function onUnassignedApplied() {
  unassignedAssignable.value = false; // 적용 후 재노출 방지(다음 오픈 시 재조회)
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
      <div class="doctorOrderPopup__panel schedule-popup">
        <header class="doctorOrderPopup__header schedule-popup__header">
          <span class="doctorOrderPopup__title schedule-popup__title">담당자 순서 변경</span>
          <div class="doctorOrderPopup__headerRight">
            <button
                v-if="showUnassignedBtn"
                class="doctorOrderPopup__unassignedBtn"
                type="button"
                @click="unassignedModalOpen = true"
            >미지정 데이터 설정</button>
            <button
                aria-label="닫기"
                class="doctorOrderPopup__close schedule-popup__close-button"
                type="button"
                @click="onCancel"
            >×</button>
          </div>
        </header>

        <div class="doctor-order-popup__body schedule-popup__body">
          <p class="doctorOrderPopup__desc">
            담당자를 드래그하여 순서를 변경하세요<br>
            <span class="doctor-order-popup__notice">(팀 변경은 불가합니다)</span>
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
              <template v-for="(team, teamIndex) in draft" :key="team.id">
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
                      :class="['doctorOrderPopup__teamCell', { 'is-last-team': teamIndex === draft.length - 1 }]"
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
        </div>

        <div class="doctorOrderPopup__actions schedule-popup__footer">
          <button
              :disabled="saving"
              class="doctorOrderPopup__cancelBtn schedule-popup__button"
              type="button"
              @click="onCancel"
          >취소</button>
          <button
              :disabled="saving || !draft.length"
              class="doctorOrderPopup__saveBtn schedule-popup__button schedule-popup__button--primary"
              type="button"
              @click="onSave"
          >{{ saving ? '저장 중...' : '저장' }}</button>
        </div>
      </div>
    </div>

  </Teleport>

  <!-- 미지정 데이터 설정 (공용 모달) -->
  <UnassignedDataModal
      :doctors="teamDoctors"
      :visible="unassignedModalOpen"
      @applied="onUnassignedApplied"
      @close="unassignedModalOpen = false"
  />
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
}

.doctorOrderPopup__headerRight {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.doctorOrderPopup__unassignedBtn {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  margin-right: 4px;
  border: 1px solid #a5a5a5;
  border-radius: 4px;
  background: #fff;
  color: #565656;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;

  &:hover { background: #f2f2f2; }
}

.doctorOrderPopup__panel {
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
}

.doctor-order-popup__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.doctorOrderPopup__desc {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 700;
  color: #393939;
  line-height: 1.4;
}

.doctor-order-popup__notice {
  font-size: 14px;
  font-weight: 400;
  color: #727272;
}

.doctorOrderPopup__tableWrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid #d2d2d2;
}

.doctorOrderPopup__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;

  th,
  td {
    height: 28px;
    padding: 0 12px;
    border-bottom: 1px solid #d2d2d2;
    text-align: left;
  }

  thead th {
    height: 26px;
    background: #f4f4f4;
    border-bottom-color: #d2d2d2;
    text-align: center;
    font-weight: 600;
    color: #565656;
    position: sticky;
    top: 0;
  }

  th + th {
    border-left: 1px solid #d2d2d2;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }
}

.doctorOrderPopup__thTeam { width: 40%; }

.doctorOrderPopup__teamCell {
  text-align: center !important;
  font-weight: 500;
  color: #565656;
  vertical-align: middle;
  background: #fff;

  &.is-last-team {
    border-bottom: 0;
  }
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
  gap: 12px;
  border-left: 1px solid #d2d2d2;
}

.doctorOrderPopup__handle {
  color: #727272;
  font-size: 14px;
  cursor: grab;
  user-select: none;
}

.doctorOrderPopup__doctorName {
  color: #565656;
  font-weight: 400;
}

.doctorOrderPopup__empty {
  text-align: center;
  color: #aaa;
  padding: 24px 0;
}

</style>
