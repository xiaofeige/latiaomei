// Package store 封装 SQLite 存储：建库迁移、内容增删改查、统计聚合读写。
package store

import (
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// schemaVersion 对应 schema.sql 的迭代版本，用 PRAGMA user_version 追踪。
// v3 新增微信身份三表（wx_admins / wx_sessions / admin_audit），全是
// CREATE TABLE IF NOT EXISTS，走 schemaSQL 整体执行即可，无需额外升级语句。
// v4 reviews 加 wheel 列：这条菜进不进首页转盘。默认 1，老数据行为不变。
// v5 档位从四档（夯/绝/6/拉）改为五档（夯/顶级/人上人/NPC/拉完了）：
//
//	jue→dingji、liu→npc，新档位 renshang 由辣条妹后续手动改判；老库 seo 文案同步换。
//
// v6 全自动流水线：tasks（分发任务队列）、directives（辣条妹的指令）、
// mp_ids（三端用户 openid 与订阅消息配额）。全是 CREATE IF NOT EXISTS，整体执行即可。
// v7 shops 加 lat/lng：小程序转盘「附近」用，0 表示未标（未标的店不参与附近筛选）。
// v8 许愿池：wishes 表（粉丝想让辣条妹去踩的坑 + 状态/批复）。CREATE IF NOT EXISTS，整体执行即可。
// v9 社媒发布审核：social_items 表（AI 产四平台文案 → 人审放行 → 才能入队发布）。同上整体执行。
// v10 许愿墙：wish_likes 表（粉丝互赞喊话，呼声最高的辣条妹优先去踩）。全是 CREATE IF NOT EXISTS，整体执行即可。
// v11 鉴店 skill：amap_poi 表（高德到店数据/扫街榜痕迹缓存，7 天 TTL）。同上整体执行。
// v13 项目制生产：projects / project_assets / project_steps 三表 + tasks.project_id 列。
// 建视频/文案从“一枪入队跑到底”改为“一个项目、多轮交互”：工作区加图、改提示词、
// 分步跑（出分镜→改分镜→出成片→出文案），每步一条 step 留痕。
const schemaVersion = 13

// v13Upgrade 幂等：任务表挂上项目 id（新库 schema.sql 无此列，老库重复 ALTER 容错）。
var v13Upgrade = []string{
	"ALTER TABLE tasks ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0",
	"CREATE INDEX IF NOT EXISTS idx_task_project ON tasks(project_id, id)",
}

// v7Upgrade 是店铺坐标列，幂等：新库 schema.sql 没有这两列，老库重复 ALTER 容错。
var v7Upgrade = []string{
	"ALTER TABLE shops ADD COLUMN lat REAL NOT NULL DEFAULT 0",
	"ALTER TABLE shops ADD COLUMN lng REAL NOT NULL DEFAULT 0",
}

// v2Upgrade 是 v1 到 v2 的幂等迁移语句：新库 schema.sql 已建列，重复 ALTER 报 duplicate column 时会被容错。
var v2Upgrade = []string{
	"ALTER TABLE reviews ADD COLUMN kind TEXT NOT NULL DEFAULT 'tandian'",
	"CREATE INDEX IF NOT EXISTS idx_reviews_kind ON reviews(kind, status)",
}

// v4Upgrade 是到 v4 的幂等迁移：转盘开关。同样不在 schema.sql 里写死，
// 老库新库都走这条路（IF NOT EXISTS / duplicate column 容错）。
var v4Upgrade = []string{
	"ALTER TABLE reviews ADD COLUMN wheel INTEGER NOT NULL DEFAULT 1",
}

// v5Upgrade 是档位改五档的数据迁移，幂等：跑第二次时已没有 jue/liu 行。
var v5Upgrade = []string{
	"UPDATE reviews SET tier='dingji' WHERE tier='jue'",
	"UPDATE reviews SET tier='npc' WHERE tier='liu'",
	"UPDATE settings SET value=REPLACE(value, '四档判定（夯/绝/6/拉）', '五档判定（夯/顶级/人上人/NPC/拉完了）') WHERE key='seo_description'",
}

// ErrNotFound 表示按 id/slug 没查到行。调用方据此回 404。
var ErrNotFound = errors.New("store: 记录不存在")

// Store 持有一个 SQLite 连接池。
type Store struct {
	db   *sql.DB
	path string
	mu   sync.Mutex // 写操作串行化：SQLite 只允许单写者，靠锁比靠 busy_timeout 重试更稳
	loc  *time.Location

	// cached 存 settings，省掉每个请求一次查询；写 settings 时置空。
	cachedMu  sync.RWMutex
	cachedSet map[string]string
}

// Open 打开（必要时创建）数据库并跑迁移。
func Open(path string, loc *time.Location) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("store: 建目录 %s: %w", dir, err)
		}
	}
	// WAL：读写不互斥；busy_timeout：兜住偶发写冲突；auto_vacuum=INCREMENTAL：
	// 清理统计后能把页还给操作系统，这是"不把磁盘耗尽"的关键一环。
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(10000)" +
		"&_pragma=synchronous(NORMAL)" +
		"&_pragma=foreign_keys(1)" +
		"&_pragma=temp_store(MEMORY)" +
		"&_pragma=cache_size(-8000)" + // 8MB 页缓存/连接，够用了
		"&_pragma=mmap_size(67108864)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: 打开 %s: %w", path, err)
	}
	// 单写者 + 少量并发读者：连接数压到 4，避免多个写事务互相踩。
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(time.Hour)

	s := &Store{db: db, path: path, loc: loc, cachedSet: map[string]string{}}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return s, nil
}

