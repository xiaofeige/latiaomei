package store

// ============================================================
// AI 巡逻榜（v14）：定时互联网巡逻产出的 AI 风评判决，独立客观榜。
//
// 设计要点：
//   - 与探店榜（reviews）物理分表。辣条妹本人没去吃过的店不进探店榜，
//     这里全是「AI 扒全网风评 + 高德到店数据」的判例，前端必须带
//     ai_only 免责标，绝不冒充本人实探。
//   - 一家店（城市+店名）唯一：每轮巡逻 upsert 覆盖旧判决，last_patrol_at
//     留时间戳；想留历史判例是以后的事，现在榜要的是「最新风评」。
//   - promote（晋升）才进探店榜：写一条 reviews draft，走人工放行铁律。
//   - 名次 rank_no 不手填：每轮巡逻结束 RebuildAIRanks 按 score×confidence
//     重排，AI 的榜单 AI 排，人只管留/下架。
// ============================================================

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// AIRankSignal 一条风评信号（signals）或平台盘点（platforms）共用结构。
type AIRankSignal struct {
	K    string `json:"k"`
	V    string `json:"v"`
	Good int    `json:"good"` // 1 正面 / 0 中性 / -1 负面
}

// AIRank 一条 AI 巡逻判决。
type AIRank struct {
	ID           int64          `json:"id"`
	ShopName     string         `json:"shop_name"`
	City         string         `json:"city"`
	District     string         `json:"district"`
	Address      string         `json:"address"`
	Cuisine      string         `json:"cuisine"`
	AvgPrice     int            `json:"avg_price"`
	Level        string         `json:"level"` // solid|foggy|bust|unknown
	LevelLabel   string         `json:"level_label"`
	Score        float64        `json:"score"` // 0-10
	Tier         string         `json:"tier"`
	TierLabel    string         `json:"tier_label"`
	RankNo       int            `json:"rank_no"`
	Judge        string         `json:"judge"`
	Advice       string         `json:"advice"`
	Summary      string         `json:"summary"`
	Signals      []AIRankSignal `json:"signals"`
	Platforms    []AIRankSignal `json:"platforms"`
	Dishes       []string       `json:"dishes"`
	AmapNote     string         `json:"amap_note"`
	Evidence     string         `json:"evidence,omitempty"` // 证据快照：列表接口抹掉，后台详情可查
	Sources      []string       `json:"sources"`
	Confidence   float64        `json:"confidence"`
	Status       string         `json:"status"`
	ViewCount    int64          `json:"view_count"`
	PatrolBatch  string         `json:"patrol_batch"`
	PromotedID   int64          `json:"promoted_review_id"`
	LastPatrolAt int64          `json:"last_patrol_at"`
	CreatedAt    int64          `json:"created_at"`
	UpdatedAt    int64          `json:"updated_at"`
}

var aiLevels = map[string]bool{"solid": true, "foggy": true, "bust": true, "unknown": true}

// LevelLabel 把 level 码翻成前端显示字（与 agent verdict 块口径一致）。
func LevelLabel(code string) string {
	switch code {
	case "solid":
		return "靠谱"
	case "foggy":
		return "有水分"
	case "bust":
		return "不建议"
	}
	return "没底细"
}

// ValidALevel 校验判决等级。
func ValidALevel(code string) bool { return aiLevels[code] }

// TierFromScore 把 0-10 的 AI 风评分折成五档展示码，
// 阈值对齐探店榜 5 分制口径（×2）。level=bust 时封顶 NPC，防高分低判打架。
func TierFromScore(score float64, level string) string {
	if level == "bust" && score > 4.4 {
		score = 4.4
	}
	switch {
	case score >= 8.6:
		return "hang"
	case score >= 7.0:
		return "dingji"
	case score >= 5.6:
		return "renshang"
	case score >= 3.6:
		return "npc"
	}
	return "la"
}

// AIRankFilter 列表条件，零值=不限。
type AIRankFilter struct {
	Status string // active / retired / 空=active；all=全部
	Level  string // solid|foggy|bust|unknown，空=全部
	City   string
	Q      string // 店名/地址模糊
	Sort   string // rank | score | new | patrol（按巡逻时间）
	Page   int
	Size   int
}

