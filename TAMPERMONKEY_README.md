# Tampermonkey Setup

이 방식은 `현재 로그인된 Chrome` 안에서 바로 실행됩니다.

장점:

- 메루카리 로그인 세션을 따로 복사하지 않음
- Playwright/CDP 연결 문제를 피할 수 있음
- 할일목록 페이지 안에서 바로 감지 가능

## 준비

### 1. Tampermonkey 설치

Chrome 웹 스토어에서 `Tampermonkey` 확장을 설치합니다.

### 2. 사용자 스크립트 추가

파일:

- `mercari_todo_reply_slack.user.js`

설치 방법:

1. Tampermonkey 대시보드 열기
2. `새 스크립트 만들기`
3. 기존 내용 모두 삭제
4. `mercari_todo_reply_slack.user.js` 파일 내용 전체 붙여넣기
5. 저장

## 초기 설정

Tampermonkey 메뉴에서 아래 항목을 사용합니다.

- `Set Slack Webhook URL`
- `Set Keyword`
- `Send Slack Test Message`
- `Run Scan Now`

### 권장 순서

1. `Set Slack Webhook URL`
2. 실제 Slack webhook 입력
3. `Set Keyword`
4. `返信をお願いします` 입력
5. `Send Slack Test Message`
6. Slack 채널 도착 확인

## 실제 테스트

1. Chrome에서 메루카리에 로그인된 상태 유지
2. `https://jp.mercari.com/todos` 또는 사이트 안의 `やることリスト`로 이동
3. Tampermonkey 메뉴에서 `Run Scan Now`
4. Slack 메시지 도착 확인

## 동작 방식

- 30초마다 한 번씩 스캔
- `やることリスト` 페이지에서만 동작
- `もっと見る` 버튼이 있으면 자동 클릭
- `返信をお願いします` 문구가 포함된 항목만 감지
- 이미 보낸 항목은 Tampermonkey 저장소에 기억해서 중복 전송 방지

## 주의

- Slack webhook은 브라우저 안에 저장됩니다.
- 같은 브라우저 프로필에서만 설정값이 유지됩니다.
- 메루카리 DOM이 바뀌면 스크립트 수정이 필요할 수 있습니다.
