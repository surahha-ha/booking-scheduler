// ============================================================================
// 진료항목 선택 규칙
// ----------------------------------------------------------------------------
// 진료내용 선택기(TreatmentContentSelector)와 예약 팝업(ReservationPopup)이 함께 쓴다.
// 두 곳이 같은 판정을 각자 들고 있으면 버튼 색과 저장 게이트가 갈린다(실제로 갈렸다).
//
// 진료항목은 선택값이다(PRD FR-8.2). 다만 선택 가능한 항목이 있는 그룹을 골랐다면
// 항목까지 골라야 짝이 맞는다. 항목이 하나도 없는 그룹은 고를 항목 자체가 없으므로
// 그룹만 선택된 상태를 정상으로 본다 — 그러지 않으면 저장에서 빠져나올 길이 없다.
// ============================================================================

export type WorkAtclGrpLike = {
    serviceGroupId: number;
    items?: { serviceItemId: number }[] | null;
};

/** 그룹에 선택 가능한 진료항목이 있는가. */
export function hasSelectableItems(group?: WorkAtclGrpLike | null): boolean {
    return (group?.items?.length ?? 0) > 0;
}

/** 진료항목 선택이 저장 가능한 상태인가. */
export function isTreatmentItemSelectionValid(
    groups: WorkAtclGrpLike[],
    grpNo?: number | null,
    atclNo?: number | null,
): boolean {
    // 그룹 없이 항목만 있는 상태는 짝이 깨진 것.
    if (grpNo == null) return atclNo == null;
    if (atclNo != null) return true;
    // 그룹만 선택 — 그 그룹에 고를 항목이 남아 있으면 미완성.
    return !hasSelectableItems(groups.find((g) => g.serviceGroupId === grpNo));
}
