package store

import (
	"database/sql"
	"encoding/json"
)

// refreshUsedImages 在事务内全量重算 uploads.used_by（数据量小，可靠优先）。
func refreshUsedImages(tx *sql.Tx, reviewID int64) error {
	_ = reviewID
	rows, err := tx.Query("SELECT cover, images FROM reviews")
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
	if _, err := tx.Exec("UPDATE uploads SET used_by = 0"); err != nil {
		return err
	}
	for p, n := range counts {
		if _, err := tx.Exec("INSERT INTO uploads(path, used_by) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET used_by = excluded.used_by", p, n); err != nil {
			return err
		}
	}
	return nil
}
