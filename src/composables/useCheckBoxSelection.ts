import {computed, type Ref, watch} from 'vue';

export type SelectionValue = string | number;

export interface ButtonItem<V extends SelectionValue = SelectionValue> {
    value: V;
    label: string;
}

export function useCheckBoxSelection<V extends SelectionValue>(options: {
    items: () => ButtonItem<V>[];
    selectedValues: Ref<V[]>;
    onChange?: (next: V[]) => void;
    normalizeOnItemsChange?: boolean; // default true
    preventEmpty?: boolean;           // default true
    signature?: (values: V[]) => string; // default join('|')
    isAllEmpty?: boolean; // 전체를 빈 문자열로 취급할지 여부
}) {
    const {
        selectedValues,
        onChange,
        normalizeOnItemsChange = true,
        preventEmpty = true,
        signature = (values) => values.join('|'),
        isAllEmpty = true,
    } = options;

    const allValues = computed<V[]>(() => (options.items() ?? []).map((x) => x.value));
    const allSig = computed(() => signature(allValues.value));

    const selectedSet = computed(() => new Set(selectedValues.value ?? []));

    function areAllValuesSelected(vals: V[], set: Set<V>) {
        return vals.every((v) => set.has(v));
    }

    const isAllSelected = computed(() => {
        const vals = allValues.value;
        if (!vals.length) return false;
        const sel = selectedValues.value ?? [];

        if (isAllEmpty && sel.length === 0) return true;

        return areAllValuesSelected(vals, selectedSet.value);
    });

    function emit(next: V[]) {
        if (onChange) {
            onChange(next);
        } else {
            selectedValues.value = next;
        }
    }

    function selectAll() {
        if (isAllSelected.value) return;
        emit(isAllEmpty ? [] : [...allValues.value]);
    }

    function isActive(value: V) {
        if (isAllSelected.value) return false;
        return selectedSet.value.has(value);
    }

    function toggle(value: V) {
        if (isAllSelected.value) {
            // 항목이 하나뿐이면 그 하나가 곧 전 항목이라 '전체'와 같은 뜻이다.
            // 여기서 [value] 를 내보내면 화면은 계속 '전체'인데 선택값만 달라져
            // 불필요한 재조회가 돌고, 다시 눌러도 같은 값이 재-emit 되어 되돌릴 수 없다.
            const vals = allValues.value;
            if (isAllEmpty && vals.length === 1 && vals[0] === value) return;

            emit([value]);
            return;
        }

        const set = new Set(selectedValues.value ?? []);
        set.has(value) ? set.delete(value) : set.add(value);

        if (set.size === 0) {
            emit(!isAllEmpty && preventEmpty ? [...allValues.value] : []);
            return;
        }

        const next = Array.from(set);

        if (isAllEmpty) {
            const vals = allValues.value;
            if (vals.length && areAllValuesSelected(vals, set)) {
                emit([]);
                return;
            }
        }

        emit(next);
    }

    if (normalizeOnItemsChange) {
        watch(
            allSig,
            () => {
                const vals = allValues.value;
                const sel = selectedValues.value ?? [];

                if (isAllEmpty && sel.length === 0) return;

                const cur = new Set(sel);
                const filtered = vals.filter((v) => cur.has(v));

                if (filtered.length === 0) {
                    emit(isAllEmpty ? [] : [...vals]);
                    return;
                }

                if (isAllEmpty && vals.length && filtered.length === vals.length) {
                    emit([]);
                    return;
                }

                emit(filtered);
            },
            {immediate: true}
        );
    }
    return {isAllSelected, selectAll, isActive, toggle};
}
