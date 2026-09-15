import {describe, expect, it} from 'vitest';
import {
    hasSelectableItems,
    isTreatmentItemSelectionValid,
    type WorkAtclGrpLike,
} from '@/components/popup/treatmentItemRules';

// 그룹 1 = 항목 있음 / 그룹 2 = 항목 0개(설정에서 그룹만 만들고 항목을 저장하지 않은 상태)
const GROUPS: WorkAtclGrpLike[] = [
    {serviceGroupId: 1, items: [{serviceItemId: 11}, {serviceItemId: 12}]},
    {serviceGroupId: 2, items: []},
];

describe('hasSelectableItems', () => {
    it('항목이 있으면 true', () => {
        expect(hasSelectableItems(GROUPS[0])).toBe(true);
    });

    it('항목 0개·items 누락·그룹 없음은 모두 false', () => {
        expect(hasSelectableItems(GROUPS[1])).toBe(false);
        expect(hasSelectableItems({serviceGroupId: 3})).toBe(false);
        expect(hasSelectableItems(null)).toBe(false);
    });
});

describe('isTreatmentItemSelectionValid', () => {
    it('서비스 항목 미입력(그룹·항목 모두 없음)은 유효 — 선택값이다', () => {
        expect(isTreatmentItemSelectionValid(GROUPS, null, null)).toBe(true);
    });

    it('그룹+항목 짝이 맞으면 유효', () => {
        expect(isTreatmentItemSelectionValid(GROUPS, 1, 11)).toBe(true);
    });

    it('항목이 있는 그룹인데 항목 미선택이면 무효', () => {
        expect(isTreatmentItemSelectionValid(GROUPS, 1, null)).toBe(false);
    });

    it('항목이 0개인 그룹은 항목 없이도 유효 — 고를 항목이 없어 갇히면 안 된다', () => {
        expect(isTreatmentItemSelectionValid(GROUPS, 2, null)).toBe(true);
    });

    it('store 에 없는 그룹(삭제됨)은 항목 없이도 유효', () => {
        expect(isTreatmentItemSelectionValid(GROUPS, 999, null)).toBe(true);
    });

    it('그룹 없이 항목만 있으면 무효', () => {
        expect(isTreatmentItemSelectionValid(GROUPS, null, 11)).toBe(false);
    });
});
