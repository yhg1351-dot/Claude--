// 앱 설정 파일. Supabase 값을 비워 두면 "데모 모드"로 동작합니다.
// 데모 모드: 제출 내용이 이 기기(브라우저) 안에만 저장됩니다. 흐름 테스트용.
window.APP_CONFIG = {
  // Supabase 프로젝트 설정 > API 에서 복사 (예: "https://abcd1234.supabase.co")
  supabaseUrl: "https://cjkfuvhwamuzbihsrypk.supabase.co",
  // Supabase 프로젝트 설정 > API > anon public 키
  supabaseAnonKey: "sb_publishable_vfFMj9c_cMrRpTLyWCdj5w_oah-H-Aj",

  // 모둠 코드 접속 잠금: 마지막 신호 후 이 시간(분)이 지나면 다른 기기가 접속할 수 있음
  lockTimeoutMinutes: 5,
  // 접속 유지 신호 주기(초)
  heartbeatSeconds: 60,

  // 사진 압축 설정 (긴 변 픽셀, JPEG 품질, 목표 최대 용량)
  photo: { maxSide: 2000, quality: 0.85, maxBytes: 600 * 1024 },

  // 교사 로그인용 이메일. 여기에 넣어 두면 교사 화면에서 "교사 코드"(그 계정의 비밀번호)만 입력하면 됩니다.
  // 비워 두면 이메일과 비밀번호를 모두 입력하는 화면이 나옵니다.
  teacherEmail: "yhg1351@gmail.com",

  // 데모 모드에서 교사 화면 비밀번호 (Supabase 연결 후에는 사용되지 않음)
  localTeacherPassword: "1234",

  // 이 시각(ISO) 이전에 만들어진 '전송 대기' 항목은 앱이 켜질 때 보내지 않고 지웁니다. 평소에는 null 로 둡니다.
  // 테스트 중 막힌 항목을 정리할 때만 잠시 현재 시각을 넣고, 정리된 뒤 다시 null 로 되돌리세요. 여행 중에는 절대 넣지 마세요(학생 제출이 지워짐).
  // 폰 시계가 틀리면 엉뚱한 항목이 지워질 수 있으니 이 방법은 마지막 수단으로만 씁니다.
  purgeOutboxBefore: null,

  // 데이터 파일(data/missions.json) 요청에 붙는 번호. 앱 파일의 캐시 버전은 sw.js 의 VERSION 이 관리합니다.
  version: "1"
};
