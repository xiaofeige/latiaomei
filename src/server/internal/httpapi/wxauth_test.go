package httpapi_test

// 微信登录鉴权矩阵测试。
// 覆盖：首登定 owner、陌生人默认只读、owner 放行后可写、拉黑即时失效、
// 全局放开模式、以及审计是否真的记了 openid。
//
// 微信 jscode2session 用本地 httptest 桩替代，不依赖真实 AppID/Secret。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"latiaomei/internal/config"
	"latiaomei/internal/httpapi"
	"latiaomei/internal/stats"
	"latiaomei/internal/store"
)

// stubWx 假装自己是 api.weixin.qq.com：code 形如 "code:<openid>" 就换出对应 openid。
func stubWx(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/sns/jscode2session") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		code := r.URL.Query().Get("js_code")
		w.Header().Set("Content-Type", "text/plain")
		if !strings.HasPrefix(code, "code:") {
			// 模拟微信 40029：code 无效
			_, _ = io.WriteString(w, `{"errcode":40029,"errmsg":"invalid code"}`)
			return
		}
		openid := strings.TrimPrefix(code, "code:")
		_, _ = io.WriteString(w, `{"openid":"`+openid+`","session_key":"sk-test","unionid":"u-`+openid+`","errcode":0}`)
	}))
}

type harness struct {
	srv   *httptest.Server
	st    *store.Store
	cfg   *config.Config
	token string // 当前会话 token
}

func newHarness(t *testing.T, openAdmins bool) *harness {
	t.Helper()
	wx := stubWx(t)
	t.Cleanup(wx.Close)

	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "uploads"), 0o750)
	st, err := store.Open(filepath.Join(dir, "test.db"), time.UTC)
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	cfg := &config.Config{
		DataDir: dir, WebDir: dir, DBPath: filepath.Join(dir, "test.db"),
		Domain: "localhost", Loc: time.UTC, Location: "UTC",
		Secret:       "012345678901234567890123456789012345678901234567890123456789",
		WXAppID:      "wxTESTAPPID",
		WXAppSecret:  "test-secret",
		WXOpenAdmins: openAdmins, WXAPIBase: wx.URL,
	}
	col := stats.New(st, stats.Options{Location: time.UTC, Salt: cfg.Secret})
	srv := httptest.NewServer(httpapi.New(cfg, st, col).Handler())
	t.Cleanup(srv.Close)
	return &harness{srv: srv, st: st, cfg: cfg}
}

// call 发一次带 Bearer 的请求，返回状态码与解包后的 body。
func (h *harness) call(t *testing.T, method, path, body string) (int, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	if len(b) > 0 {
		_ = json.Unmarshal(b, &out)
	}
	return resp.StatusCode, out
}

// login 用微信 code 换 token，并把它设为当前会话。
func (h *harness) login(t *testing.T, openid string) (int, map[string]any) {
	t.Helper()
	h.token = ""
	code, body := h.call(t, http.MethodPost, "/api/admin/wx/login", `{"code":"code:`+openid+`","nickname":"测试`+openid+`"}`)
	if code == http.StatusOK {
		if tok, ok := body["data"].(map[string]any); ok {
			if s, ok := tok["token"].(string); ok {
				h.token = s
			}
		}
	}
	return code, body
}

func dataOf(body map[string]any) map[string]any {
	d, _ := body["data"].(map[string]any)
	return d
}

// ---- 用例 ----

func TestFirstLoginBecomesOwner(t *testing.T) {
	h := newHarness(t, false)
	_, body := h.login(t, "owner0001")
	if body["ok"] != true {
		t.Fatalf("首登应成功，实得 %v", body)
	}
	d := dataOf(body)
	if d["role"] != "owner" {
		t.Errorf("首位登录者 role 应为 owner，实得 %v", d["role"])
	}
	if d["can_write"] != true {
		t.Errorf("owner 必须可写")
	}
	if !strings.Contains(d["openid"].(string), "*") {
		t.Errorf("openid 应掩码下发，实得 %v", d["openid"])
	}
}