// Close 关闭连接池。
func (s *Store) Close() error { return s.db.Close() }

// DB 暴露底层句柄，给少数需要自定义事务的场合（迁移、备份）。
func (s *Store) DB() *sql.DB { return s.db }

// Now 返回部署时区下的当前时间。
func (s *Store) Now() time.Time { return time.Now().In(s.loc) }

// Today 返回部署时区下的 YYYY-MM-DD，统计按它切日。
func (s *Store) Today() string { return s.Now().Format("2006-01-02") }

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return fmt.Errorf("store: 读 user_version: %w", err)
	}
	if v >= schemaVersion {
		return nil
	}
	if v == 0 {
		// auto_vacuum 必须在建表之前设置才会写进文件头。
		if _, err := s.db.Exec("PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
			return fmt.Errorf("store: 设 auto_vacuum: %w", err)
		}
	}
	if _, err := s.db.Exec(schemaSQL); err != nil {
		return fmt.Errorf("store: 执行 schema: %w", err)
	}
	if v < 2 {
		for _, stmt := range v2Upgrade {
			if _, err := s.db.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
				return fmt.Errorf("store: v2 迁移: %w", err)
			}
		}
	}
	if v < 4 {
		for _, stmt := range v4Upgrade {
			if _, err := s.db.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
				return fmt.Errorf("store: v4 迁移: %w", err)
			}
		}
	}
	if v < 5 {
		for _, stmt := range v5Upgrade {
			if _, err := s.db.Exec(stmt); err != nil {
				return fmt.Errorf("store: v5 迁移: %w", err)
			}
		}
	}
	if v < 7 {
		for _, stmt := range v7Upgrade {
			if _, err := s.db.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
				return fmt.Errorf("store: v7 迁移: %w", err)
			}
		}
	}
	if v < 13 {
		for _, stmt := range v13Upgrade {
			if _, err := s.db.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
				return fmt.Errorf("store: v13 迁移: %w", err)
			}
		}
	}
	if _, err := s.db.Exec(fmt.Sprintf("PRAGMA user_version=%d", schemaVersion)); err != nil {
		return fmt.Errorf("store: 写 user_version: %w", err)
	}
	return nil
}

// exec 是所有写操作的入口：拿锁、执行、必要时带时间戳。
func (s *Store) exec(query string, args ...any) (sql.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: %s: %w", firstLine(query), err)
	}
	return res, nil
}

// tx 在一个事务里跑 fn，写锁全程持有。
func (s *Store) tx(fn func(tx *sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	if err := fn(t); err != nil {
		t.Rollback()
		return err
	}
	if err := t.Commit(); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	return nil
}

func firstLine(q string) string {
	q = strings.TrimSpace(q)
	if i := strings.IndexByte(q, '\n'); i > 0 {
		return q[:i]
	}
	if len(q) > 90 {
		return q[:90]
	}
	return q
}

// Stats 返回库体积，后台"存储"卡片用。
type DiskStats struct {
	Pages        int64 `json:"pages"`
	PageSize     int64 `json:"page_size"`
	Freelist     int64 `json:"freelist"`
	DBBytes      int64 `json:"db_bytes"`
	WALBytes     int64 `json:"wal_bytes"`
	FreeableByte int64 `json:"freeable_bytes"`
}

// DiskUsage 读 PRAGMA 拿库体积和可回收空间。
func (s *Store) DiskUsage() (DiskStats, error) {
	var d DiskStats
	row := s.db.QueryRow("PRAGMA page_count")
	if err := row.Scan(&d.Pages); err != nil {
		return d, err
	}
	if err := s.db.QueryRow("PRAGMA page_size").Scan(&d.PageSize); err != nil {
		return d, err
	}
	if err := s.db.QueryRow("PRAGMA freelist_count").Scan(&d.Freelist); err != nil {
		return d, err
	}
	d.DBBytes = d.Pages * d.PageSize
	d.FreeableByte = d.Freelist * d.PageSize
	if fi, err := os.Stat(s.dbPath()); err == nil {
		d.DBBytes = fi.Size()
	}
	if fi, err := os.Stat(s.dbPath() + "-wal"); err == nil {
		d.WALBytes = fi.Size()
	}
	return d, nil
}

func (s *Store) dbPath() string { return s.path }

// Vacuum 回收空闲页并把库重排，后台"维护"按钮手动触发。
func (s *Store) Vacuum() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec("VACUUM"); err != nil {
		return fmt.Errorf("store: vacuum: %w", err)
	}
	return nil
}

// IncrementalVacuum 只回收空闲页，不重排全库，比 VACUUM 轻得多，适合夜间自动跑。
func (s *Store) IncrementalVacuum(pages int) error {
	if pages <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// PRAGMA 不接受占位符（带 ? 会直接报 near "?": syntax error），只能拼字面量。
	// pages 来自内部配置，不接受外部输入，没有注入面。
	_, err := s.db.Exec(fmt.Sprintf("PRAGMA incremental_vacuum(%d)", pages))
	return err
}
