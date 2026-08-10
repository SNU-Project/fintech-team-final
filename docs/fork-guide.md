# 개인 계정으로 복제할 때 (포트폴리오용)

> 팀원 각자가 이 프로젝트를 자기 포트폴리오로 쓰려고 개인 GitHub에
> 복제할 때 필요한 것들. **원본은 지우지 말고 사본만 만드세요.**
> 공동 결과물이라 조직 리포는 그대로 두는 게 맞습니다.

---

## 왜 복제하나

조직 리포에 그대로 둬도 프로필에 **Pin** 할 수 있고 커밋 이력도 남습니다.
그래도 복제를 권하는 이유는 하나입니다 — **`SNU-Project` 조직은 수업용으로
만들어졌고, 과정이 끝나면 정리되거나 접근을 잃을 수 있습니다.**
몇 년 뒤 포트폴리오 링크가 죽으면 곤란하죠.

부수 효과로 **자동화가 더 편해집니다.** 개인 리포는 본인이 소유자라
조직 정책에 막히지 않습니다.

---

## ⚠️ 따라오지 않는 것 3가지

복제해도 **코드만** 옮겨집니다. 아래는 각자 새로 설정해야 합니다.

| | 지금 누구 것인가 | 복제 시 |
|---|---|---|
| **Vercel 프로젝트** | 안소민님 계정 | 본인 계정에 새로 생성 |
| **`GEMINI_API_KEY`** | 신기훈님 키 | 본인 키 발급 (기훈님은 재사용 가능) |
| **Actions 권한 설정** | 조직에서 열어 줌 | 본인 리포에서 직접 설정 |

데이터 자동 갱신 워크플로는 코드에 들어 있어서 **그냥 따라옵니다.**

---

## 절차

### 1. 리포 복제 (커밋 이력 그대로)

```bash
git clone --mirror https://github.com/SNU-Project/fintech-team-final.git
cd fintech-team-final.git
git push --mirror https://github.com/<본인아이디>/salarygap.git
```

미리 GitHub에서 빈 리포(`salarygap`)를 만들어 두세요. 팀원 전원의
커밋 이력이 그대로 넘어갑니다.

README 맨 위에 이런 한 줄을 넣어 두면 깔끔합니다:

```markdown
> SNU 핀테크 13기 3조 팀 프로젝트입니다.
> 원본: https://github.com/SNU-Project/fintech-team-final
```

### 2. Actions 권한 열기

`Settings → Actions → General → Workflow permissions`

- ⦿ **Read and write permissions**
- ☑ **Allow GitHub Actions to create and approve pull requests**

이걸 켜야 데이터 자동 갱신 봇이 PR을 만들고 머지합니다.
조직 리포에서는 소유자만 켤 수 있었지만 **개인 리포는 본인이 바로** 켭니다.

### 3. AI 해설을 쓸 거라면

**안 쓸 거면 이 단계는 건너뛰세요.** GitHub Pages만 켜도 사이트는
정상 동작하고, AI 해설 자리에는 검증된 기본 문구가 나옵니다.

**① Gemini 키 발급** (무료, 신용카드 불필요)

https://aistudio.google.com/apikey → `Create API key`

> Vercel AI Gateway는 무료 사용량이 있어도 카드 등록을 요구해서
> Google AI Studio로 옮겼습니다. 되돌리지 마세요.

**② Vercel 프로젝트 생성**

https://vercel.com → `Add New` → `Project` → 본인 리포 Import

**③ 환경변수 등록**

`Settings → Environment Variables`

- Key: `GEMINI_API_KEY`
- Value: 발급받은 키
- **Production / Preview / Development 전부 체크**

환경변수는 **다음 배포부터 적용**됩니다. 등록 후 `Deployments` 탭에서
최신 배포를 `Redeploy` 하세요.

### 4. 배포 확인

- **Vercel 쓰는 경우**: 자동 배포됨
- **Pages만 쓰는 경우**: `Settings → Pages → Source: main / (root)`

---

## 복제 후 점검

- [ ] 사이트가 열리고 차트가 그려지는가
- [ ] 상단 배지에 물가·환율·비트코인이 뜨는가 (실시간 API)
- [ ] Actions 탭에서 `Update market data` 를 수동 실행해 성공하는가
- [ ] (AI 해설 쓸 때) 해설이 나오는가

---

## 알아둘 것

**키는 비밀번호입니다.** 채팅·카톡·코드에 붙여넣지 말고 Vercel 입력칸에만
넣으세요. 실수로 노출했다면 발급처에서 **삭제하고 새로 만드세요.**
GitHub/Vercel에서 지우는 것만으로는 무효화되지 않습니다.

**스케줄이 멈출 수 있습니다.** GitHub은 활동이 없는 리포의 예약 작업을
60일 뒤 자동 비활성화합니다. 메일이 오면 Actions 탭에서 다시 켜면 됩니다.
포트폴리오로 보여주기 직전에 `Update market data`가 초록불인지 한 번
확인하세요.

**갱신이 멈춰도 사이트는 안 죽습니다.** 마지막으로 받아둔 데이터를 계속
보여주고, 화면에 수집 시각이 표시됩니다.

**작업 규칙은 [`CLAUDE.md`](../CLAUDE.md)에 있습니다.** 특히 "데이터를
지어내지 말 것"은 이 프로젝트의 존재 이유라 개인 사본에서도 지켜 주세요.
