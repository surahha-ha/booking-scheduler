// ============================================================================
// 서비스 용어 사전
// ----------------------------------------------------------------------------
// 화면에 노출되는 도메인 용어의 단일 출처. 실제 값은 `src/messages/ko.json` 의
// `terms` 섹션이 소유하고, 여기서는 상수로 꺼내 쓸 수 있게 노출만 한다.
//
// 업종을 바꾸려면 ko.json 의 terms 만 고치면 된다.
//   기본   staff=담당자   service=서비스 항목  customer=고객   visit=방문
//   미용실 staff=디자이너 service=시술        customer=고객   visit=방문
//   학원   staff=강사     service=수업        customer=수강생 visit=수강
//   정비소 staff=정비사   service=정비 항목    customer=차주   visit=입고
//
// (템플릿 안에서는 vue-i18n 의 `$t('terms.staff')` 도 동일한 값을 준다.)
// ============================================================================
import ko from '@/messages/ko.json';

export const TERMS = ko.terms;
