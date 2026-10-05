package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 微信身份相关的存储层：谁能进后台、当前登录态、以及后台写操作留痕。
//
// 角色语义（role）：
//   owner   第一位登录者，全站唯一，不能再被降级（除非直接改库）
//   admin   已被放行的管理员，可读写
//   pending 陌生 openid 的默认态，只读，等 owner 放行
//   banned  拉黑，连只读都不给
// 另有全局开关 WXOpenAdmins（来自环境变量）：为 true 时新来者直接给 admin。

// WxAdmin 一个微信侧的后台使用者。
type WxAdmin struct {
	OpenID      string `json:"openid"`
	UnionID     string `json:"unionid,omitempty"`
	Nickname    string `json:"nickname"`
	Avatar      string `json:"avatar,omitempty"`
	Role        string `json:"role"`
	FirstSeenAt int64  `json:"first_seen_at"`
	LastSeenAt  int64  `json:"last_seen_at"`
	LoginCount  int64  `json:"login_count"`
	LastIP      string `json:"last_ip,omitempty"`
	Note        string `json:"note,omitempty"`
}

// CanWrite 判定该身份能否执行写操作。
func (a *WxAdmin) CanWrite() bool { return a != nil && (a.Role == "owner" || a.Role == "admin") }

// ValidRole 白名单校验，避免把拼错的 role 写进库。
func ValidRole(r string) bool {
	switch r {
	case "owner", "admin", "pending", "banned":
		return true
	}
	return false
}

// TouchWxAdmin 按 openid 记下“这个人来过”，返回落库后的完整身份。
// 关键规则：库里第一条身份自动成为 owner —— 谁先摄谁定主人，之后的人都走 pending。
func (s *Store) TouchWxAdmin(openid, unionid, nickname, avatar, ip string, openToAll bool) (*WxAdmin, error) {
	openid = strings.TrimSpace(openid)
	if openid == "" {
		return nil, errors.New("store: openid 为空")
	}
	now := s.Now().Unix()

	_, err := s.GetWxAdmin(openid)
	if errors.Is(err, ErrNotFound) {
		// 新人：定角色后插入。
		n, err := s.countWxAdmins()
		if err != nil {
			return nil, err
		}
		role := "pending"
		switch {
		case n == 0:
			role = "owner" // 第一个进来的是主人
		case openToAll:
			role = "admin" // 全局放开模式
		}
		if _, err := s.exec(`INSERT INTO wx_admins
				(openid, unionid, nickname, avatar, role, first_seen_at, last_seen_at, login_count, last_ip)
				VALUES (?,?,?,?,?,?,?,1,?)`,
			openid, unionid, nickname, avatar, role, now, now, ip); err != nil {
			return nil, err
		}
		return s.GetWxAdmin(openid)
	}
	if err != nil {
		return nil, err
	}

	// 老人：只刷新画像与活跃信息，角色一律不变（防止 owner 被手动改回 pending 后又被自动提升）。
	if _, err := s.exec(`UPDATE wx_admins SET
			unionid     = CASE WHEN ? != '' THEN ? ELSE unionid END,
			nickname    = CASE WHEN ? != '' THEN ? ELSE nickname END,
			avatar      = CASE WHEN ? != '' THEN ? ELSE avatar END,
			last_seen_at= ?,
			login_count = login_count + 1,
			last_ip     = ?
			WHERE openid = ?`,
		unionid, unionid, nickname, nickname, avatar, avatar, now, ip, openid); err != nil {
		return nil, err
	}
	return s.GetWxAdmin(openid)
}

func (s *Store) countWxAdmins() (int64, error) {
	var n int64
	err := s.db.QueryRow("SELECT COUNT(1) FROM wx_admins").Scan(&n)
	return n, err
}

// GetWxAdmin 按 openid 取身份。
func (s *Store) GetWxAdmin(openid string) (*WxAdmin, error) {
	var a WxAdmin
	err := s.db.QueryRow(`SELECT openid, unionid, nickname, avatar, role, first_seen_at, last_seen_at, login_count,
			COALESCE(last_ip,''), COALESCE(note,'') FROM wx_admins WHERE openid = ?`, openid).
		Scan(&a.OpenID, &a.UnionID, &a.Nickname, &a.Avatar, &a.Role, &a.FirstSeenAt, &a.LastSeenAt,
			&a.LoginCount, &a.LastIP, &a.Note)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: 读微信身份: %w", err)
	}
	return &a, nil
}

