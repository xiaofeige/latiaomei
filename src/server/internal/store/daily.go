package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// DailyLink 是日报「今日花絮」里的一条站内跳转。
type DailyLink struct {
	Label string `json:"label"`
	Href  string `json:"href"`
}

// DailyBrief 一条「辣条妹日报」：一天一篇，前台首页横条 + /daily 页展示。
// 素材全部来自站内已发布内容（reviews / ai_rank / wishes），由 httpapi/daily.go
// 每天生成一次；站长手改后 source=manual，引擎不再覆盖当天的 manual 条目。
type DailyBrief struct {
	Date      string      `json:"date"`
	Shop      string      `json:"shop"`
	Dish      string      `json:"dish"`
	Tier      string      `json:"tier"`
	TierLabel string      `json:"tier_label"`
	Verdict   string      `json:"verdict"`
	Blurb     string      `json:"blurb"`
	Slug      string      `json:"slug"`
	Links     []DailyLink `json:"links"`
	Source    string      `json:"source"`
	CreatedAt int64       `json:"created_at"`
	UpdatedAt int64       `json:"updated_at"`
}

// SaveDailyBrief 按日期覆盖写入。manual 写入方（后台）用 force=true；
// 引擎自动生成用 force=false——当天已有 manual 条目就不动，保住站长的手改。
func (s *Store) SaveDailyBrief(b *DailyBrief, force bool) error {
	b.Date = strings.TrimSpace(b.Date)
	if b.Date == "" {
		return errors.New("store: 日报日期为空")
	}
	if !ValidTier(b.Tier) {
		b.Tier = "npc"
	}
	b.TierLabel = TierLabel(b.Tier)
	if b.Source != "manual" && b.Source != "fallback" {
		b.Source = "auto"
	}
	if b.Links == nil {
		b.Links = []DailyLink{}
	}
	links, _ := json.Marshal(b.Links)
	now := s.Now().Unix()
	return s.tx(func(tx *sql.Tx) error {
		if !force {
			var src string
			err := tx.QueryRow("SELECT source FROM daily_brief WHERE date = ?", b.Date).Scan(&src)
			if err == nil && src == "manual" {
				return nil // 站长手改过，引擎闭嘴
			}
		}
		_, err := tx.Exec(`INSERT INTO daily_brief(date, shop, dish, tier, verdict, blurb, slug, links, source, created_at, updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(date) DO UPDATE SET
				shop=excluded.shop, dish=excluded.dish, tier=excluded.tier,
				verdict=excluded.verdict, blurb=excluded.blurb, slug=excluded.slug,
				links=excluded.links, source=excluded.source, updated_at=excluded.updated_at`,
			b.Date, b.Shop, b.Dish, b.Tier, b.Verdict, b.Blurb, b.Slug, string(links), b.Source, now, now)
		return err
	})
}

// GetDailyBrief 按日期（YYYY-MM-DD）取一条；没有返回 ErrNotFound。
func (s *Store) GetDailyBrief(date string) (*DailyBrief, error) {
	row := s.db.QueryRow("SELECT "+dailyCols+" FROM daily_brief WHERE date = ?", date)
	b, err := scanDaily(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return b, nil
}

// ListDailyBriefs 最近 limit 天（日期倒序），给 /daily 页做往期回顾。
func (s *Store) ListDailyBriefs(limit int) ([]DailyBrief, error) {
	if limit <= 0 || limit > 60 {
		limit = 14
	}
	rows, err := s.db.Query("SELECT "+dailyCols+" FROM daily_brief ORDER BY date DESC LIMIT ?", limit)
	if err != nil {
		return nil, fmt.Errorf("store: 查日报: %w", err)
	}
	defer rows.Close()
	var out []DailyBrief
	for rows.Next() {
		b, err := scanDaily(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

const dailyCols = "date, shop, dish, tier, verdict, blurb, slug, links, source, created_at, updated_at"

// scanDaily 扫一行（*sql.Rows 与 *sql.Row 都能进来）。
func scanDaily(sc interface{ Scan(...any) error }) (*DailyBrief, error) {
	var b DailyBrief
	var links string
	if err := sc.Scan(&b.Date, &b.Shop, &b.Dish, &b.Tier, &b.Verdict, &b.Blurb,
		&b.Slug, &links, &b.Source, &b.CreatedAt, &b.UpdatedAt); err != nil {
		return nil, err
	}
	b.TierLabel = TierLabel(b.Tier) // tier_label 不落列，读时从五档码现推
	_ = json.Unmarshal([]byte(links), &b.Links)
	if b.Links == nil {
		b.Links = []DailyLink{}
	}
	return &b, nil
}
