package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// 微信小程序登录：端上用 wx.login() 拿 code，服务端拿 code 换 openid。
// AppSecret 只在服务端参与请求，绝不下发给端上；openid 是"谁在操作"的唯一凭据。

// wxSession 是 jscode2session 的响应。出错时微信也回 200，靠 errcode 判断。
type wxSession struct {
	OpenID     string `json:"openid"`
	SessionKey string `json:"session_key"`
	UnionID    string `json:"unionid"`
	ErrCode    int    `json:"errcode"`
	ErrMsg     string `json:"errmsg"`
}

// wxClient 独立的 http client：微信接口偶尔会慢，6s 比全站默认的 15s 更合适，
// 免得登录按钮一直转圈。
var wxClient = &http.Client{Timeout: 6 * time.Second}

// code2Session 用 code 换 openid。
func (s *Server) code2Session(code string) (*wxSession, error) {
	if s.cfg.WXAppID == "" || s.cfg.WXAppSecret == "" {
		return nil, errors.New("服务端未配置微信 AppID/AppSecret，微信登录不可用")
	}
	q := url.Values{
		"appid":      {s.cfg.WXAppID},
		"secret":     {s.cfg.WXAppSecret},
		"js_code":    {code},
		"grant_type": {"authorization_code"},
	}
	u := strings.TrimRight(s.cfg.WXAPIBase, "/") + "/sns/jscode2session?" + q.Encode()

	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := wxClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求微信接口失败: %w", err)
	}
	defer resp.Body.Close()

	// 微信这个接口返回 text/plain，且体积很小，读满 4KB 足够。
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if err != nil {
		return nil, fmt.Errorf("读微信接口响应失败: %w", err)
	}
	var out wxSession
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("解析微信接口响应失败: %w", err)
	}
	if out.ErrCode != 0 {
		// 40029 code 无效/已用过；45011 频率限制；40226 小程序被限制。
		return nil, &wxError{code: out.ErrCode, msg: out.ErrMsg}
	}
	if out.OpenID == "" {
		return nil, errors.New("微信没有返回 openid")
	}
	return &out, nil
}

// wxError 带微信侧错误码，便于给用户更准确的提示。
type wxError struct {
	code int
	msg  string
}

func (e *wxError) Error() string { return fmt.Sprintf("微信接口错误 %d: %s", e.code, e.msg) }

// wxHint 把常见错误码翻译成人话。
func (e *wxError) hint() string {
	switch e.code {
	case 40029:
		return "登录凭证已失效，请重新打开小程序"
	case 45011:
		return "操作太频繁，稍等几秒再试"
	case 40226:
		return "该小程序被限制登录，请联系管理员"
	case 40013:
		return "AppID 配置不正确"
	case 40125, 40001:
		return "AppSecret 配置不正确"
	case -1:
		return "微信服务繁忙，请重试"
	}
	return "微信登录失败，请重试"
}