func TestStrangerIsReadOnly(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0002") // 先定主人

	code, body := h.login(t, "random001")
	if code != http.StatusOK {
		t.Fatalf("陌生人登录应成功（只读），实得 %d %v", code, body)
	}
	d := dataOf(body)
	if d["role"] != "pending" {
		t.Fatalf("陌生人应为 pending，实得 %v", d["role"])
	}
	if d["can_write"] != false {
		t.Fatalf("pending 不该有写权限")
	}

	// 读：放行
	if c, _ := h.call(t, http.MethodGet, "/api/admin/overview", ""); c != http.StatusOK {
		t.Errorf("pending 读 overview 应 200，实得 %d", c)
	}
	// 写：403
	c, body := h.call(t, http.MethodPost, "/api/admin/tastes", `{"id":0,"slug":"","name":"越权标签","kind":"taste","sort_no":0}`)
	if c != http.StatusForbidden {
		t.Errorf("pending 写操作应 403，实得 %d %v", c, body)
	}
	// 确认确实没写进去
	_, list := h.call(t, http.MethodGet, "/api/admin/tastes", "")
	if s, _ := json.Marshal(list); strings.Contains(string(s), "越权标签") {
		t.Errorf("pending 的写操作竟然落库了")
	}
}

func TestOwnerApprovesThenWriterWorks(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0003")
	h.login(t, "random003") // 得先出现过，owner 才能在名单里放行他

	// owner 放行 random003
	h.login(t, "owner0003")
	_, mbody := h.call(t, http.MethodPost, "/api/admin/wx/members",
		`{"openid":"random003","action":"approve"}`)
	if mbody["ok"] != true {
		t.Fatalf("owner 放行应成功，实得 %v", mbody)
	}

	// random003 重新登录后应可写
	h.login(t, "random003")
	if d := dataOf(mustMe(t, h)); d["role"] != "admin" || d["can_write"] != true {
		t.Fatalf("放行后应为 admin 且可写，实得 %v", d)
	}
	c, body := h.call(t, http.MethodPost, "/api/admin/tastes", `{"id":0,"slug":"","name":"放行后标签","kind":"taste","sort_no":0}`)
	if c != http.StatusOK {
		t.Fatalf("放行后写操作应 200，实得 %d %v", c, body)
	}
}

func TestOnlyOwnerCanManageMembers(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0004")
	h.login(t, "admin0004") // 先让他出现在名单里
	h.login(t, "owner0004")
	h.call(t, http.MethodPost, "/api/admin/wx/members", `{"openid":"admin0004","action":"approve"}`)

	// 普通 admin 想拉黑别人 → 403
	h.login(t, "admin0004")
	if d := dataOf(mustMe(t, h)); d["role"] != "admin" {
		t.Fatalf("前置条件不成立，admin0004 role=%v", d["role"])
	}
	c, _ := h.call(t, http.MethodPost, "/api/admin/wx/members", `{"openid":"owner0004","action":"ban"}`)
	if c != http.StatusForbidden {
		t.Errorf("非 owner 管成员应 403，实得 %d", c)
	}
}