// UpsertAIRank 按 (city, shop_name) 插入或覆盖一条判决。
// 覆盖时保留 created_at / promoted_review_id / view_count —— 晋升痕迹和浏览数
// 不该被下一轮巡逻洗掉。
func (s *Store) UpsertAIRank(a *AIRank) error {
	a.ShopName = strings.TrimSpace(a.ShopName)
	if a.ShopName == "" {
		return errors.New("store: 巡逻榜店名为空")
	}
	if a.City == "" {
		a.City = "杭州"
	}
	if !ValidALevel(a.Level) {
		a.Level = "unknown"
	}
	a.Tier = TierFromScore(a.Score, a.Level)
	a.TierLabel = TierLabel(a.Tier)
	a.LevelLabel = LevelLabel(a.Level)
	if a.Status != "retired" {
		a.Status = "active"
	}
	a.Score = math.Round(math.Max(0, math.Min(10, a.Score))*10) / 10
	a.Confidence = math.Round(math.Max(0, math.Min(1, a.Confidence))*100) / 100
	if a.Signals == nil {
		a.Signals = []AIRankSignal{}
	}
	if a.Platforms == nil {
		a.Platforms = []AIRankSignal{}
	}
	if a.Dishes == nil {
		a.Dishes = []string{}
	}
	if a.Sources == nil {
		a.Sources = []string{}
	}
	sig, _ := json.Marshal(a.Signals)
	plat, _ := json.Marshal(a.Platforms)
	dish, _ := json.Marshal(a.Dishes)
	src, _ := json.Marshal(a.Sources)
	now := s.Now().Unix()
	if a.LastPatrolAt == 0 {
		a.LastPatrolAt = now
	}
	return s.tx(func(tx *sql.Tx) error {
		var id int64
		err := tx.QueryRow("SELECT id FROM ai_rank WHERE city = ? AND shop_name = ?", a.City, a.ShopName).Scan(&id)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			res, e := tx.Exec(`INSERT INTO ai_rank (shop_name, city, district, address, cuisine, avg_price,
					level, score, tier, rank_no, judge, advice, summary, signals, platforms, dishes,
					amap_note, evidence, sources, confidence, status, view_count, patrol_batch, promoted_review_id,
					last_patrol_at, created_at, updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				a.ShopName, a.City, a.District, a.Address, a.Cuisine, a.AvgPrice,
				a.Level, a.Score, a.Tier, 0, a.Judge, a.Advice, a.Summary, string(sig), string(plat), string(dish),
				a.AmapNote, a.Evidence, string(src), a.Confidence, a.Status, 0, a.PatrolBatch, 0,
				a.LastPatrolAt, now, now)
			if e != nil {
				return fmt.Errorf("store: 插巡逻榜: %w", e)
			}
			a.ID, _ = res.LastInsertId()
			a.CreatedAt, a.UpdatedAt = now, now
		case err != nil:
			return fmt.Errorf("store: 查巡逻榜: %w", err)
		default:
			_, e := tx.Exec(`UPDATE ai_rank SET district=?, address=?, cuisine=?, avg_price=?,
					level=?, score=?, tier=?, judge=?, advice=?, summary=?, signals=?, platforms=?, dishes=?,
					amap_note=?, evidence=?, sources=?, confidence=?, patrol_batch=?, last_patrol_at=?, updated_at=?
				WHERE id=?`,
				a.District, a.Address, a.Cuisine, a.AvgPrice,
				a.Level, a.Score, a.Tier, a.Judge, a.Advice, a.Summary, string(sig), string(plat), string(dish),
				a.AmapNote, a.Evidence, string(src), a.Confidence, a.PatrolBatch, a.LastPatrolAt, now, id)
			if e != nil {
				return fmt.Errorf("store: 更巡逻榜: %w", e)
			}
			a.ID = id
		}
		return nil
	})
}

const aiRankCols = `id, shop_name, city, district, address, cuisine, avg_price, level, score, tier,
	rank_no, judge, advice, summary, signals, platforms, dishes, amap_note, evidence, sources, confidence,
	status, view_count, patrol_batch, promoted_review_id, last_patrol_at, created_at, updated_at`

func scanAIRanks(rows *sql.Rows) ([]AIRank, error) {
	var out []AIRank
	for rows.Next() {
		var a AIRank
		var sig, plat, dish, src string
		err := rows.Scan(&a.ID, &a.ShopName, &a.City, &a.District, &a.Address, &a.Cuisine, &a.AvgPrice,
			&a.Level, &a.Score, &a.Tier, &a.RankNo, &a.Judge, &a.Advice, &a.Summary, &sig, &plat, &dish,
			&a.AmapNote, &a.Evidence, &src, &a.Confidence, &a.Status, &a.ViewCount, &a.PatrolBatch, &a.PromotedID,
			&a.LastPatrolAt, &a.CreatedAt, &a.UpdatedAt)
		if err != nil {
			return nil, fmt.Errorf("store: 扫巡逻榜: %w", err)
		}
		_ = json.Unmarshal([]byte(sig), &a.Signals)
		_ = json.Unmarshal([]byte(plat), &a.Platforms)
		_ = json.Unmarshal([]byte(dish), &a.Dishes)
		_ = json.Unmarshal([]byte(src), &a.Sources)
		if a.Signals == nil {
			a.Signals = []AIRankSignal{}
		}
		if a.Platforms == nil {
			a.Platforms = []AIRankSignal{}
		}
		if a.Dishes == nil {
			a.Dishes = []string{}
		}
		if a.Sources == nil {
			a.Sources = []string{}
		}
		a.TierLabel = TierLabel(a.Tier)
		a.LevelLabel = LevelLabel(a.Level)
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListAIRanks 分页取巡逻榜。
func (s *Store) ListAIRanks(f AIRankFilter) ([]AIRank, int64, error) {
	var where []string
	var args []any
	status := f.Status
	if status == "" {
		status = "active"
	}
	if status != "all" {
		where = append(where, "status = ?")
		args = append(args, status)
	}
	if ValidALevel(f.Level) {
		where = append(where, "level = ?")
		args = append(args, f.Level)
	}
	if f.City != "" {
		where = append(where, "city = ?")
		args = append(args, f.City)
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		like := "%" + escapeLike(q) + "%"
		where = append(where, "(shop_name LIKE ? ESCAPE '\\' OR district LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like, like)
	}
	orderBy := map[string]string{
		"rank":   "ORDER BY (rank_no = 0), rank_no ASC, score DESC",
		"score":  "ORDER BY score DESC, confidence DESC",
		"new":    "ORDER BY created_at DESC",
		"patrol": "ORDER BY last_patrol_at DESC",
	}[f.Sort]
	if orderBy == "" {
		orderBy = map[string]string{"rank": "ORDER BY (rank_no = 0), rank_no ASC, score DESC"}["rank"]
	}
	size := f.Size
	if size <= 0 || size > 100 {
		size = 20
	}
	page := f.Page
	if page < 1 {
		page = 1
	}
	w := joinWhere(where)
	var total int64
	if err := s.db.QueryRow("SELECT COUNT(1) FROM ai_rank"+w, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("store: 数巡逻榜: %w", err)
	}
	rows, err := s.db.Query("SELECT "+aiRankCols+" FROM ai_rank"+w+" "+orderBy+" LIMIT ? OFFSET ?",
		append(append([]any{}, args...), size, (page-1)*size)...)
	if err != nil {
		return nil, 0, fmt.Errorf("store: 查巡逻榜: %w", err)
	}
	defer rows.Close()
	items, err := scanAIRanks(rows)
	return items, total, err
}

// GetAIRank 按 id 取一条。
func (s *Store) GetAIRank(id int64) (*AIRank, error) {
	rows, err := s.db.Query("SELECT "+aiRankCols+" FROM ai_rank WHERE id = ? LIMIT 1", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, err := scanAIRanks(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, ErrNotFound
	}
	return &items[0], nil
}

// KnownAIRankNames 返回近期（reprolDays 天内）已判过的店名，巡逻选候选时用来跳过。
// days<=0 表示不限（全部在榜的都算已判）。
func (s *Store) KnownAIRankNames(days int) (map[string]bool, error) {
	q := "SELECT shop_name FROM ai_rank"
	var args []any
	if days > 0 {
		q += " WHERE last_patrol_at > ?"
		args = append(args, s.Now().Unix()-int64(days)*86400)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err == nil {
			out[n] = true
		}
	}
	return out, rows.Err()
}

// SetAIRankStatus 上架/下架。
func (s *Store) SetAIRankStatus(id int64, status string) error {
	if status != "active" && status != "retired" {
		return errors.New("store: 巡逻榜非法状态")
	}
	res, err := s.exec("UPDATE ai_rank SET status=?, updated_at=? WHERE id=?", status, s.Now().Unix(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAIRankPromoted 记录晋升产物；0 撤销（草稿被删时调用方可复位）。
func (s *Store) SetAIRankPromoted(id int64, reviewID int64) error {
	_, err := s.exec("UPDATE ai_rank SET promoted_review_id=?, updated_at=? WHERE id=?", reviewID, s.Now().Unix(), id)
	return err
}

// BumpAIRankViews 详情浏览计数（允许丢的软数据）。
func (s *Store) BumpAIRankViews(id int64) {
	_, _ = s.exec("UPDATE ai_rank SET view_count = view_count + 1 WHERE id = ?", id)
}

// DeleteAIRank 删判例（留判例是默认，删除只留给辣条妹真要清库时）。
func (s *Store) DeleteAIRank(id int64) error {
	res, err := s.exec("DELETE FROM ai_rank WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RebuildAIRanks 重排名次：active 行按 score×confidence 降序写 rank_no=1..N。
// 单事务，跟探店榜 SetRanks 一个脾气：不许半新半旧。
func (s *Store) RebuildAIRanks() (int, error) {
	rows, err := s.db.Query("SELECT id FROM ai_rank WHERE status='active' ORDER BY score*confidence DESC, score DESC, last_patrol_at DESC")
	if err != nil {
		return 0, fmt.Errorf("store: 排名巡逻榜: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	now := s.Now().Unix()
	_ = now
	err = s.tx(func(tx *sql.Tx) error {
		if _, e := tx.Exec("UPDATE ai_rank SET rank_no=0 WHERE status='retired' AND rank_no!=0"); e != nil {
			return fmt.Errorf("store: 清退榜名次: %w", e)
		}
		for i, id := range ids {
			if _, e := tx.Exec("UPDATE ai_rank SET rank_no=? WHERE id=?", i+1, id); e != nil {
				return fmt.Errorf("store: 设巡逻榜名次 %d: %w", id, e)
			}
		}
		return nil
	})
	return len(ids), err
}

// CountAIRank 概览计数：总数 / 各 level / 最近巡逻批次。
func (s *Store) CountAIRank() (map[string]any, error) {
	out := map[string]any{}
	var total, active, retired int64
	if err := s.db.QueryRow("SELECT COUNT(1) FROM ai_rank").Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.db.Query("SELECT level, COUNT(1) FROM ai_rank WHERE status='active' GROUP BY level")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byLevel := map[string]int64{}
	for rows.Next() {
		var lv string
		var n int64
		if err := rows.Scan(&lv, &n); err == nil {
			byLevel[lv] = n
		}
	}
	if err := s.db.QueryRow("SELECT COUNT(1) FROM ai_rank WHERE status='active'").Scan(&active); err != nil {
		return nil, err
	}
	if err := s.db.QueryRow("SELECT COUNT(1) FROM ai_rank WHERE status='retired'").Scan(&retired); err != nil {
		return nil, err
	}
	var lastAt int64
	_ = s.db.QueryRow("SELECT MAX(last_patrol_at) FROM ai_rank").Scan(&lastAt)
	var lastBatch string
	_ = s.db.QueryRow("SELECT patrol_batch FROM ai_rank ORDER BY last_patrol_at DESC LIMIT 1").Scan(&lastBatch)
	out["total"] = total
	out["active"] = active
	out["retired"] = retired
	out["by_level"] = byLevel
	out["last_patrol_at"] = lastAt
	out["last_batch"] = lastBatch
	return out, rows.Err()
}
