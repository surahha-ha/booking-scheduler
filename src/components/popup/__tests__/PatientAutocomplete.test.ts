/**
 * @vitest-environment happy-dom
 *
 * PatientAutocomplete — 고객명 자동완성 입력칸(예약/방문 등록 팝업 · 장부 상단 최근 예약 검색).
 *
 * ★핵심 규약: 검색 발사(@search)는 IME 조합 상태와 무관하다.
 *   한글 첫 글자는 다음 글자를 칠 때까지 조합이 끝나지 않는다. compositionend 를 기다리면
 *   "한글은 2자부터, 영문은 1자부터" 뜨는 비대칭이 생긴다 — 그 회귀를 막는 것이 이 파일의 목적.
 *   중간 조합 상태(ㄱ, 기)의 요청은 사용처 debounce 가 흡수한다.
 */

import {describe, expect, it} from 'vitest';
import {mount} from '@vue/test-utils';
import PatientAutocomplete from '@/components/popup/PatientAutocomplete.vue';

function mountInput(props: Record<string, unknown> = {}) {
  return mount(PatientAutocomplete, {
    props: {modelValue: '', open: false, items: [], ...props},
  });
}

/** emit 된 search keyword 목록 */
function searched(wrapper: ReturnType<typeof mountInput>) {
  return (wrapper.emitted('search') ?? []).map((args) => (args as unknown[])[0]);
}

describe('PatientAutocomplete — 검색 발사 조건', () => {
  it('영문 1자에 검색한다', async () => {
    const w = mountInput();

    await w.find('input').setValue('k');

    expect(searched(w)).toEqual(['k']);
  });

  it('한글 조합 중 1자에도 검색한다 — compositionend 를 기다리지 않는다', async () => {
    const w = mountInput();
    const input = w.find('input');

    await input.trigger('compositionstart');
    await input.setValue('김');

    expect(searched(w)).toEqual(['김']);
  });

  it('조합이 확정되면 확정값으로 한 번 더 검색한다 — IME 가 input 을 생략하는 경우 보정', async () => {
    const w = mountInput();
    const input = w.find('input');

    await input.trigger('compositionstart');
    await input.setValue('김');
    await input.trigger('compositionend');

    expect(searched(w)).toEqual(['김', '김']);
  });

  it('값을 지우면 빈 keyword 를 emit 하고 드롭다운을 닫는다', async () => {
    const w = mountInput({modelValue: '김', open: true});

    await w.find('input').setValue('');

    expect(searched(w)).toEqual(['']);
    expect(w.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('pick 직후(isPicking) 에는 검색하지 않는다', async () => {
    const w = mountInput({isPicking: true});

    await w.find('input').setValue('김고객');

    expect(searched(w)).toEqual([]);
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['김고객']);
  });

  it('minSearchLength 를 올리면 그 길이 미만은 비움으로 처리한다', async () => {
    const w = mountInput({minSearchLength: 2});

    await w.find('input').setValue('김');

    expect(searched(w)).toEqual(['']);
  });
});
