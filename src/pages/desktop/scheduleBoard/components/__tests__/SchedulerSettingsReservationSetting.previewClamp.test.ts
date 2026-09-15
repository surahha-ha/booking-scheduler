/**
 * @vitest-environment happy-dom
 *
 * 예약장부 설정 — 미리보기 카드 말줄임 / 전체 칸 개수 범위 (화면정의서 OSP_MD_APB034).
 *
 * §5 "공간이 부족한 경우 .. 표시" 가 미리보기에만 빠져 있었다. 실제 보드 카드
 * (AppointmentCard .card-info-block)는 -webkit-line-clamp 으로 말줄임을 내는데,
 * 미리보기는 overflow:hidden 하드 클립뿐이라 글자가 그냥 잘렸다. 카드 높이 단계가
 * 줄 수로 실제 주입되는지 고정한다 — 값은 CSS 변수 --preview-info-lines 로 넘어간다
 * (-webkit-line-clamp 을 인라인으로 주면 테스트 DOM 이 미지원 프로퍼티라 버린다).
 *
 * §3 "전체 칸 개수 6~10" 은 store 가 단일 소스다. 종전엔 store 가 1~20 으로 열려 있어
 * 정의서 범위가 보드 경로에는 걸리지 않았다.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {flushPromises, mount} from '@vue/test-utils';
import {createPinia, setActivePinia} from 'pinia';

vi.mock('notivue', () => ({
    push: {success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn()},
}));

const mocks = vi.hoisted(() => ({
    getReservationSettings: vi.fn(),
    saveReservationSettings: vi.fn(),
}));
vi.mock('@/api/reservationSettingsApi', () => ({
    getReservationSettings: mocks.getReservationSettings,
    saveReservationSettings: mocks.saveReservationSettings,
}));

import SchedulerSettingsReservationSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsReservationSetting.vue';
import {MAX_COLUMNS, MIN_COLUMNS} from '@/stores/reservationSettingStore';

function resp(payload: Record<string, unknown>) {
    return {data: {code: 'succeed', payload}};
}

const BASE = {
    slotUnitMinutes: 30,
    totalColumnCount: 8,
    displayInfo       : ['NAME', 'AGE', 'GENDER', 'TREATMENT'],
    cardHeightLevel: 3,
};

async function mountWith(payload: Record<string, unknown>) {
    mocks.getReservationSettings.mockResolvedValue(resp(payload));
    const wrapper = mount(SchedulerSettingsReservationSetting);
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
});

describe('미리보기 카드 — 카드 높이 단계만큼만 노출하고 넘치면 말줄임(§5·§6-1)', () => {
    it('meta 블록의 -webkit-line-clamp 이 카드 높이 단계와 같다', async () => {
        const wrapper = await mountWith({...BASE, cardHeightLevel: 2});

        const meta = wrapper.find('.schedulerReservationSetting__appointmentMeta');
        expect(meta.exists()).toBe(true);
        expect(meta.attributes('style')).toContain('--preview-info-lines: 2');
    });

    it('단계가 5면 clamp 도 5로 따라간다 — 한 줄 고정이 아니다', async () => {
        const wrapper = await mountWith({...BASE, cardHeightLevel: 5});

        const meta = wrapper.find('.schedulerReservationSetting__appointmentMeta');
        expect(meta.attributes('style')).toContain('--preview-info-lines: 5');
    });
});

describe('전체 칸 개수 — 화면정의서 §3 범위 6~10', () => {
    it('store 상수가 정의서 범위다', () => {
        expect([MIN_COLUMNS, MAX_COLUMNS]).toEqual([6, 10]);
    });

    it('범위를 벗어난 서버값은 하한으로 clamp 되어 표시된다', async () => {
        const wrapper = await mountWith({...BASE, totalColumnCount: 1});

        const input = wrapper.find('.schedulerReservationSetting__numberInput');
        expect((input.element as HTMLInputElement).value).toBe(String(MIN_COLUMNS));
    });

    it('범위를 벗어난 서버값은 상한으로도 clamp 된다', async () => {
        const wrapper = await mountWith({...BASE, totalColumnCount: 20});

        const input = wrapper.find('.schedulerReservationSetting__numberInput');
        expect((input.element as HTMLInputElement).value).toBe(String(MAX_COLUMNS));
    });
});

/* §3 "우측 화살표로만 설정 가능" — 직접 입력을 다시 열면 이 묶음이 깨진다. */
describe('전체 칸 개수 — 화살표 전용(§3)', () => {
    it('입력칸은 readonly 이고, 타이핑해도 칸 개수가 따라 바뀌지 않는다', async () => {
        const wrapper = await mountWith(BASE);
        const input = wrapper.find('.schedulerReservationSetting__numberInput');
        const el = input.element as HTMLInputElement;
        // 실제로 반영됐는지는 미리보기 열 머리 개수로 본다 — input.value 는 사용자가 덮어쓴 값이라 증거가 못 된다.
        const headCount = () => wrapper.findAll('.schedulerReservationSetting__colHeaderCell').length;

        expect(el.readOnly).toBe(true);
        expect(headCount()).toBe(BASE.totalColumnCount);

        el.value = String(MAX_COLUMNS);
        await input.trigger('input');
        await flushPromises();

        expect(headCount()).toBe(BASE.totalColumnCount);
    });

    it('−/+ 버튼으로는 1씩 바뀌고 범위 끝에서 비활성이 된다', async () => {
        const wrapper = await mountWith({...BASE, totalColumnCount: MAX_COLUMNS - 1});
        const value = () =>
            (wrapper.find('.schedulerReservationSetting__numberInput').element as HTMLInputElement).value;
        const increase = wrapper.find('.schedulerReservationSetting__number-input-button--increase');
        const decrease = wrapper.find('.schedulerReservationSetting__number-input-button--decrease');

        await increase.trigger('click');
        expect(value()).toBe(String(MAX_COLUMNS));
        expect(increase.attributes('disabled')).toBeDefined();

        for (let i = MAX_COLUMNS; i > MIN_COLUMNS; i--) await decrease.trigger('click');
        expect(value()).toBe(String(MIN_COLUMNS));
        expect(decrease.attributes('disabled')).toBeDefined();
    });
});
