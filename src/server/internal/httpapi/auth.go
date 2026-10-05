package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"latiaomei/internal/store"
)

const (
	sessionCookie = "latiaomei_sid"
	csrfCookie    = "latiaomei_csrf"
)

// bearerPrefix 是小程序后台通道使用的 Authorization 方案名。
const bearerPrefix = "Bearer "

// sessionTokenFrom 取出本次请求的会话 token：优先 Authorization: Bearer，
// 其次网页用的 Cookie。返回 (token, 是否为 Bearer 通道)。
// 小程序发不了 Cookie，只能靠 Bearer 头把 token 带上。
func sessionTokenFrom(r *http.Request) (string, bool) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, bearerPrefix) {
		if t := strings.TrimSpace(h[len(bearerPrefix):]); t != "" {
			return t, true
		}
	}
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		return c.Value, false
	}
	return "", false
}

// auth 校验会话，失败一律 401（不区分"没登录"和"过期"，前端好处理）。
// token 可能来自两类入口，依次尝试：
//  1. 网页后台的 Cookie 会话（sessions 表）
//  2. 小程序的微信身份会话（wx_sessions 表）
//
// 微信侧 pending 角色只允许只读，写操作直接 403。
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, bearer := sessionTokenFrom(r)
		if token == "" {
			s.jsonErr(w, http.StatusUnauthorized, "请先登录")
			return
		}

		// 先试网页会话：命中就走原来的账号密码逻辑。
		a, exp, err := s.st.SessionAdmin(token, s.sessionTTL)
		if err == nil {
			next(w, r.WithContext(withActor(r.Context(),
				&Actor{Kind: "web", Name: a.Username, Role: "admin"}, exp, bearer)))
			return
		}
		if !errors.Is(err, store.ErrNotFound) {
			log500(s, w, err, "会话校验")
			return
		}

		// 网页会话没有，再试微信会话。
		wx, wexp, werr := s.st.WxSessionAdmin(token, s.wxSessionTTL())
		if werr == nil {
			act := &Actor{Kind: "wx", Name: wx.OpenID, Role: wx.Role, OpenID: wx.OpenID}
			if !act.CanWrite() && !isSafeMethod(r.Method) {
				s.jsonErr(w, http.StatusForbidden, s.pendingMessage())
				return
			}
			next(w, r.WithContext(withActor(r.Context(), act, wexp, bearer)))
			return
		}
		if !errors.Is(werr, store.ErrNotFound) {
			log500(s, w, werr, "微信会话校验")
			return
		}

		clearCookie(w, sessionCookie)
		s.jsonErr(w, http.StatusUnauthorized, "登录已过期，请重新登录")
	}
}

// pendingMessage 给只读身份的提示语，说清为什么不给写。
func (s *Server) pendingMessage() string {
	return "你的微信身份还在待审核，目前只能查看；请让管理员在小程序「成员管理」里放行后再修改内容"
}

// wxSessionTTL 小程序会话寿命。微信登录是无感的，给长一点免得频繁重新换 token。
func (s *Server) wxSessionTTL() time.Duration { return 30 * 24 * time.Hour }

// csrf 对所有写操作做两件事：校验请求来源合法性，以及统一留审计。
//
// Cookie 通道（网页后台）要求双提交令牌：Cookie 里的值必须等于 X-CSRF-Token 头，
// 配合 SameSite=Lax 能挡住跨站表单伪造。
// Bearer 通道（小程序）的 token 由我们代码显式放进头里，第三方站点既读不到也发不出
// 这个头，天然免疫 CSRF，所以跳过令牌校验，但审计照记。
func (s *Server) csrf(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !bearerFrom(r.Context()) {
			c, err := r.Cookie(csrfCookie)
			if err != nil || c.Value == "" {
				s.jsonErr(w, http.StatusForbidden, "缺少 CSRF 令牌，请刷新页面重试")
				return
			}
			got := r.Header.Get("X-CSRF-Token")
			sumWant := sha256.Sum256([]byte(c.Value))
			sumGot := sha256.Sum256([]byte(got))
			if subtle.ConstantTimeCompare(sumWant[:], sumGot[:]) != 1 {
				s.jsonErr(w, http.StatusForbidden, "CSRF 校验未通过")
				return
			}
		}
		// 所有后台写接口都经过 csrf，在这里统一留痕：比逐个 handler 埋点不会漏，
		// 也只在真的写成功（状态码 <400）时才记，避免失败重试把审计冲脏。
		rw := &auditWriter{ResponseWriter: w, code: http.StatusOK}
		next(rw, r)
		if rw.code < http.StatusBadRequest {
			s.auditAs(r, auditAction(r.Method, r.URL.Path), auditTarget(r.URL.Path))
		}
	}
}

// auditWriter 只为了捕获最终状态码，其余全透传。
type auditWriter struct {
	http.ResponseWriter
	code int
}

func (w *auditWriter) WriteHeader(c int) {
	if w.code == 0 {
		w.code = c
	}
	w.ResponseWriter.WriteHeader(c)
}

