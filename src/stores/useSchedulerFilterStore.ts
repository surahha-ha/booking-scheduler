import {defineStore} from 'pinia';
import dayjs from 'dayjs';
import {
    AppointmentStatusType,
    TreatmentStatusType,
    DataType,
    MemberType,
    TreatmentStateType,
    ViewMode
} from '@/constants/schedulerSearchFilter';
import {normalizeId} from '@/utils/formatStringUtils';
import {IS_RESET_TO_TODAY} from '@/constants/componentConstants';

export interface SchedulerFilterState {
    periodDate: Date;
    viewMode: ViewMode;
    dataType: DataType;
    memberType: MemberType;
    treatmentStateType: TreatmentStateType;
    keyword?: string;
    doctors: string[];
    selectedTeamName: string | null;
    status: (AppointmentStatusType | TreatmentStatusType)[];
    searchVersion: number;
    isResetToToday: boolean;
    // V3 전용 조회 윈도우 (가산). 설정 시 toBookApiParams 가 viewMode/periodDate 대신
    // [windowAnchorDate, +windowDays) 범위로 조회. V2 는 미설정(null/0)이라 기존 경로 유지(무영향).
    windowAnchorDate: Date | null;
    windowDays: number;
}

// 뷰 모드에 맞춰 기준 날짜 정규화
function normalizePeriodDate(date: Date, viewMode: ViewMode) {
    const base = dayjs(date);
    return viewMode === 'WEEK'
        ? base.startOf('week').startOf('day').toDate()
        : base.startOf('day').toDate();
}

// 스케줄러 필터 store
export const useSchedulerFilterStore = defineStore('useSchedulerFilterStore', {
    state: (): SchedulerFilterState => ({
        periodDate: normalizePeriodDate(new Date(), 'WEEK'),
        viewMode: 'WEEK',
        dataType: 'APPOINTMENT',
        memberType: 'N',
        treatmentStateType: 'Y',
        doctors: [],
        selectedTeamName: null,
        status: [],
        keyword: '',
        searchVersion: 0,
        isResetToToday: IS_RESET_TO_TODAY,
        windowAnchorDate: null,
        windowDays: 0,
    }),

    actions: {
        triggerSearch() {
            this.searchVersion += 1;
        },

        patch(patch: Partial<SchedulerFilterState>, trigger = true) {
            Object.assign(this, patch);
            if (trigger) this.triggerSearch();
        },

        setDataType(value: DataType, trigger = true) {
            if (this.dataType === value) return;
            const patch: Partial<SchedulerFilterState> = {dataType: value};
            const today = normalizePeriodDate(new Date(), this.viewMode);
            if (value === 'TREATMENT') {
                // 방문 장부는 미래 날짜 표기 불가 → 미래를 보던 중 진료로 전환 시 오늘로 클램프.
                // (과거~오늘을 보던 중이면 그대로 유지) viewMode 기준 정규화한 오늘과 비교.
                if (dayjs(this.periodDate).isAfter(today)) {
                    patch.periodDate = today;
                }
            } else {
                // 예약장부로 전환 시: 진료에서 보던 과거 날짜 잔류 방지 → 항상 오늘로 이동.
                patch.periodDate = today;
            }
            this.patch(patch, trigger);
        },

        setViewMode(value: ViewMode, trigger = true) {
            if (this.viewMode === value) return;

            const baseDate = this.isResetToToday
                ? new Date()
                : this.periodDate;
            const normalized = normalizePeriodDate(baseDate, value);
            this.patch({viewMode: value, periodDate: normalized}, trigger);
        },

        setMemberType(value: MemberType, trigger = true) {
            if (this.memberType === value) return;
            this.patch({memberType: value}, trigger);
        },

        // 진료 팀 선택 (SF-3a/b). 팀 = 표시 필터 오버레이(이름 통일 key, 데이터 KEY 아님).
        // 팀 id 도 저장마다 재발급(deactivate+insert)되어 불안정 → 팀명을 키로(저장 후 선택 유지).
        // 전환 시 의사선택 초기화(전원 표시) → doctors 변경 동반이라 재조회(trigger).
        // null = '미지정'(팀 미설정 담당자). 특정 팀명 = 그 팀 멤버 이름만 표시.
        setTeam(value: string | null, trigger = true) {
            if (this.selectedTeamName === value) return;
            this.patch({selectedTeamName: value, doctors: []}, trigger);
        },

        setTreatmentStateType(value: TreatmentStateType, trigger = false) {
            if (this.treatmentStateType === value) return;
            this.patch({treatmentStateType: value}, trigger);
        },

        setPeriodDate(date: Date, trigger = true) {
            const normalized = normalizePeriodDate(date, this.viewMode);
            this.patch({periodDate: normalized}, trigger);
        },

        movePeriod(step: number, trigger = true) {
            const days = this.viewMode === 'WEEK' ? 7 : 1;
            const next = dayjs(this.periodDate).add(step * days, 'day').toDate();
            this.setPeriodDate(next, trigger);
        },

        setDoctors(ids: Array<string | number>, trigger = true) {
            const norm = Array.from(new Set(ids.map(normalizeId).filter(Boolean)));
            this.patch({doctors: norm}, trigger);
        },

        setStatusKeys(keys: (AppointmentStatusType | TreatmentStatusType)[], trigger = true) {
            this.patch({status: keys}, trigger);
        },

        setKeyword(value: string, trigger = false) {
            this.patch({keyword: value}, trigger);
        },

        setResetToTodayOnViewModeChange(value: boolean) {
            this.isResetToToday = value;
        },

        // V3 데이터 조회 윈도우 설정 (forward N일). 표시(horizon)가 조회를 주도 — 그릴 컬럼만큼 조회.
        // load 직접호출 금지 → patch 의 searchVersion watch chain 으로 재조회. V2 는 호출 안 함.
        setWindow(anchorDate: Date | null, days: number, trigger = true) {
            const prevTime = this.windowAnchorDate?.getTime() ?? null;
            const nextTime = anchorDate?.getTime() ?? null;
            if (prevTime === nextTime && this.windowDays === days) return;
            this.patch({windowAnchorDate: anchorDate, windowDays: days}, trigger);
        }
    },
})
