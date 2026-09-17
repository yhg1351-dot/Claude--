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
  photo: { maxSide: 1280, quality: 0.8, maxBytes: 250 * 1024 },

  // 교사 로그인용 이메일. 여기에 넣어 두면 교사 화면에서 "교사 코드"(그 계정의 비밀번호)만 입력하면 됩니다.
  // 비워 두면 이메일과 비밀번호를 모두 입력하는 화면이 나옵니다.
  teacherEmail: "yhg1351@gmail.com",

  // 데모 모드에서 교사 화면 비밀번호 (Supabase 연결 후에는 사용되지 않음)
  localTeacherPassword: "1234",

  // 캐시 버전. 앱 파일을 크게 바꿨을 때 숫자를 올리면 학생 폰의 캐시가 갱신됩니다.
  version: "1"
};