func (w *auditWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// auditAction 把 "PUT /api/admin/reviews/12" 压成 "PUT reviews"。
func auditAction(method, path string) string {
	segs := strings.Split(strings.Trim(path, "/"), "/") // [api admin reviews 12]
	// 去掉接口前缀，只留业务段。
	for len(segs) > 0 && (segs[0] == "api" || segs[0] == "admin") {
		segs = segs[1:]
	}
	// 丢掉纯数字段（id 在路径里属于 target，不是动作名）。
	kept := make([]string, 0, len(segs))
	for _, sg := range segs {
		if _, err := strconv.ParseInt(sg, 10, 64); err == nil {
			continue
		}
		kept = append(kept, sg)
	}
	return method + " " + strings.Join(kept, "/")
}

// auditTarget 取路径里最后那个非接口名的段（id 或 slug），没有就留空。
func auditTarget(path string) string {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	if len(segs) == 0 {
		return ""
	}
	return segs[len(segs)-1]
}

func (s *Server) hLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username  string `json:"username"`
		Password  string `json:"password"`
		WantToken bool   `json:"want_token"`
	}
	if err := decode(r, &body); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	ip := clientIP(r)
	if blocked := s.loginBlocked(ip); blocked {
		s.jsonErr(w, http.StatusTooManyRequests, "失败次数过多，请 15 分钟后再试")
		return
	}
	a, err := s.st.CheckLogin(strings.TrimSpace(body.Username), body.Password, ip)
	if err != nil {
		if errors.Is(err, store.ErrBadCredentials) {
			s.recordLoginFail(ip)
			// 不暴露是账号还是密码错了
			s.jsonErr(w, http.StatusUnauthorized, "账号或密码不正确")
			return
		}
		log500(s, w, err, "登录")
		return
	}
	token, exp, err := s.st.CreateSession(a.ID, ip, s.sessionTTL)
	if err != nil {
		log500(s, w, err, "建会话")
		return
	}
	csrfTok := randToken()
	setCookie(w, sessionCookie, token, exp, true)
	setCookie(w, csrfCookie, csrfTok, exp, false) // 需要 JS 读，故意不开 HttpOnly
	s.st.LoginFailClear(ip)
	out := map[string]any{"username": a.Username, "csrf": csrfTok, "expires_at": exp.Unix()}
	// 小程序等无法保存 Cookie 的客户端：显式请求 want_token 时，把会话 token 直接回给它，
	// 之后每次请求用 Authorization: Bearer 带上。只有密码校验通过后才会走到这里。
	if body.WantToken {
		out["token"] = token
	}
	s.jsonOK(w, out)
}

func (s *Server) hLogout(w http.ResponseWriter, r *http.Request) {
	if token, _ := sessionTokenFrom(r); token != "" {
		_ = s.st.DropSession(token)
	}
	clearCookie(w, sessionCookie)
	clearCookie(w, csrfCookie)
	s.jsonOK(w, map[string]any{"bye": true})
}

// hSession 让前端确认"我还登录着吗"，并取回 CSRF 令牌。
// 小程序等 Bearer 客户端没有 Cookie，改从 Authorization 头取 token 校验。
func (s *Server) hSession(w http.ResponseWriter, r *http.Request) {
	token, bearer := sessionTokenFrom(r)
	if token == "" {
		s.jsonErr(w, http.StatusUnauthorized, "未登录")
		return
	}
	a, exp, err := s.st.SessionAdmin(token, s.sessionTTL)
	if err != nil {
		s.jsonErr(w, http.StatusUnauthorized, "登录已过期")
		return
	}
	csrf := ""
	if cc, err := r.Cookie(csrfCookie); err == nil {
		csrf = cc.Value
	}
	s.jsonOK(w, map[string]any{
		"username":   a.Username,
		"csrf":       csrf,
		"bearer":     bearer,
		"expires_at": exp.Unix(),
		"last_login": map[string]any{"at": a.LastLoginAt, "ip": a.LastLoginIP},
	})
}

// loginLimit 是内存里的滑动窗口，跟库里的 login_attempts 配合：
// 内存挡住瞬时爆破，库里那行用于重启后仍能看见近期失败次数。
type failWindow struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

var loginFails = &failWindow{hits: map[string][]time.Time{}}

func (f *failWindow) add(ip string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.hits) > 4096 { // 防被拿登录接口刷内存
		f.hits = map[string][]time.Time{}
	}
	f.hits[ip] = append(f.hits[ip], time.Now())
}

func (f *failWindow) blocked(ip string, max int, window time.Duration) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := f.hits[ip]
	keep := list[:0]
	for _, t := range list {
		if time.Since(t) <= window {
			keep = append(keep, t)
		}
	}
	f.hits[ip] = keep
	return len(keep) >= max
}

func (f *failWindow) clear(ip string) {
	f.mu.Lock()
	delete(f.hits, ip)
	f.mu.Unlock()
}

func (s *Server) loginBlocked(ip string) bool {
	if loginFails.blocked(ip, 8, 15*time.Minute) {
		return true
	}
	// 库里的累计值超过阈值也拦，避免重启后窗口被清零。
	if n, err := s.st.LoginFailCount(ip); err == nil && n >= 30 {
		return true
	}
	return false
}

func (s *Server) recordLoginFail(ip string) {
	loginFails.add(ip)
	_, _ = s.st.LoginFail(ip)
}

func setCookie(w http.ResponseWriter, name, value string, exp time.Time, httpOnly bool) {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: httpOnly,
		SameSite: http.SameSiteLaxMode,
		Secure:   cookieSecure,
	}
	http.SetCookie(w, c)
}

// cookieSecure 由 config 注入：生产走 https 必须为 true（见 main.go）。
var cookieSecure = true

func clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(0, 0),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: cookieSecure,
	})
}

func randToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "csrf-fallback"
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func log500(s *Server, w http.ResponseWriter, err error, where string) {
	log.Printf("http: %s 失败: %v", where, err)
	_ = s
	s.jsonErr(w, http.StatusInternalServerError, "服务端异常")
}
