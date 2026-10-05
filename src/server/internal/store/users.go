package store

import (
	pbkdf2Std "crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Admin 后台账号。
type Admin struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	CreatedAt   int64  `json:"created_at"`
	LastLoginAt int64  `json:"last_login_at"`
	LastLoginIP string `json:"last_login_ip"`
}

// 口令哈希参数：PBKDF2-HMAC-SHA256。用标准库自带的 crypto/pbkdf2，
// 不为此引入 x/crypto，省一个依赖和一段编译量。
const (
	pbkdf2Iter  = 120000
	pbkdfKeyLen = 32
)

// HashPassword 生成 "pbkdf2$迭代次数$盐$密钥" 形式的口令散列。
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("store: 取盐: %w", err)
	}
	dk := pbkdf2(password, salt, pbkdf2Iter, pbkdfKeyLen)
	return fmt.Sprintf("pbkdf2$%d$%s$%s", pbkdf2Iter,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk)), nil
}

// VerifyPassword 校验口令，格式不符或不相等一律 false。
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got := pbkdf2(password, salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// pbkdf2 走标准库 crypto/pbkdf2（HMAC-SHA256）。只有登录这条低频路径会调用。
func pbkdf2(password string, salt []byte, iter, keyLen int) []byte {
	dk, err := pbkdf2Std.Key(sha256.New, password, salt, iter, keyLen)
	if err != nil {
		// 参数不合法（长度越界等）时不能返回空串，否则等于放行；
		// 这里返回一段固定长度的伪随机数据，让校验必然失败。
		fallback := sha256.Sum256(append(salt, []byte(password)...))
		return fallback[:]
	}
	return dk
}

// EnsureAdmin 保证存在一个名为 username 的账号；已存在则只在密码为空时不动。
// 返回是否新建，供启动日志提示。
func (s *Store) EnsureAdmin(username, password string) (bool, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return false, errors.New("store: 账号或密码为空，跳过建号")
	}
	var id int64
	err := s.db.QueryRow("SELECT id FROM admins WHERE username = ?", username).Scan(&id)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("store: 查账号: %w", err)
	}
	hash, err := HashPassword(password)
	if err != nil {
		return false, err
	}
	if _, err := s.exec("INSERT INTO admins (username, pass_hash, created_at) VALUES (?,?,?)",
		username, hash, s.Now().Unix()); err != nil {
		return false, err
	}
	return true, nil
}

// AdminCount 返回后台账号总数。启动时用它判断要不要提示"还没建号"。
func (s *Store) AdminCount() (int64, error) {
	var n int64
	if err := s.db.QueryRow("SELECT COUNT(1) FROM admins").Scan(&n); err != nil {
		return 0, fmt.Errorf("store: 数后台账号: %w", err)
	}
	return n, nil
}

// SetPassword 覆盖某账号口令（CLI 改密用）。
func (s *Store) SetPassword(username, password string) error {
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	res, err := s.exec("UPDATE admins SET pass_hash = ? WHERE username = ?", hash, username)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	// 改密后旧会话全部作废。
	if _, err := s.exec("DELETE FROM sessions WHERE admin_id = (SELECT id FROM admins WHERE username = ?)", username); err != nil {
		return err
	}
	return nil
}

// CheckLogin 校验账号密码并更新最近登录信息。
func (s *Store) CheckLogin(username, password, ip string) (*Admin, error) {
	var a Admin
	var hash string
	err := s.db.QueryRow("SELECT id, username, pass_hash, created_at, last_login_at, last_login_ip FROM admins WHERE username = ?", username).
		Scan(&a.ID, &a.Username, &hash, &a.CreatedAt, &a.LastLoginAt, &a.LastLoginIP)
	if errors.Is(err, sql.ErrNoRows) {
		// 不区分"用户不存在"和"密码错"，但也要跑一次哈希，避免时序上暴露账号。
		_, _ = HashPassword(password)
		return nil, ErrBadCredentials
	}
	if err != nil {
		return nil, err
	}
	if !VerifyPassword(password, hash) {
		return nil, ErrBadCredentials
	}
	now := s.Now().Unix()
	if _, err := s.exec("UPDATE admins SET last_login_at = ?, last_login_ip = ? WHERE id = ?", now, ip, a.ID); err != nil {
		return nil, err
	}
	a.LastLoginAt, a.LastLoginIP = now, ip
	return &a, nil
}

// ErrBadCredentials 表示账号密码不匹配。
var ErrBadCredentials = errors.New("store: 账号或密码不正确")

// CreateSession 写入一个会话，返回明文 token（只在这里出现一次，库里只存哈希）。
func (s *Store) CreateSession(adminID int64, ip string, ttl time.Duration) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, fmt.Errorf("store: 取随机 token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	exp := s.Now().Add(ttl)
	if _, err := s.exec("INSERT INTO sessions (token_hash, admin_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)",
		hashToken(token), adminID, s.Now().Unix(), exp.Unix(), ip); err != nil {
		return "", time.Time{}, err
	}
	return token, exp, nil
}

// SessionAdmin 按 token 找登录用户，顺带在临近过期时滑动续期。
func (s *Store) SessionAdmin(token string, ttl time.Duration) (*Admin, time.Time, error) {
	var a Admin
	var exp int64
	err := s.db.QueryRow(`SELECT a.id, a.username, a.created_at, a.last_login_at, a.last_login_ip, s.expires_at
		FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`, hashToken(token)).
		Scan(&a.ID, &a.Username, &a.CreatedAt, &a.LastLoginAt, &a.LastLoginIP, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrNotFound
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	now := s.Now()
	if exp < now.Unix() {
		_, _ = s.exec("DELETE FROM sessions WHERE token_hash = ?", hashToken(token))
		return nil, time.Time{}, ErrNotFound
	}
	// 剩下不到 1/3 寿命才续期，避免每次后台请求都写库。
	if time.Duration(exp-now.Unix())*time.Second < ttl/3 {
		newExp := now.Add(ttl).Unix()
		if _, err := s.exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", newExp, hashToken(token)); err == nil {
			exp = newExp
		}
	}
	return &a, time.Unix(exp, 0), nil
}

// DropSession 退出登录时删掉该会话。
func (s *Store) DropSession(token string) error {
	_, err := s.exec("DELETE FROM sessions WHERE token_hash = ?", hashToken(token))
	return err
}

// LoginFail 累计某 IP 的失败次数，返回累计后的值。
func (s *Store) LoginFail(ip string) (int, error) {
	now := s.Now().Unix()
	if _, err := s.exec(`INSERT INTO login_attempts(ip, fails, updated_at) VALUES (?,1,?)
			ON CONFLICT(ip) DO UPDATE SET fails = fails + 1, updated_at = excluded.updated_at`, ip, now); err != nil {
		return 0, err
	}
	var n int
	err := s.db.QueryRow("SELECT fails FROM login_attempts WHERE ip = ?", ip).Scan(&n)
	return n, err
}

// LoginFailCount 读某 IP 的累计失败次数。
func (s *Store) LoginFailCount(ip string) (int, error) {
	var n int
	err := s.db.QueryRow("SELECT fails FROM login_attempts WHERE ip = ?", ip).Scan(&n)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return n, err
}

// LoginFailClear 登录成功后清零。
func (s *Store) LoginFailClear(ip string) {
	_, _ = s.exec("DELETE FROM login_attempts WHERE ip = ?", ip)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte("latiaomei-session|" + token))
	return fmt.Sprintf("%x", sum)
}
