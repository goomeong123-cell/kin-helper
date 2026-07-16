# 지식인 헬퍼 — 배포 / 업데이트 방법

GitHub 자동 업데이트로 배포합니다.
- 저장소: `goomeong123-cell/kin-helper` (Public)
- 릴리즈 페이지: https://github.com/goomeong123-cell/kin-helper/releases

---

## 새 버전 배포하기 (패치할 때마다)

1. **버전 올리기** — `package.json`의 `"version"` 을 올린다 (예: `0.2.0` → `0.2.1`).
   ※ 안 올리면 GitHub가 "이미 있는 릴리즈"라며 거부하고, VM도 업데이트로 인식 안 함.

2. **PowerShell 열기** — 탐색기에서 이 폴더 주소창에 `powershell` 입력 후 Enter
   (경로: `C:\Users\user\OneDrive\Desktop\클로드 yt 프로그램\kin-helper`)

3. **토큰 등록 + 배포** (창을 새로 열면 토큰을 매번 다시 등록해야 함):
   ```powershell
   $env:GH_TOKEN="ghp_여기에_토큰"
   npm.cmd run release
   ```
   - 토큰은 **큰따옴표 필수**.
   - 반드시 `npm.cmd` (그냥 `npm` 은 PowerShell 보안정책에 막힘).
   - 토큰은 GitHub → Settings → Developer settings → Tokens (classic), **`repo` 스코프** 체크한 것.

4. 로그 끝에 `100% ... to github` / `publishing` 이 보이면 성공.

---

## VM에 최초 설치 (VM당 1회)

1. VM 브라우저에서 접속: https://github.com/goomeong123-cell/kin-helper/releases/latest
2. `지식인헬퍼-Setup-x.x.x.exe` 다운로드 → 실행 (SmartScreen 뜨면 "추가 정보 → 실행")
3. 설치 후 실행. 이후부터는 앱 실행 시 **자동으로 새 버전 확인·다운로드·설치**.

---

## 자주 나온 오류와 해결

- `npm.ps1 파일을 로드할 수 없습니다` → `npm` 대신 **`npm.cmd`** 사용.
- `HttpError 401 / Bad credentials` → 토큰이 틀림/폐기됨. `repo` 스코프 classic 토큰 새로 발급.
- `HttpError 422 / Repository is empty` → 저장소에 파일이 하나도 없음. README 하나 커밋하면 해결.
- 자동 업데이트는 **패키징된 설치본에서만** 작동 (개발 모드 `npm run dev` 에서는 안 함).