func TestBanTakesEffectImmediately(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0005")
	h.login(t, "bad000005")
	h.login(t, "owner0005")
	h.call(t, http.MethodPost, "/api/admin/wx/members", `{"openid":"bad000005","action":"approve"}`)

	// 切回被放行者，确认现在能读
	h.login(t, "bad000005")
	if c, _ := h.call(t, http.MethodGet, "/api/admin/overview", ""); c != http.StatusOK {
		t.Fatalf("放行后应能读，实得 %d", c)
	}

	// owner 拉黑他（会顺带踢会话）
	h.login(t, "owner0005")
	if c, b := h.call(t, http.MethodPost, "/api/admin/wx/members", `{"openid":"bad000005","action":"ban"}`); c != http.StatusOK {
		t.Fatalf("拉黑失败 %d %v", c, b)
	}

	// 被拉黑者拿旧 token 应直接失效
	h.login(t, "bad000005") // login 会先清 token 再换，预期这一步就被 403 拒掉
	if c, _ := h.call(t, http.MethodGet, "/api/admin/overview", ""); c == http.StatusOK {
		t.Errorf("被拉黑后不应还能读")
	}
	// 而且登录接口要拒绝他重新拿 token
	c, b := h.login(t, "bad000005")
	if c != http.StatusForbidden {
		t.Errorf("被拉黑者登录应 403，实得 %d %v", c, b)
	}
}

func TestOpenAdminsModeAllowsEveryone(t *testing.T) {
	h := newHarness(t, true) // LATIAOMEI_WX_OPEN_ADMINS=1
	h.login(t, "owner0006")

	_, body := h.login(t, "random006")
	if d := dataOf(body); d["role"] != "admin" || d["can_write"] != true {
		t.Fatalf("放开模式下新人应直接可写，实得 %v", d)
	}
	if c, _ := h.call(t, http.MethodPost, "/api/admin/tastes", `{"id":0,"slug":"","name":"放开模式标签","kind":"taste","sort_no":0}`); c != http.StatusOK {
		t.Errorf("放开模式写操作应 200，实得 %d", c)
	}
}

func TestOwnerCannotBeDemoted(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0007")
	// owner 试图给自己降级 → 应被拒绝
	c, b := h.call(t, http.MethodPost, "/api/admin/wx/members", `{"openid":"owner0007","action":"demote"}`)
	if c == http.StatusOK {
		t.Errorf("owner 不该能被降级，实得 %v", b)
	}
}

func TestInvalidCodeRejected(t *testing.T) {
	h := newHarness(t, false)
	h.token = ""
	c, b := h.call(t, http.MethodPost, "/api/admin/wx/login", `{"code":"not-a-real-code"}`)
	if c != http.StatusUnauthorized {
		t.Errorf("假 code 应 401，实得 %d %v", c, b)
	}
	if !strings.Contains(b["error"].(string), "重新") {
		t.Errorf("应给出人话提示，实得 %v", b["error"])
	}
}

func TestNoTokenIsUnauthorized(t *testing.T) {
	h := newHarness(t, false)
	h.token = ""
	for _, p := range []string{"/api/admin/overview", "/api/admin/wx/me", "/api/admin/wx/members", "/api/admin/wx/audit"} {
		if c, _ := h.call(t, http.MethodGet, p, ""); c != http.StatusUnauthorized {
			t.Errorf("%s 无 token 应 401，实得 %d", p, c)
		}
	}
}

func TestAuditRecordsOpenID(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0008")
	// 一次真实写操作
	if c, b := h.call(t, http.MethodPost, "/api/admin/tastes", `{"id":0,"slug":"","name":"审计测试","kind":"taste","sort_no":0}`); c != http.StatusOK {
		t.Fatalf("写入失败 %d %v", c, b)
	}
	_, body := h.call(t, http.MethodGet, "/api/admin/wx/audit?size=50", "")
	items, _ := body["data"].(map[string]any)["items"].([]any)
	if len(items) == 0 {
		t.Fatalf("审计表为空，说明没记")
	}
	found := false
	for _, it := range items {
		m, _ := it.(map[string]any)
		if m["actor"] == "owner0008" && strings.Contains(m["action"].(string), "tastes") {
			found = true
		}
	}
	if !found {
		t.Errorf("审计里找不到 owner0008 的 tastes 写操作，实得 %v", items)
	}
}

