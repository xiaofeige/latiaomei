package httpapi

// ============================================================
// v6 用户端（粉丝侧）接口：微信/抖音小程序静默登录 + 订阅消息授权记账。
// 与后台的 wx_admins 完全隔离：这里只记 openid 和配额，不给任何写权限。
// ============================================================

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

// wxCode2SessionFor 用指定小程序凭证换 openid（与后台登录共用的逻辑，凭证不同）。
func (s *Server) wxCode2SessionFor(appid, secret, code string) (*wxSession, error) {
	if appid == "" || secret == "" {
		return nil, errors.New("服务端未配置该微信端 AppID/AppSecret")
	}
	q := url.Values{"appid": {appid}, "secret": {secret}, "js_code": {code}, "grant_type": {"authorization_code"}}
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
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if err != nil {
		return nil, err
	}
	var out wxSession
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("解析微信响应失败: %w", err)
	}
	if out.ErrCode != 0 {
		return nil, &wxError{code: out.ErrCode, msg: out.ErrMsg}
	}
	if out.OpenID == "" {
		return nil, errors.New("微信没有返回 openid")
	}
	return &out, nil
}

// dyCode2Session 抖音小程序登录：tt.login 的 code 换 openid。
// 官方 v2 接口是 POST JSON：developer.toutiao.com/api/apps/v2/jscode2session。
func (s *Server) dyCode2Session(code string) (string, error) {
	if s.cfg.DYAppID == "" || s.cfg.DYSecret == "" {
		return "", errors.New("服务端未配置抖音小程序 AppID/AppSecret")
	}
	payload, _ := json.Marshal(map[string]string{
		"appid": s.cfg.DYAppID, "secret": s.cfg.DYSecret, "code": code,
	})
	u := strings.TrimRight(s.cfg.DYAPIBase, "/") + "/api/apps/v2/jscode2session"
	resp, err := wxClient.Post(u, jsonContentType, strings.NewReader(string(payload)))
	if err != nil {
		return "", fmt.Errorf("请求抖音接口失败: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if err != nil {
		return "", err
	}
	var out struct {
		ErrNo   int    `json:"err_no"`
		ErrMsg  string `json:"err_msg"`
		ErrTips string `json:"err_tips"`
		Data    struct {
			OpenID     string `json:"openid"`
			UnionID    string `json:"unionid"`
			AnonOpenID string `json:"anonymous_openid"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("解析抖音响应失败: %w", err)
	}
	if out.ErrNo != 0 {
		return "", fmt.Errorf("抖音接口错误 %d: %s %s", out.ErrNo, out.ErrMsg, out.ErrTips)
	}
	id := out.Data.OpenID
	if id == "" {
		id = out.Data.AnonOpenID
	}
	if id == "" {
		return "", errors.New("抖音没有返回 openid")
	}
	return id, nil
}

const jsonContentType = "application/json"

// mpLoginLimit 与后台登录分开计数：粉丝端登录量大，不能把站长自己的登录额度顶掉。
var mpLoginLimit = &rateLimit{hits: map[string]*rlEntry{}, lastGC: time.Now()}

// mpLoginBody 两个登录接口共用；昵称可选（新版微信不让端上拿昵称了，允许为空）。
type mpLoginBody struct {
	Code     string `json:"code"`
	Nickname string `json:"nickname"`
}

// hMpWxLogin 用户端微信小程序静默登录：换 openid，回一个 HMAC 小令牌（30 天），
// 端上只用来做订阅授权；没有会话、没有权限，纯身份标记。
func (s *Server) hMpWxLogin(w http.ResponseWriter, r *http.Request) {
	var b mpLoginBody
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	b.Code = strings.TrimSpace(b.Code)
	if b.Code == "" {
		s.jsonErr(w, http.StatusBadRequest, "缺少 code")
		return
	}
	if !mpLoginLimit.allow(clientIP(r)) {
		s.jsonErr(w, http.StatusTooManyRequests, "登录过于频繁，稍后再试")
		return
	}
	sess, err := s.wxCode2SessionFor(s.cfg.MPAppID, s.cfg.MPSecret, b.Code)
	if err != nil {
		log.Printf("mp: 微信登录失败: %v", err)
		s.jsonErr(w, http.StatusUnauthorized, "登录失败，请重开小程序")
		return
	}
	if err := s.st.UpsertMPID("wxmini", sess.OpenID, sess.UnionID, b.Nickname); err != nil {
		log500(s, w, err, "记 openid")
		return
	}
	s.jsonOK(w, map[string]any{"token": s.mpSign("wxmini", sess.OpenID)})
}

// hMpDyLogin 抖音小程序静默登录。
func (s *Server) hMpDyLogin(w http.ResponseWriter, r *http.Request) {
	var b mpLoginBody
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	b.Code = strings.TrimSpace(b.Code)
	if b.Code == "" {
		s.jsonErr(w, http.StatusBadRequest, "缺少 code")
		return
	}
	if !mpLoginLimit.allow(clientIP(r)) {
		s.jsonErr(w, http.StatusTooManyRequests, "登录过于频繁，稍后再试")
		return
	}
	openid, err := s.dyCode2Session(b.Code)
	if err != nil {
		log.Printf("mp: 抖音登录失败: %v", err)
		s.jsonErr(w, http.StatusUnauthorized, "抖音登录失败，请重开小程序")
		return
	}
	if err := s.st.UpsertMPID("dymini", openid, "", b.Nickname); err != nil {
		log500(s, w, err, "记 openid")
		return
	}
	s.jsonOK(w, map[string]any{"token": s.mpSign("dymini", openid)})
}

// hMpSubscribe 用户在小程序里点了"允许"（requestSubscribeMessage success）后端上回调，
// 配额 +1。鉴权用登录换来的 HMAC 小令牌。
func (s *Server) hMpSubscribe(w http.ResponseWriter, r *http.Request) {
	tok, ok := bearerToken(r)
	if !ok {
		s.jsonErr(w, http.StatusUnauthorized, "请先静默登录")
		return
	}
	ch, openid, ok := s.mpVerify(tok)
	if !ok {
		s.jsonErr(w, http.StatusUnauthorized, "登录态已失效，请重开小程序")
		return
	}
	var b struct {
		TemplateID string `json:"template_id"` // 仅记账参考；配额按人计
	}
	_ = decode(r, &b) // 允许空体
	if ch != "wxmini" {
		s.jsonErr(w, http.StatusBadRequest, "该渠道不支持订阅推送")
		return
	}
	if err := s.st.GrantQuota(ch, openid); err != nil {
		log500(s, w, err, "记配额")
		return
	}
	s.jsonOK(w, map[string]any{"subscribed": true})
}

// hMpConfig 用户端小程序启动时拉的公开配置：订阅模板 ID 等。
// 单独口子是为了不把整张 settings 表暴露出去。
func (s *Server) hMpConfig(w http.ResponseWriter, r *http.Request) {
	sub := s.st.Setting("wx_sub_tpl_id")
	ids := []string{}
	if sub != "" {
		ids = append(ids, sub)
	}
	s.jsonOK(w, map[string]any{
		"site_title":    s.st.Setting("site_title"),
		"ip_name":       s.st.Setting("ip_name"),
		"sub_templates": ids,
		"track":         s.st.Setting("track_enabled") == "1",
	})
}
