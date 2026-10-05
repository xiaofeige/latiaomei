package store

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// slug 用无歧义小写字母表，避免 0/o、1/l 看错。中文标题不适合做 URL，
// 所以默认给随机短码，后台可以自己改成可读的英文 slug。
const slugAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

// NewSlug 生成 prefix + 8 位随机码。
func NewSlug(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// 随机源异常时退回时间戳尾数，保证 slug 仍然可用且不重复。
		return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano()%1e8)
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = slugAlphabet[int(v)%len(slugAlphabet)]
	}
	return prefix + string(out)
}

// sanitizeSlug 只保留 URL 安全字符，长度截到 64。
func sanitizeSlug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ' || r == '/':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 64 {
		out = out[:64]
	}
	if out == "" {
		return NewSlug("x")
	}
	return out
}

// ListTastes 取标签；kind 为空取全部。带上每个标签的已发布点评数。
func (s *Store) ListTastes(kind string) ([]Taste, error) {
	q := `SELECT t.id, t.slug, t.name, t.kind, t.sort_no,
			COALESCE((SELECT COUNT(1) FROM review_tastes rt JOIN reviews r ON r.id = rt.review_id
				WHERE rt.taste_id = t.id AND r.status = 'published'), 0)
		FROM tastes t`
	var args []any
	if kind != "" {
		q += ` WHERE t.kind = ?`
		args = append(args, kind)
	}
	q += " ORDER BY t.kind, t.sort_no, t.id"
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: 查标签: %w", err)
	}
	defer rows.Close()
	var out []Taste
	for rows.Next() {
		var t Taste
		if err := rows.Scan(&t.ID, &t.Slug, &t.Name, &t.Kind, &t.SortNo, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SaveTaste 新增或更新标签。
func (s *Store) SaveTaste(t *Taste) error {
	t.Name = strings.TrimSpace(t.Name)
	if t.Name == "" {
		return errors.New("store: 标签名不能为空")
	}
	if t.Kind != "taste" && t.Kind != "scene" {
		t.Kind = "taste"
	}
	if t.Slug == "" {
		t.Slug = sanitizeSlug(t.Name)
	}
	if t.Slug == "x" || t.Slug == "" {
		t.Slug = NewSlug("t")
	}
	t.Slug = sanitizeSlug(t.Slug)
	var err error
	if t.ID > 0 {
		_, err = s.exec("UPDATE tastes SET slug=?, name=?, kind=?, sort_no=? WHERE id=?",
			t.Slug, t.Name, t.Kind, t.SortNo, t.ID)
	} else {
		var res sql.Result
		res, err = s.exec("INSERT INTO tastes (slug, name, kind, sort_no) VALUES (?,?,?,?)",
			t.Slug, t.Name, t.Kind, t.SortNo)
		if err == nil {
			t.ID, _ = res.LastInsertId()
		}
	}
	return err
}

// DeleteTaste 删标签，同时清掉绑定关系。
func (s *Store) DeleteTaste(id int64) error {
	return s.tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM review_tastes WHERE taste_id=?", id); err != nil {
			return fmt.Errorf("store: 清绑定: %w", err)
		}
		res, err := tx.Exec("DELETE FROM tastes WHERE id=?", id)
		if err != nil {
			return fmt.Errorf("store: 删标签: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return nil
	})
}
