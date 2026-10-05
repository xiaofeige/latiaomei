package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Upload 一条上传台账。文件本身在磁盘上，这里只记路径和体积。
type Upload struct {
	ID         int64  `json:"id"`
	Path       string `json:"path"`
	Thumb      string `json:"thumb"`
	Mime       string `json:"mime"`
	Bytes      int64  `json:"bytes"`
	ThumbBytes int64  `json:"thumb_bytes"`
	SHA        string `json:"sha"`
	UsedBy     int64  `json:"used_by"`
	CreatedAt  int64  `json:"created_at"`
}

// SaveUpload 记录一次上传。同 path 覆盖。
func (s *Store) SaveUpload(u *Upload) error {
	now := s.Now().Unix()
	_, err := s.exec(`INSERT INTO uploads(path, thumb, mime, bytes, thumb_bytes, sha, created_at)
			VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET thumb=excluded.thumb, mime=excluded.mime,
			bytes=excluded.bytes, thumb_bytes=excluded.thumb_bytes, sha=excluded.sha`,
		u.Path, u.Thumb, u.Mime, u.Bytes, u.ThumbBytes, u.SHA, now)
	if err != nil {
		return fmt.Errorf("store: 记上传: %w", err)
	}
	return s.RecountImageRefs()
}

// ListUploads 取上传清单（后台"媒体库"用），只包含有体积记录的。
func (s *Store) ListUploads(limit int) ([]Upload, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT id, path, thumb, mime, bytes, thumb_bytes, sha, used_by, created_at
		FROM uploads ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Upload
	for rows.Next() {
		var u Upload
		if err := rows.Scan(&u.ID, &u.Path, &u.Thumb, &u.Mime, &u.Bytes, &u.ThumbBytes, &u.SHA, &u.UsedBy, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ReferrersOf 找出引用某图片路径的点评 id（删除媒体前先确认没在用）。
func (s *Store) ReferrersOf(path string) ([]int64, error) {
	rows, err := s.db.Query(`SELECT id, cover, images FROM reviews WHERE cover = ? OR images LIKE ?`,
		path, "%"+strings.ReplaceAll(escapeLike(path), "'", "''")+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		var cover, images string
		if err := rows.Scan(&id, &cover, &images); err != nil {
			return nil, err
		}
		if cover == path {
			out = append(out, id)
			continue
		}
		var list []string
		if json.Unmarshal([]byte(images), &list) == nil {
			for _, p := range list {
				if p == path {
					out = append(out, id)
					break
				}
			}
		}
	}
	return out, rows.Err()
}

// DeleteUpload 删台账并把文件从磁盘上摘掉（原图 + 缩略图）。
func (s *Store) DeleteUpload(id int64, uploadDir string) (Upload, error) {
	var u Upload
	err := s.tx(func(tx *sql.Tx) error {
		row := tx.QueryRow(`SELECT id, path, thumb, mime, bytes, thumb_bytes, sha, used_by, created_at
			FROM uploads WHERE id = ?`, id)
		if err := row.Scan(&u.ID, &u.Path, &u.Thumb, &u.Mime, &u.Bytes, &u.ThumbBytes, &u.SHA, &u.UsedBy, &u.CreatedAt); err != nil {
			if err == sql.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		if u.UsedBy > 0 {
			return fmt.Errorf("store: 该图片仍被 %d 条点评引用，先解绑再删", u.UsedBy)
		}
		if _, err := tx.Exec("DELETE FROM uploads WHERE id = ?", id); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return u, err
	}
	for _, p := range []string{u.Path, u.Thumb} {
		if full, ok := safeJoin(uploadDir, p); ok {
			_ = os.Remove(full)
		}
	}
	return u, nil
}

// RecountImageRefs 重算 uploads.used_by。数据量是"点评条数"级别（个人站最多几千），
// 全量重算比维护增量计数更可靠，也不会在删除路径上漏账。
func (s *Store) RecountImageRefs() error {
	rows, err := s.db.Query("SELECT cover, images FROM reviews")
	if err != nil {
		return err
	}
	counts := map[string]int64{}
	for rows.Next() {
		var cover, images string
		if err := rows.Scan(&cover, &images); err != nil {
			rows.Close()
			return err
		}
		if cover != "" {
			counts[cover]++
		}
		var list []string
		if json.Unmarshal([]byte(images), &list) == nil {
			for _, p := range list {
				if p != "" {
					counts[p]++
				}
			}
		}
	}
	rows.Close()

	return s.tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE uploads SET used_by = 0"); err != nil {
			return err
		}
		for p, n := range counts {
			if _, err := tx.Exec(`INSERT INTO uploads(path, used_by) VALUES (?, ?)
					ON CONFLICT(path) DO UPDATE SET used_by = excluded.used_by`, p, n); err != nil {
				return err
			}
		}
		return nil
	})
}

// safeJoin 把 /uploads/xxx.jpg 这样的 URL 路径拼成磁盘路径，并挡住 ../ 越界。
func safeJoin(uploadDir, webPath string) (string, bool) {
	if webPath == "" {
		return "", false
	}
	rel := strings.TrimPrefix(strings.TrimPrefix(webPath, "/uploads/"), "/")
	rel = filepath.Clean("/" + rel) // 归一化掉 ../，再取相对部分
	full := filepath.Join(uploadDir, strings.TrimPrefix(rel, "/"))
	cleanDir := filepath.Clean(uploadDir)
	if full != cleanDir && !strings.HasPrefix(filepath.Clean(full), cleanDir+string(os.PathSeparator)) {
		return "", false
	}
	return full, true
}

// PurgeOrphanUploads 删除长期没人引用的上传件（后台一键清理用）。
// graceDays 给一个缓冲，避免刚上传还没保存进点评的图被误删。
func (s *Store) PurgeOrphanUploads(uploadDir string, graceDays int) (int64, int64, error) {
	if graceDays <= 0 {
		graceDays = 3
	}
	cutoff := s.Now().AddDate(0, 0, -graceDays).Unix()
	rows, err := s.db.Query(`SELECT id, path, thumb, bytes, thumb_bytes FROM uploads
		WHERE used_by = 0 AND created_at < ?`, cutoff)
	if err != nil {
		return 0, 0, err
	}
	type orph struct {
		id     int64
		path   string
		thumb  string
		bytes  int64
		tbytes int64
	}
	var list []orph
	for rows.Next() {
		var o orph
		if err := rows.Scan(&o.id, &o.path, &o.thumb, &o.bytes, &o.tbytes); err != nil {
			rows.Close()
			return 0, 0, err
		}
		list = append(list, o)
	}
	rows.Close()

	var freed int64
	for _, o := range list {
		for _, p := range []string{o.path, o.thumb} {
			full, ok := safeJoin(uploadDir, p)
			if !ok {
				continue
			}
			if fi, err := os.Stat(full); err == nil {
				freed += fi.Size()
			}
			_ = os.Remove(full)
		}
		if _, err := s.exec("DELETE FROM uploads WHERE id = ?", o.id); err != nil {
			return int64(len(list)), freed, err
		}
	}
	return int64(len(list)), freed, nil
}