// hWxLogin 小程序静默登录：code → openid → 建会话 → 回 token。
// 这个接口本身不带凭证，所以挂在 auth 之外，并单独做限频。
func (s *Server) hWxLogin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Code     string `json:"code"`
		Nickname string `json:"nickname"`
		Avatar   string `json:"avatar"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	b.Code = strings.TrimSpace(b.Code)
	if b.Code == "" {
		s.jsonErr(w, http.StatusBadRequest, "缺少 code")
		return
	}
	ip := clientIP(r)
	if wxLoginLimit.allow(ip) == false {
		s.jsonErr(w, http.StatusTooManyRequests, "登录过于频繁，请稍后再试")
		return
	}

	wxs, err := s.code2Session(b.Code)
	if err != nil {
		var we *wxError
		if errors.As(err, &we) {
			log.Printf("wx: jscode2session 失败 ip=%s code=%d msg=%s", ip, we.code, we.msg)
			s.jsonErr(w, http.StatusUnauthorized, we.hint())
			return
		}
		log.Printf("wx: %v ip=%s", err, ip)
		s.jsonErr(w, http.StatusBadGateway, "登录服务暂不可用，请稍后重试")
		return
	}

	// 昵称/头像是端上可选传来的（新版微信已不自动给），有就记，没有留空。
	act, err := s.st.TouchWxAdmin(wxs.OpenID, wxs.UnionID, strings.TrimSpace(b.Nickname), strings.TrimSpace(b.Avatar), ip, s.cfg.WXOpenAdmins)
	if err != nil {
		log500(s, w, err, "记录微信身份")
		return
	}
	if act.Role == "banned" {
		s.jsonErr(w, http.StatusForbidden, "你的微信已被移出管理员名单，无法使用后台")
		return
	}

	token, exp, err := s.st.CreateWxSession(act.OpenID, ip, s.wxSessionTTL())
	if err != nil {
		log500(s, w, err, "建微信会话")
		return
	}
	_ = s.st.AuditAdminWrite(act.OpenID, "wx.login", act.Role, ip, r.UserAgent())

	s.jsonOK(w, map[string]any{
		"token":      token,
		"role":       act.Role,
		"can_write":  act.CanWrite(),
		"nickname":   act.Nickname,
		"avatar":     act.Avatar,
		"openid":     maskOpenID(act.OpenID), // 只回掩码，完整值没必要给端上
		"expires_at": exp.Unix(),
		"is_new":     act.LoginCount == 1,
	})
}

// hWxMe 小程序启动时确认"我是谁、有没有写权限"。
func (s *Server) hWxMe(w http.ResponseWriter, r *http.Request) {
	act := actorFrom(r.Context())
	if act == nil {
		s.jsonErr(w, http.StatusUnauthorized, "未登录")
		return
	}
	out := map[string]any{
		"kind": act.Kind, "role": act.Role, "can_write": act.CanWrite(),
		"openid": maskOpenID(act.Name),
	}
	if act.IsWx() {
		if wx, err := s.st.GetWxAdmin(act.OpenID); err == nil {
			out["nickname"] = wx.Nickname
			out["avatar"] = wx.Avatar
			out["first_seen_at"] = wx.FirstSeenAt
			out["last_seen_at"] = wx.LastSeenAt
			out["login_count"] = wx.LoginCount
		}
	}
	s.jsonOK(w, out)
}

// hWxLogout 退出：删会话。微信身份本身没法"退出"，这里只是让本机 token 失效。
func (s *Server) hWxLogout(w http.ResponseWriter, r *http.Request) {
	if token, _ := sessionTokenFrom(r); token != "" {
		_ = s.st.DropWxSession(token)
	}
	s.jsonOK(w, map[string]any{"bye": true})
}

// hWxMembers 成员名单。要求可写身份：pending 不该知道都有谁、更不该拿到 openid。
// 这里下发完整 openid 而非掩码，因为 owner 要拿它去调成员接口放行/拉黑；
// openid 本身不是凭证 —— 没有微信 code 换出来的会话，知道 openid 也进不来。
func (s *Server) hWxMembers(w http.ResponseWriter, r *http.Request) {
	act := actorFrom(r.Context())
	if act == nil || !act.CanWrite() {
		s.jsonErr(w, http.StatusForbidden, "只有管理员能查看成员名单")
		return
	}
	list, err := s.st.ListWxAdmins()
	if err != nil {
		log500(s, w, err, "查成员")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, m := range list {
		out = append(out, map[string]any{
			"openid":        m.OpenID,
			"openid_masked": maskOpenID(m.OpenID),
			"unionid":       maskOpenID(m.UnionID),
			"nickname":      m.Nickname,
			"avatar":        m.Avatar,
			"role":          m.Role,
			"first_seen_at": m.FirstSeenAt,
			"last_seen_at":  m.LastSeenAt,
			"login_count":   m.LoginCount,
			"note":          m.Note,
		})
	}
	s.jsonOK(w, map[string]any{"items": out, "open_mode": s.cfg.WXOpenAdmins, "is_owner": act.Role == "owner"})
}

// hWxMemberAction 放行/降级/拉黑/移除某个成员。
// 只有 owner 能动别人的角色，admin 也不行 —— 免得两个管理员互相踢。
func (s *Server) hWxMemberAction(w http.ResponseWriter, r *http.Request) {
	act := actorFrom(r.Context())
	if act == nil || act.Role != "owner" {
		s.jsonErr(w, http.StatusForbidden, "只有主人（owner）能管理成员")
		return
	}
	var b struct {
		OpenID string `json:"openid"`
		Action string `json:"action"` // approve | demote | ban | unban | remove | note
		Note   string `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	target := strings.TrimSpace(b.OpenID)
	if target == "" {
		s.jsonErr(w, http.StatusBadRequest, "缺少 openid")
		return
	}

	var err error
	switch b.Action {
	case "approve":
		err = s.st.SetWxRole(target, "admin")
	case "demote":
		err = s.st.SetWxRole(target, "pending")
	case "ban":
		err = s.st.SetWxRole(target, "banned")
	case "unban":
		err = s.st.SetWxRole(target, "pending")
	case "remove":
		err = s.st.DeleteWxAdmin(target)
	case "note":
		err = s.st.SetWxNote(target, b.Note)
	default:
		s.jsonErr(w, http.StatusBadRequest, "未知动作")
		return
	}
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// 改角色后踢掉对方会话，让他下次请求重新拿到新身份的权限。
	if b.Action != "note" {
		_ = s.st.DropWxSessionsByOpenID(target)
	}
	s.auditAs(r, "wx.member."+b.Action, target)
	s.jsonOK(w, map[string]any{"openid": maskOpenID(target), "action": b.Action})
}

// hWxAudit 最近操作记录，排查"谁改了我的内容"用。仅管理员可见。
func (s *Server) hWxAudit(w http.ResponseWriter, r *http.Request) {
	act := actorFrom(r.Context())
	if act == nil || !act.CanWrite() {
		s.jsonErr(w, http.StatusForbidden, "只有管理员能查看操作记录")
		return
	}
	n := intQuery(r.URL.Query().Get("size"), 100, 500)
	rows, err := s.st.ListAudit(n)
	if err != nil {
		log500(s, w, err, "查审计")
		return
	}
	s.jsonOK(w, map[string]any{"items": orEmpty(rows)})
}

// auditAs 在 handler 里记一条审计。失败只写日志，不影响主流程。
func (s *Server) auditAs(r *http.Request, action, target string) {
	act := actorFrom(r.Context())
	actor := "anonymous"
	if act != nil {
		actor = act.Label()
	}
	if err := s.st.AuditAdminWrite(actor, action, target, clientIP(r), r.UserAgent()); err != nil {
		log.Printf("audit: 写入失败 %s/%s: %v", action, target, err)
	}
}

// maskOpenID 掩码：留头 4 留尾 4，中间打点。既认得出是谁，又不会被拿去冒用。
func maskOpenID(s string) string {
	if s == "" {
		return ""
	}
	r := []rune(s)
	if len(r) <= 8 {
		return strings.Repeat("*", len(r))
	}
	return string(r[:4]) + strings.Repeat("*", len(r)-8) + string(r[len(r)-4:])
}

// wxLoginLimit 复用现成的滑动窗口，专门限微信登录，防被人拿假 code 刷微信接口。
var wxLoginLimit = &rateLimit{hits: map[string]*rlEntry{}, lastGC: time.Now()}
