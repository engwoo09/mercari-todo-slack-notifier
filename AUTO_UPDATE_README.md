# Auto Update With GitHub

목표:

- 맥에서 코드 수정
- GitHub에 업로드
- 일본 Windows Chrome의 Tampermonkey가 자동 업데이트

## 왜 이 방식이 좋은가

- 복사/붙여넣기 불필요
- 현재 로그인된 Chrome 안에서 그대로 동작
- 사용자 스크립트는 Tampermonkey가 업데이트를 체크함

## 전체 흐름

1. GitHub 저장소 1개 생성
2. 이 폴더 파일을 저장소에 업로드
3. `userscript_release_config.json`에 Raw URL 입력
4. 맥에서 `build_userscript_release.py` 실행
5. 생성된 `dist/mercari_todo_reply_slack.user.js`를 GitHub에 업로드
6. Windows에서 처음 한 번만 그 Raw URL로 스크립트 설치
7. 이후부터는 Tampermonkey가 자동 업데이트

## 1. 설정 파일 만들기

`userscript_release_config.example.json`을 복사해서 `userscript_release_config.json`으로 바꿉니다.

예시:

```json
{
  "raw_userscript_url": "https://raw.githubusercontent.com/YOUR_GITHUB_ID/YOUR_REPO/main/dist/mercari_todo_reply_slack.user.js"
}
```

## 2. 맥에서 릴리스 파일 생성

```bash
python3 build_userscript_release.py
```

생성 결과:

- `dist/mercari_todo_reply_slack.user.js`

이 파일은 `@updateURL`, `@downloadURL`이 실제 GitHub Raw 주소로 들어간 버전입니다.

## 3. Windows에서 첫 설치

Tampermonkey가 설치된 Chrome에서 아래 URL을 엽니다.

`https://raw.githubusercontent.com/YOUR_GITHUB_ID/YOUR_REPO/main/dist/mercari_todo_reply_slack.user.js`

그러면 Tampermonkey 설치 화면이 열립니다.

설치 후에는:

- Slack Webhook 설정
- Keyword 설정
- Run Scan Now

만 하면 됩니다.

## 4. 이후 업데이트

맥에서 코드 수정 후:

1. `python3 build_userscript_release.py`
2. `dist/mercari_todo_reply_slack.user.js`를 GitHub에 push

그다음 Windows 쪽은 보통 Tampermonkey가 자동 업데이트를 감지합니다.

## 추천

현재 단계에서는 GitHub Actions까지는 필요 없습니다.

가장 단순한 운영:

1. 맥에서 수정
2. 릴리스 파일 생성
3. GitHub push
4. Windows는 자동 업데이트

이 흐름이 가장 적은 작업으로 유지됩니다.