// ListWxAdmins 全部身份，按最近出现排序，供成员管理页展示。
func (s *Store) ListWxAdmins() ([]WxAdmin, error) {
	rows, err := s.db.Query(`SELECT openid, unionid, nickname, avatar, role, first_seen_at, last_seen_at, login_count,
			COALESCE(last_ip,''), COALESCE(note,'') FROM wx_admins
			ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, last_seen_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("store: 查微信身份列表: %w", err)
	}
	defer rows.Close()
	var out []WxAdmin
	for rows.Next() {
		var a WxAdmin
		if err := rows.Scan(&a.OpenID, &a.UnionID, &a.Nickname, &a.Avatar, &a.Role, &a.FirstSeenAt,
			&a.LastSeenAt, &a.LoginCount, &a.LastIP, &a.Note); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SetWxRole 改某人的角色。owner 不许被降级或拉黑，避免把自己锁在门外。
func (s *Store) SetWxRole(openid, role string) error {
	if !ValidRole(role) {
		return fmt.Errorf("store: 非法角色 %q", role)
	}
	cur, err := s.GetWxAdmin(openid)
	if err != nil {
		return err
	}
	if cur.Role == "owner" && role != "owner" {
		return errors.New("store: owner 不能被降级或拉黑")
	}
	_, err = s.exec("UPDATE wx_admins SET role = ? WHERE openid = ?", role, openid)
	return err
}

// SetWxNote 给成员加备注（比如"这是小店员"）。
func (s *Store) SetWxNote(openid, note string) error {
	_, err := s.exec("UPDATE wx_admins SET note = ? WHERE openid = ?", strings.TrimSpace(note), openid)
	return err
}

// DeleteWxAdmin 移除身份并踢掉其所有会话。owner 不允许被删。
func (s *Store) DeleteWxAdmin(openid string) error {
	cur, err := s.GetWxAdmin(openid)
	if err != nil {
		return err
	}
	if cur.Role == "owner" {
		return errors.New("store: 不能移除 owner")
	}
	if _, err := s.exec("DELETE FROM wx_sessions WHERE openid = ?", openid); err != nil {
		return err
	}
	_, err = s.exec("DELETE FROM wx_admins WHERE openid = ?", openid)
	return err
}

// ---- 小程序会话 ----

// CreateWxSession 给某 openid 建一条会话，返回明文 token（只在这里出现一次）。
func (s *Store) CreateWxSession(openid, ip string, ttl time.Duration) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, fmt.Errorf("store: 取随机 token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	exp := s.Now().Add(ttl)
	if _, err := s.exec("INSERT INTO wx_sessions (token_hash, openid, created_at, expires_at, ip) VALUES (?,?,?,?,?)",
		hashToken(token), openid, s.Now().Unix(), exp.Unix(), ip); err != nil {
		return "", time.Time{}, err
	}
	return token, exp, nil
}

// WxSessionAdmin 按 token 找身份，并在剩余寿命不足 1/3 时滑动续期。
func (s *Store) WxSessionAdmin(token string, ttl time.Duration) (*WxAdmin, time.Time, error) {
	var openid string
	var exp int64
	err := s.db.QueryRow("SELECT openid, expires_at FROM wx_sessions WHERE token_hash = ?", hashToken(token)).
		Scan(&openid, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrNotFound
	}
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("store: 查微信会话: %w", err)
	}
	now := s.Now()
	if exp < now.Unix() {
		_, _ = s.exec("DELETE FROM wx_sessions WHERE token_hash = ?", hashToken(token))
		return nil, time.Time{}, ErrNotFound
	}
	a, err := s.GetWxAdmin(openid)
	if err != nil {
		return nil, time.Time{}, err
	}
	if a.Role == "banned" {
		// 拉黑即刻失效：顺手清掉他所有会话。
		_, _ = s.exec("DELETE FROM wx_sessions WHERE openid = ?", openid)
		return nil, time.Time{}, ErrNotFound
	}
	if time.Duration(exp-now.Unix())*time.Second < ttl/3 {
		newExp := now.Add(ttl).Unix()
		if _, err := s.exec("UPDATE wx_sessions SET expires_at = ? WHERE token_hash = ?", hashToken(token), newExp); err == nil {
			exp = newExp
		}
	}
	return a, time.Unix(exp, 0), nil
}

// DropWxSession 退出登录。
func (s *Store) DropWxSession(token string) error {
	_, err := s.exec("DELETE FROM wx_sessions WHERE token_hash = ?", hashToken(token))
	return err
}

// DropWxSessionsByOpenID 踢掉某人的全部会话（改角色/拉黑后让他重新拿权限）。
func (s *Store) DropWxSessionsByOpenID(openid string) error {
	_, err := s.exec("DELETE FROM wx_sessions WHERE openid = ?", openid)
	return err
}

// ---- 审计 ----

// AuditAdminWrite 记一条后台写操作。actor 传 openid 或网页用户名。
func (s *Store) AuditAdminWrite(actor, action, target, ip, ua string) error {
	if len(ua) > 200 {
		ua = ua[:200]
	}
	_, err := s.exec("INSERT INTO admin_audit (at, actor, action, target, ip, ua) VALUES (?,?,?,?,?,?)",
		s.Now().Unix(), actor, action, target, ip, ua)
	return err
}

// AuditRow 一条审计记录。
type AuditRow struct {
	ID     int64  `json:"id"`
	At     int64  `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Target string `json:"target"`
	IP     string `json:"ip"`
}

// ListAudit 最近 n 条审计，按时间倒序。
func (s *Store) ListAudit(n int) ([]AuditRow, error) {
	if n <= 0 || n > 500 {
		n = 100
	}
	rows, err := s.db.Query("SELECT id, at, actor, action, target, ip FROM admin_audit ORDER BY id DESC LIMIT ?", n)
	if err != nil {
		return nil, fmt.Errorf("store: 查审计: %w", err)
	}
	defer rows.Close()
	var out []AuditRow
	for rows.Next() {
		var r AuditRow
		if err := rows.Scan(&r.ID, &r.At, &r.Actor, &r.Action, &r.Target, &r.IP); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
