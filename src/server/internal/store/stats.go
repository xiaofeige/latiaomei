package store

import (
	"database/sql"
	"fmt"
	"time"
)

// Delta 是一次落盘的统计增量（由 stats.Collector 攒够一批后交过来）。
type Delta struct {
	Date    string
	Hour    int
	PV      int64
	Bot     int64
	API     int64
	Err     int64
	UV      int64
	HLL     []byte
	Hours   map[int]int64 // hour -> pv
	UVHour  map[int]int64 // hour -> 估算 uv（当日 HLL 的粗粒度切分，够用即可）
	Paths   map[string]int64
	Refs    map[string]int64
	Devices map[string]int64
	Tops    map[[2]string]int64 // {kind, slug} -> pv
}

// ApplyDelta 把一个增量以单事务写进各聚合表。
// 所有表都是"按主键累加"，行数增长有上限（见 Prune），所以体积可控。
func (s *Store) ApplyDelta(d *Delta) error {
	if d == nil || d.Date == "" {
		return nil
	}
	return s.tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO stat_day(date, pv, bot, api, err, uv, uv_hll)
				VALUES (?,?,?,?,?,?,?)
			ON CONFLICT(date) DO UPDATE SET
				pv = pv + excluded.pv,
				bot = bot + excluded.bot,
				api = api + excluded.api,
				err = err + excluded.err,
				uv_hll = excluded.uv_hll,
				uv = excluded.uv`,
			d.Date, d.PV, d.Bot, d.API, d.Err, d.UV, d.HLL); err != nil {
			return fmt.Errorf("store: 落 stat_day: %w", err)
		}
		for h, pv := range d.Hours {
			if pv == 0 {
				continue
			}
			if _, err := tx.Exec(`INSERT INTO stat_hour(date, hour, pv, uv) VALUES (?,?,?,?)
					ON CONFLICT(date, hour) DO UPDATE SET pv = pv + excluded.pv,
					uv = MAX(uv, excluded.uv)`, d.Date, h, pv, d.UVHour[h]); err != nil {
				return fmt.Errorf("store: 落 stat_hour: %w", err)
			}
		}
		for p, n := range d.Paths {
			if _, err := tx.Exec(`INSERT INTO stat_path(date, path, pv) VALUES (?,?,?)
					ON CONFLICT(date, path) DO UPDATE SET pv = pv + excluded.pv`, d.Date, p, n); err != nil {
				return fmt.Errorf("store: 落 stat_path: %w", err)
			}
		}
		for r, n := range d.Refs {
			if _, err := tx.Exec(`INSERT INTO stat_ref(date, ref, pv) VALUES (?,?,?)
					ON CONFLICT(date, ref) DO UPDATE SET pv = pv + excluded.pv`, d.Date, r, n); err != nil {
				return fmt.Errorf("store: 落 stat_ref: %w", err)
			}
		}
		for dev, n := range d.Devices {
			if _, err := tx.Exec(`INSERT INTO stat_device(date, device, pv) VALUES (?,?,?)
					ON CONFLICT(date, device) DO UPDATE SET pv = pv + excluded.pv`, d.Date, dev, n); err != nil {
				return fmt.Errorf("store: 落 stat_device: %w", err)
			}
		}
		for k, n := range d.Tops {
			if _, err := tx.Exec(`INSERT INTO stat_top(date, kind, key, pv) VALUES (?,?,?,?)
					ON CONFLICT(date, kind, key) DO UPDATE SET pv = pv + excluded.pv`,
				d.Date, k[0], k[1], n); err != nil {
				return fmt.Errorf("store: 落 stat_top: %w", err)
			}
		}
		return nil
	})
}

// DayRow 是每日一行的访问汇总。
type DayRow struct {
	Date string `json:"date"`
	PV   int64  `json:"pv"`
	UV   int64  `json:"uv"`
	Bot  int64  `json:"bot"`
	API  int64  `json:"api"`
	Err  int64  `json:"err"`
}

// KV 是通用的"名字+数值"行，后台各种排行榜共用。
type KV struct {
	Name  string  `json:"name"`
	Value int64   `json:"value"`
	Extra string  `json:"extra,omitempty"`
	Pct   float64 `json:"pct,omitempty"`
}

// DailySeries 取 [from, today] 的逐日汇总，按日期升序。
func (s *Store) DailySeries(days int) ([]DayRow, error) {
	if days <= 0 || days > 400 {
		days = 14
	}
	from := s.Now().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	rows, err := s.db.Query(`SELECT date, pv, uv, bot, api, err FROM stat_day
		WHERE date >= ? ORDER BY date ASC`, from)
	if err != nil {
		return nil, fmt.Errorf("store: 查逐日: %w", err)
	}
	defer rows.Close()
	var out []DayRow
	for rows.Next() {
		var d DayRow
		if err := rows.Scan(&d.Date, &d.PV, &d.UV, &d.Bot, &d.API, &d.Err); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Day 取某一天的汇总，没有记录时返回零值。
func (s *Store) Day(date string) (DayRow, error) {
	var d DayRow
	err := s.db.QueryRow(`SELECT date, pv, uv, bot, api, err FROM stat_day WHERE date = ?`, date).
		Scan(&d.Date, &d.PV, &d.UV, &d.Bot, &d.API, &d.Err)
	if err == sql.ErrNoRows {
		return DayRow{Date: date}, nil
	}
	if err != nil {
		return d, err
	}
	return d, nil
}

// Hourly 取某天 24 小时分布，补齐缺失小时，方便前端直接画柱状。
func (s *Store) Hourly(date string) ([]KV, error) {
	rows, err := s.db.Query(`SELECT hour, pv, uv FROM stat_hour WHERE date = ? ORDER BY hour`, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pv := make([]int64, 24)
	uv := make([]int64, 24)
	for rows.Next() {
		var h int
		var p, u int64
		if err := rows.Scan(&h, &p, &u); err != nil {
			return nil, err
		}
		if h >= 0 && h < 24 {
			pv[h], uv[h] = p, u
		}
	}
	out := make([]KV, 24)
	for i := 0; i < 24; i++ {
		out[i] = KV{Name: fmt.Sprintf("%02d:00", i), Value: pv[i], Extra: fmt.Sprint(uv[i])}
	}
	return out, rows.Err()
}

// TopPaths 取某天访问最多的路径。date 为空表示"最近 7 天合计"。
func (s *Store) TopPaths(date string, n int) ([]KV, error) {
	if n <= 0 || n > 100 {
		n = 10
	}
	var rows *sql.Rows
	var err error
	if date == "" {
		rows, err = s.db.Query(`SELECT path, SUM(pv) FROM stat_path
			WHERE date >= ? GROUP BY path ORDER BY SUM(pv) DESC LIMIT ?`, s.since(7), n)
	} else {
		rows, err = s.db.Query(`SELECT path, pv FROM stat_path WHERE date = ? ORDER BY pv DESC LIMIT ?`, date, n)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKV(rows)
}

// TopRefs 取来源域名排行。date 为空表示最近 7 天合计。
func (s *Store) TopRefs(date string, n int) ([]KV, error) {
	if n <= 0 || n > 100 {
		n = 10
	}
	var rows *sql.Rows
	var err error
	if date == "" {
		rows, err = s.db.Query(`SELECT ref, SUM(pv) FROM stat_ref
			WHERE date >= ? AND ref != 'direct' GROUP BY ref ORDER BY SUM(pv) DESC LIMIT ?`, s.since(7), n)
	} else {
		rows, err = s.db.Query(`SELECT ref, pv FROM stat_ref WHERE date = ? AND ref != 'direct'
			ORDER BY pv DESC LIMIT ?`, date, n)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKV(rows)
}

// Devices 取某天设备分布。
func (s *Store) Devices(date string) ([]KV, error) {
	rows, err := s.db.Query(`SELECT device, SUM(pv) FROM stat_path p
		JOIN stat_device d USING(date) WHERE d.date = ? GROUP BY device ORDER BY SUM(d.pv) DESC`, date)
	if err != nil {
		// 上面的连接写法只是占位，真跑用简单查询，避免误乘。
		rows, err = s.db.Query(`SELECT device, pv FROM stat_device WHERE date = ? ORDER BY pv DESC`, date)
		if err != nil {
			return nil, err
		}
	}
	defer rows.Close()
	return scanKV(rows)
}

// TopContent 取某天某类内容（review/shop）的热度榜。
func (s *Store) TopContent(kind, date string, n int) ([]KV, error) {
	if n <= 0 || n > 50 {
		n = 10
	}
	if date == "" {
		date = s.Today()
	}
	rows, err := s.db.Query(`SELECT t.key, t.pv, COALESCE(r.dish, s.name, t.key)
		FROM stat_top t
		LEFT JOIN reviews r ON t.kind = 'review' AND r.slug = t.key
		LEFT JOIN shops  s ON t.kind = 'shop'   AND s.slug = t.key
		WHERE t.kind = ? AND t.date = ? ORDER BY t.pv DESC LIMIT ?`, kind, date, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KV
	for rows.Next() {
		var k KV
		if err := rows.Scan(&k.Name, &k.Value, &k.Extra); err != nil {
			return nil, err
		}
		out = append(out, KV{Name: k.Extra, Value: k.Value, Extra: k.Name})
	}
	return out, rows.Err()
}

// LoadHLL 读回某天已落盘的 UV 寄存器；没有记录时返回 nil。
func (s *Store) LoadHLL(date string) ([]byte, error) {
	var blob []byte
	err := s.db.QueryRow("SELECT uv_hll FROM stat_day WHERE date = ?", date).Scan(&blob)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: 读 uv_hll: %w", err)
	}
	return blob, nil
}

// Counters 是对外展示的内容量：探店 X 家 / 封神 Y 道 / 避雷 Z 道。
type Counters struct {
	Shops      int64 `json:"shops"`
	Reviews    int64 `json:"reviews"`
	Tandian    int64 `json:"tandian"`    // 已发布探店点评数
	Yushanfang int64 `json:"yushanfang"` // 已发布御膳房菜谱数
	Wheel      int64 `json:"wheel"`      // 已发布且在转盘池里的条数
	Hang       int64 `json:"hang"`
	La         int64 `json:"la"`
	Cities     int64 `json:"cities"`
	Views      int64 `json:"views"`
	Tastes     int64 `json:"tastes"`
	Published  int64 `json:"published"`
	Drafts     int64 `json:"drafts"`
}

// Count 汇总内容体量，公开接口和后台都要用。
func (s *Store) Count() (Counters, error) {
	var c Counters
	err := s.db.QueryRow(`SELECT
		(SELECT COUNT(1) FROM shops),
		(SELECT COUNT(1) FROM reviews WHERE status='published'),
		(SELECT COUNT(1) FROM reviews WHERE status='published' AND tier='hang'),
		(SELECT COUNT(1) FROM reviews WHERE status='published' AND tier='la'),
		(SELECT COUNT(DISTINCT city) FROM shops WHERE city != ''),
		(SELECT COALESCE(SUM(view_count),0) FROM reviews),
		(SELECT COUNT(1) FROM tastes),
		(SELECT COUNT(1) FROM reviews WHERE status='published'),
		(SELECT COUNT(1) FROM reviews WHERE status='draft'),
		(SELECT COUNT(1) FROM reviews WHERE status='published' AND kind='tandian'),
		(SELECT COUNT(1) FROM reviews WHERE status='published' AND kind='yushanfang'),
		(SELECT COUNT(1) FROM reviews WHERE status='published' AND wheel=1)`).
		Scan(&c.Shops, &c.Reviews, &c.Hang, &c.La, &c.Cities, &c.Views, &c.Tastes, &c.Published, &c.Drafts,
			&c.Tandian, &c.Yushanfang, &c.Wheel)
	return c, err
}

// Prune 把聚合表收在固定窗口内，并把空闲页还给操作系统。
// 这是"不把磁盘耗尽"的执行环节：每天一次，白天只累加不删除。
func (s *Store) Prune(cfg PruneConfig) (PruneReport, error) {
	var rep PruneReport
	now := s.Now()
	dayPath := now.AddDate(0, 0, -cfg.PathDays).Format("2006-01-02")
	hourCut := now.AddDate(0, 0, -cfg.HourDays).Format("2006-01-02")
	refCut := now.AddDate(0, 0, -cfg.RefDays).Format("2006-01-02")
	topCut := now.AddDate(0, 0, -cfg.TopDays).Format("2006-01-02")
	expired := now.Add(-cfg.SessionTTL).Unix()

	type step struct {
		name string
		q    string
		args []any
	}
	steps := []step{
		{"stat_path 过期", `DELETE FROM stat_path WHERE date < ?`, []any{dayPath}},
		{"stat_hour 过期", `DELETE FROM stat_hour WHERE date < ?`, []any{hourCut}},
		{"stat_ref 过期", `DELETE FROM stat_ref WHERE date < ?`, []any{refCut}},
		{"stat_top 过期", `DELETE FROM stat_top WHERE date < ?`, []any{topCut}},
		// 每天只留 TopN，长尾路径不值得占行。
		{"stat_path 截断", `DELETE FROM stat_path WHERE date <= ? AND rowid NOT IN (
			SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY date ORDER BY pv DESC) rn
			FROM stat_path) WHERE rn <= ?)`, []any{now.AddDate(0, 0, -2).Format("2006-01-02"), cfg.PathTopN}},
		{"stat_ref 截断", `DELETE FROM stat_ref WHERE date <= ? AND rowid NOT IN (
			SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY date ORDER BY pv DESC) rn
			FROM stat_ref) WHERE rn <= ?)`, []any{now.AddDate(0, 0, -2).Format("2006-01-02"), cfg.RefTopN}},
		{"stat_top 截断", `DELETE FROM stat_top WHERE date <= ? AND rowid NOT IN (
			SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY date, kind ORDER BY pv DESC) rn
			FROM stat_top) WHERE rn <= ?)`, []any{now.AddDate(0, 0, -2).Format("2006-01-02"), cfg.TopTopN}},
		{"过期会话", `DELETE FROM sessions WHERE expires_at < ?`, []any{expired}},
		{"陈旧登录失败", `DELETE FROM login_attempts WHERE updated_at < ?`, []any{now.AddDate(0, 0, -7).Unix()}},
		// 微信侧：过期会话直接删；审计按 180 天窗口收，留足"谁半年前改的"可回溯。
		{"微信过期会话", `DELETE FROM wx_sessions WHERE expires_at < ?`, []any{now}},
		{"超龄后台审计", `DELETE FROM admin_audit WHERE at < ?`, []any{now.AddDate(0, 0, -180).Unix()}},
	}
	for _, st := range steps {
		res, err := s.exec(st.q, st.args...)
		if err != nil {
			return rep, err
		}
		n, _ := res.RowsAffected()
		rep.Deleted = append(rep.Deleted, KV{Name: st.name, Value: n})
		rep.Total += n
	}
	if err := s.IncrementalVacuum(cfg.VacuumPages); err != nil {
		return rep, err
	}
	if d, err := s.DiskUsage(); err == nil {
		rep.DBBytes = d.DBBytes
	}
	return rep, nil
}

// PruneConfig 是保留窗口配置。
type PruneConfig struct {
	PathDays    int
	HourDays    int
	RefDays     int
	TopDays     int
	PathTopN    int
	RefTopN     int
	TopTopN     int
	SessionTTL  time.Duration
	VacuumPages int
}

// PruneReport 说明这次清理删了多少行、库还剩多大。
type PruneReport struct {
	Total   int64 `json:"total"`
	Deleted []KV  `json:"deleted"`
	DBBytes int64 `json:"db_bytes"`
}

func (s *Store) since(days int) string {
	return s.Now().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
}

func scanKV(rows *sql.Rows) ([]KV, error) {
	var out []KV
	for rows.Next() {
		var k KV
		if err := rows.Scan(&k.Name, &k.Value); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}