func TestWebCookieLoginStillWorks(t *testing.T) {
	// 回归：加微信通道不能动网页端的账号密码 + CSRF 流程。
	h := newHarness(t, false)
	if _, err := h.st.EnsureAdmin("latiaomei", "Passw0rd!"); err != nil {
		t.Fatal(err)
	}
	// 用裸 http client（手工回传 cookie）走一遍
	resp, err := http.Post(h.srv.URL+"/api/admin/login", "application/json",
		strings.NewReader(`{"username":"latiaomei","password":"Passw0rd!"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if out["ok"] != true {
		t.Fatalf("网页登录失败 %v", out)
	}
	csrf, _ := dataOf(out)["csrf"].(string)
	d := dataOf(out)
	if _, hasToken := d["token"]; hasToken {
		t.Errorf("网页登录不该回 token（未带 want_token）")
	}

	// 不带 CSRF 头的写操作必须 403
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/admin/tastes",
		strings.NewReader(`{"id":0,"slug":"","name":"缺CSRF","kind":"taste","sort_no":0}`))
	req.Header.Set("Content-Type", "application/json")
	for _, c := range resp.Cookies() {
		req.AddCookie(c)
	}
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	if r2.StatusCode != http.StatusForbidden {
		t.Errorf("缺 CSRF 应 403，实得 %d", r2.StatusCode)
	}

	// 带正确 CSRF 头则通过
	req3, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/admin/tastes",
		strings.NewReader(`{"id":0,"slug":"","name":"带CSRF","kind":"taste","sort_no":0}`))
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("X-CSRF-Token", csrf)
	for _, c := range resp.Cookies() {
		req3.AddCookie(c)
	}
	r3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	defer r3.Body.Close()
	if r3.StatusCode != http.StatusOK {
		t.Errorf("带正确 CSRF 应 200，实得 %d", r3.StatusCode)
	}
}

func mustMe(t *testing.T, h *harness) map[string]any {
	t.Helper()
	c, b := h.call(t, http.MethodGet, "/api/admin/wx/me", "")
	if c != http.StatusOK {
		t.Fatalf("me 应 200，实得 %d %v", c, b)
	}
	return b
}

func TestPendingCannotSeeMembersOrAudit(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0009")
	h.login(t, "peek0009") // pending

	for _, p := range []string{"/api/admin/wx/members", "/api/admin/wx/audit"} {
		if c, _ := h.call(t, http.MethodGet, p, ""); c != http.StatusForbidden {
			t.Errorf("pending 访问 %s 应 403，实得 %d", p, c)
		}
	}
}

// 名单里必须给出可直接操作的完整 openid，否则 owner 点"放行"会打空炮。
func TestMembersListOpenIDIsActionable(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner0010")
	h.login(t, "newcomer10")
	h.login(t, "owner0010")

	_, body := h.call(t, http.MethodGet, "/api/admin/wx/members", "")
	items, _ := body["data"].(map[string]any)["items"].([]any)
	var target string
	for _, it := range items {
		m, _ := it.(map[string]any)
		if m["role"] == "pending" {
			target, _ = m["openid"].(string)
		}
	}
	if target == "" {
		t.Fatal("名单里没找到 pending 成员，用例前提不成立")
	}
	if strings.Contains(target, "*") {
		t.Fatalf("名单下发的是掩码 openid，客户端无法据此操作：%s", target)
	}
	if c, b := h.call(t, http.MethodPost, "/api/admin/wx/members",
		`{"openid":"`+target+`","action":"approve"}`); c != http.StatusOK {
		t.Fatalf("用名单里的 openid 放行失败 %d %v", c, b)
	}
	// 放行后本人重登应可写
	h.login(t, "newcomer10")
	if c, _ := h.call(t, http.MethodPost, "/api/admin/tastes",
		`{"id":0,"slug":"","name":"闭环标签","kind":"taste","sort_no":0}`); c != http.StatusOK {
		t.Errorf("闭环失败：放行后仍不能写，实得 %d", c)
	}
}
