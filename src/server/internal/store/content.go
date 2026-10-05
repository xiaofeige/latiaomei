package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ShopBrief 是嵌在点评里的店铺摘要，列表页够用。带坐标供小程序「附近转盘」算距离。
type ShopBrief struct {
	Slug     string  `json:"slug"`
	Name     string  `json:"name"`
	City     string  `json:"city"`
	District string  `json:"district"`
	Cuisine  string  `json:"cuisine"`
	AvgPrice int     `json:"avg_price"`
	Lat      float64 `json:"lat,omitempty"` // GCJ-02；0=后台未标坐标
	Lng      float64 `json:"lng,omitempty"`
}

// Taste 口味/场景标签。
type Taste struct {
	ID     int64  `json:"id"`
	Slug   string `json:"slug"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	SortNo int    `json:"sort_no"`
	Count  int64  `json:"count,omitempty"` // 该标签下的点评数（列表接口带上）
}

// Review 一条点评。tier 取 hang/dingji/renshang/npc/la 五档，见 TierLabel。
type Review struct {
	ID          int64      `json:"id"`
	Slug        string     `json:"slug"`
	Kind        string     `json:"kind"`
	KindLabel   string     `json:"kind_label"`
	ShopID      int64      `json:"shop_id"`
	Shop        *ShopBrief `json:"shop,omitempty"`
	Dish        string     `json:"dish"`
	Tier        string     `json:"tier"`
	TierLabel   string     `json:"tier_label"`
	Score       float64    `json:"score"`
	Spicy       int        `json:"spicy"`
	Price       int        `json:"price"`
	Headline    string     `json:"headline"`
	Body        string     `json:"body"`
	OrderTip    string     `json:"order_tip"`
	Revisit     int        `json:"revisit"`
	VisitDate   string     `json:"visit_date"`
	Cover       string     `json:"cover"`
	Images      []string   `json:"images"`
	Featured    bool       `json:"featured"`
	Wheel       bool       `json:"wheel"` // 进不进首页转盘（两个栏目共用这一位）
	RankNo      int        `json:"rank_no"`
	ViewCount   int64      `json:"view_count"`
	Status      string     `json:"status"`
	Tastes      []Taste    `json:"tastes"`
	PublishedAt int64      `json:"published_at"`
	CreatedAt   int64      `json:"created_at"`
	UpdatedAt   int64      `json:"updated_at"`
}

// TierLabel 把内部档位码翻译成前端显示字。
// 五档从强到弱：夯 > 顶级 > 人上人 > NPC > 拉完了。
func TierLabel(code string) string {
	switch code {
	case "hang":
		return "夯"
	case "dingji":
		return "顶级"
	case "renshang":
		return "人上人"
	case "npc":
		return "NPC"
	case "la":
		return "拉完了"
	}
	return code
}

// ValidTier 校验档位。
func ValidTier(code string) bool {
	switch code {
	case "hang", "dingji", "renshang", "npc", "la":
		return true
	}
	return false
}

// ReviewFilter 是列表查询条件，零值表示不限。
type ReviewFilter struct {
	Status    string   // published / draft / 空=已发布
	Kind      string   // tandian / yushanfang / all；空=探店（老调用方不传也不串主题）
	Tiers     []string // 档位
	Tastes    []string // 口味 slug，任一命中
	City      string
	Q         string // 菜名/店名/正文模糊
	Featured  bool
	WheelOnly bool // true=只要进转盘的
	ShopID    int64
	Sort      string // rank | score | new | price | hot
	Page      int
	Size      int
}

// ReviewPage 是分页结果。
type ReviewPage struct {
	Items   []Review `json:"items"`
	Total   int64    `json:"total"`
	Page    int      `json:"page"`
	Size    int      `json:"size"`
	HasMore bool     `json:"has_more"`
}

const reviewCols = `r.id, r.slug, r.shop_id, r.dish, r.tier, r.score, r.spicy, r.price,
	r.headline, r.order_tip, r.revisit, r.visit_date, r.cover, r.images, r.featured,
	r.rank_no, r.view_count, r.status, r.published_at, r.created_at, r.updated_at, r.kind,
	r.wheel, s.slug, s.name, s.city, s.district, s.cuisine, s.avg_price, s.lat, s.lng`

const reviewFrom = `FROM reviews r LEFT JOIN shops s ON s.id = r.shop_id`

// ListReviews 按条件取点评列表。
func (s *Store) ListReviews(f ReviewFilter) (*ReviewPage, error) {
	var where []string
	var args []any

	status := f.Status
	if status == "" {
		status = "published"
	}
	if status != "all" {
		where = append(where, "r.status = ?")
		args = append(args, status)
	}
	kind := f.Kind
	if kind == "" {
		kind = KindTandian
	}
	if kind != "all" {
		where = append(where, "r.kind = ?")
		args = append(args, kind)
	}
	if len(f.Tiers) > 0 {
		where = append(where, "r.tier IN ("+placeholders(len(f.Tiers))+")")
		for _, t := range f.Tiers {
			args = append(args, t)
		}
	}
	if f.City != "" {
		where = append(where, "s.city = ?")
		args = append(args, f.City)
	}
	if f.ShopID > 0 {
		where = append(where, "r.shop_id = ?")
		args = append(args, f.ShopID)
	}
	if f.Featured {
		where = append(where, "r.featured = 1")
	}
	if f.WheelOnly {
		where = append(where, "r.wheel = 1")
	}
	if len(f.Tastes) > 0 {
		var in []string
		for _, t := range f.Tastes {
			in = append(in, "?")
			args = append(args, t)
		}
		// 任一命中即可（多选口味是"或"，符合逛吃筛选直觉）
		where = append(where, "EXISTS (SELECT 1 FROM review_tastes rt JOIN tastes t ON t.id = rt.taste_id"+
			" WHERE rt.review_id = r.id AND t.slug IN ("+strings.Join(in, ",")+"))")
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		like := "%" + escapeLike(q) + "%"
		where = append(where, "(r.dish LIKE ? ESCAPE '\\' OR r.headline LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like, like)
	}

	orderBy := map[string]string{
		"rank":  "ORDER BY (r.rank_no = 0), r.rank_no ASC, r.score DESC, r.id DESC",
		"score": "ORDER BY r.score DESC, r.rank_no ASC, r.id DESC",
		"new":   "ORDER BY r.published_at DESC, r.id DESC",
		"old":   "ORDER BY r.published_at ASC, r.id ASC",
		"price": "ORDER BY (r.price = 0), r.price ASC, r.id DESC",
		"hot":   "ORDER BY r.view_count DESC, r.id DESC",
	}[f.Sort]
	if orderBy == "" {
		orderBy = map[string]string{"rank": "ORDER BY (r.rank_no = 0), r.rank_no ASC, r.score DESC, r.id DESC"}["rank"]
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
	if err := s.db.QueryRow("SELECT COUNT(1) "+reviewFrom+w, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("store: 数点评: %w", err)
	}

	rows, err := s.db.Query("SELECT "+reviewCols+" "+reviewFrom+w+" "+orderBy+" LIMIT ? OFFSET ?",
		append(append([]any{}, args...), size, (page-1)*size)...)
	if err != nil {
		return nil, fmt.Errorf("store: 查点评: %w", err)
	}
	defer rows.Close()

	items, err := scanReviews(rows)
	if err != nil {
		return nil, err
	}
	if err := s.attachTastes(items); err != nil {
		return nil, err
	}
	if err := s.attachShops(items); err != nil {
		return nil, err
	}
	return &ReviewPage{
		Items:   items,
		Total:   total,
		Page:    page,
		Size:    size,
		HasMore: int64(page*size) < total,
	}, nil
}

// GetReview 按 slug 取一条（详情页）。
func (s *Store) GetReview(slug string) (*Review, error) {
	rows, err := s.db.Query("SELECT "+reviewCols+" "+reviewFrom+" WHERE r.slug = ?", slug)
	if err != nil {
		return nil, fmt.Errorf("store: 查点评 %s: %w", slug, err)
	}
	defer rows.Close()
	items, err := scanReviews(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, ErrNotFound
	}
	if err := s.attachTastes(items); err != nil {
		return nil, err
	}
	if err := s.attachShops(items); err != nil {
		return nil, err
	}
	if err := s.attachBody(items); err != nil {
		return nil, err
	}
	return &items[0], nil
}

// GetReviewByID 按主键取一条（后台编辑用）。
func (s *Store) GetReviewByID(id int64) (*Review, error) {
	rows, err := s.db.Query("SELECT "+reviewCols+" "+reviewFrom+" WHERE r.id = ?", id)
	if err != nil {
		return nil, fmt.Errorf("store: 查点评 %d: %w", id, err)
	}
	defer rows.Close()
	items, err := scanReviews(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, ErrNotFound
	}
	if err := s.attachTastes(items); err != nil {
		return nil, err
	}
	if err := s.attachShops(items); err != nil {
		return nil, err
	}
	if err := s.attachBody(items); err != nil {
		return nil, err
	}
	return &items[0], nil
}

// RelatedReviews 取同店或同口味的推荐位。
func (s *Store) RelatedReviews(r *Review, limit int) []Review {
	if limit <= 0 || limit > 12 {
		limit = 4
	}
	var out []Review
	if r.ShopID > 0 {
		rows, err := s.db.Query("SELECT "+reviewCols+" "+reviewFrom+
			" WHERE r.status='published' AND r.kind = ? AND r.shop_id = ? AND r.id != ? ORDER BY r.score DESC LIMIT ?",
			r.Kind, r.ShopID, r.ID, limit)
		if err == nil {
			out, _ = scanReviews(rows)
			rows.Close()
		}
	}
	if len(out) < limit && len(r.Tastes) > 0 {
		need := limit - len(out)
		var slugs []string
		for _, t := range r.Tastes {
			slugs = append(slugs, t.Slug)
		}
		q := "SELECT " + reviewCols + " " + reviewFrom +
			" WHERE r.status='published' AND r.kind = ? AND r.id NOT IN (" + placeholders(1) + ")"
		args := []any{r.Kind, r.ID}
		if len(out) > 0 {
			var ids []string
			for _, o := range out {
				ids = append(ids, "?")
				args = append(args, o.ID)
			}
			q += " AND r.id NOT IN (" + strings.Join(ids, ",") + ")"
		}
		q += " AND EXISTS (SELECT 1 FROM review_tastes rt JOIN tastes t ON t.id=rt.taste_id" +
			" WHERE rt.review_id=r.id AND t.slug IN (" + placeholders(len(slugs)) + "))"
		for _, sl := range slugs {
			args = append(args, sl)
		}
		q += " ORDER BY r.score DESC LIMIT ?"
		args = append(args, need)
		rows, err := s.db.Query(q, args...)
		if err == nil {
			more, _ := scanReviews(rows)
			rows.Close()
			out = append(out, more...)
		}
	}
	if err := s.attachShops(out); err != nil {
		return out
	}
	return out
}

// SaveReview 插入或更新一条点评。tastes 传口味 slug 列表。
func (s *Store) SaveReview(r *Review, tasteSlugs []string) error {
	r.Dish = strings.TrimSpace(r.Dish)
	if r.Dish == "" {
		return errors.New("store: 菜名不能为空")
	}
	if !ValidTier(r.Tier) {
		r.Tier = "npc"
	}
	if !ValidKind(r.Kind) {
		r.Kind = KindTandian
	}
	if r.Status != "draft" && r.Status != "published" {
		r.Status = "draft"
	}
	if r.Score < 0 {
		r.Score = 0
	}
	if r.Score > 5 {
		r.Score = 5
	}
	if r.Spicy < 0 || r.Spicy > 5 {
		r.Spicy = 0
	}
	if r.Slug == "" {
		r.Slug = NewSlug("r")
	}
	r.Slug = sanitizeSlug(r.Slug)
	imgs := r.Images
	if imgs == nil {
		imgs = []string{}
	}
	blob, _ := json.Marshal(imgs)
	if r.Cover == "" && len(imgs) > 0 {
		r.Cover = imgs[0]
	}
	now := s.Now().Unix()

	err := s.tx(func(tx *sql.Tx) error {
		var err error
		if r.ID > 0 {
			_, err = tx.Exec(`UPDATE reviews SET slug=?, shop_id=?, dish=?, tier=?, score=?, spicy=?, price=?,
					headline=?, body=?, order_tip=?, revisit=?, visit_date=?, cover=?, images=?, featured=?,
					rank_no=?, status=?, published_at=?, updated_at=?, kind=?, wheel=? WHERE id=?`,
				r.Slug, r.ShopID, r.Dish, r.Tier, r.Score, r.Spicy, r.Price,
				r.Headline, r.Body, r.OrderTip, r.Revisit, r.VisitDate, r.Cover, string(blob), b2i(r.Featured),
				r.RankNo, r.Status, r.PublishedAt, now, r.Kind, b2i(r.Wheel), r.ID)
		} else {
			if r.Status == "published" && r.PublishedAt == 0 {
				r.PublishedAt = now
			}
			res, e := tx.Exec(`INSERT INTO reviews (slug, shop_id, dish, tier, score, spicy, price,
					headline, body, order_tip, revisit, visit_date, cover, images, featured,
					rank_no, status, published_at, created_at, updated_at, kind, wheel)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				r.Slug, r.ShopID, r.Dish, r.Tier, r.Score, r.Spicy, r.Price,
				r.Headline, r.Body, r.OrderTip, r.Revisit, r.VisitDate, r.Cover, string(blob), b2i(r.Featured),
				r.RankNo, r.Status, r.PublishedAt, now, now, r.Kind, b2i(r.Wheel))
			if e != nil {
				return fmt.Errorf("store: 插点评: %w", e)
			}
			id, e := res.LastInsertId()
			if e != nil {
				return fmt.Errorf("store: 取点评 id: %w", e)
			}
			r.ID = id
			err = nil
		}
		if err != nil {
			return fmt.Errorf("store: 存点评: %w", err)
		}
		if err := bindTastes(tx, r.ID, tasteSlugs); err != nil {
			return err
		}
		if err := refreshUsedImages(tx, r.ID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	r.Images = imgs
	r.UpdatedAt = now
	return nil
}

// SetReviewStatus 发布/撤回，顺带补齐发布时间。
func (s *Store) SetReviewStatus(id int64, status string) error {
	if status != "draft" && status != "published" {
		return errors.New("store: 非法状态")
	}
	now := s.Now().Unix()
	pub := "0"
	if status == "published" {
		pub = "CASE WHEN published_at = 0 THEN " + fmt.Sprint(now) + " ELSE published_at END"
	}
	_, err := s.exec("UPDATE reviews SET status=?, published_at="+pub+", updated_at=? WHERE id=?", status, now, id)
	return err
}

// BumpReviewViews 详情页打开计数 +1（同时喂给后台热榜）。
func (s *Store) BumpReviewViews(id int64) {
	// 这一路允许丢：计数只用于排序展示，不值得为它阻塞。
	_, _ = s.exec("UPDATE reviews SET view_count = view_count + 1 WHERE id = ?", id)
}

// DeleteReview 删点评及其标签绑定。
func (s *Store) DeleteReview(id int64) error {
	return s.tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM review_tastes WHERE review_id=?", id); err != nil {
			return fmt.Errorf("store: 删标签绑定: %w", err)
		}
		res, err := tx.Exec("DELETE FROM reviews WHERE id=?", id)
		if err != nil {
			return fmt.Errorf("store: 删点评: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return refreshUsedImages(tx, id)
	})
}

// SetWheel 开/关某条内容的转盘资格。转盘不挑主题：
// 御膳房盘转 wheel=1 的菜谱，探店盘转 wheel=1 的点评，跟首页取数口径一致。
func (s *Store) SetWheel(id int64, on bool) error {
	res, err := s.exec("UPDATE reviews SET wheel=?, updated_at=? WHERE id=?", b2i(on), s.Now().Unix(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetRanks 拖拽调序后的批量保存：按 ids 顺序把 rank_no 写成 1..N。
// 一个事务完成，避免保存到一半断电留下半新半旧的榜单。
// 上限 200：榜单本来就只给手机屏拖得动的规模，防误传大列表把库锁死。
func (s *Store) SetRanks(ids []int64) error {
	if len(ids) == 0 {
		return errors.New("store: 没有要排序的条目")
	}
	if len(ids) > 200 {
		return errors.New("store: 一次最多排 200 条")
	}
	now := s.Now().Unix()
	return s.tx(func(tx *sql.Tx) error {
		for i, id := range ids {
			if _, err := tx.Exec("UPDATE reviews SET rank_no=?, updated_at=? WHERE id=?", i+1, now, id); err != nil {
				return fmt.Errorf("store: 设名次 %d: %w", id, err)
			}
		}
		return nil
	})
}

// SetFeatured 把某条点评设为首页特写；同一时间只保留一条。
func (s *Store) SetFeatured(id int64) error {
	return s.tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE reviews SET featured = 0 WHERE featured = 1 AND id != ?", id); err != nil {
			return fmt.Errorf("store: 取消旧特写: %w", err)
		}
		_, err := tx.Exec("UPDATE reviews SET featured = 1, updated_at = ? WHERE id = ?", s.Now().Unix(), id)
		return err
	})
}

func scanReviews(rows *sql.Rows) ([]Review, error) {
	var out []Review
	for rows.Next() {
		var (
			r      Review
			images string
			feat   int
			whl    int
			sSlug  sql.NullString
			sName  sql.NullString
			sCity  sql.NullString
			sDist  sql.NullString
			sCuis  sql.NullString
			sPrice sql.NullInt64
			sLat   sql.NullFloat64
			sLng   sql.NullFloat64
		)
		err := rows.Scan(&r.ID, &r.Slug, &r.ShopID, &r.Dish, &r.Tier, &r.Score, &r.Spicy, &r.Price,
			&r.Headline, &r.OrderTip, &r.Revisit, &r.VisitDate, &r.Cover, &images, &feat,
			&r.RankNo, &r.ViewCount, &r.Status, &r.PublishedAt, &r.CreatedAt, &r.UpdatedAt, &r.Kind,
			&whl, &sSlug, &sName, &sCity, &sDist, &sCuis, &sPrice, &sLat, &sLng)
		if err != nil {
			return nil, fmt.Errorf("store: 扫点评: %w", err)
		}
		r.Featured = feat == 1
		r.Wheel = whl == 1
		r.TierLabel = TierLabel(r.Tier)
		if r.Kind == "" {
			r.Kind = KindTandian
		}
		r.KindLabel = KindLabel(r.Kind)
		_ = json.Unmarshal([]byte(images), &r.Images)
		if r.Images == nil {
			r.Images = []string{}
		}
		if sName.Valid && sName.String != "" {
			r.Shop = &ShopBrief{
				Slug: sSlug.String, Name: sName.String, City: sCity.String,
				District: sDist.String, Cuisine: sCuis.String, AvgPrice: int(sPrice.Int64),
				Lat: sLat.Float64, Lng: sLng.Float64,
			}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// attachTastes 批量补标签，避免 N+1。
func (s *Store) attachTastes(items []Review) error {
	if len(items) == 0 {
		return nil
	}
	var ids []string
	var args []any
	for _, it := range items {
		ids = append(ids, "?")
		args = append(args, it.ID)
	}
	rows, err := s.db.Query("SELECT rt.review_id, t.id, t.slug, t.name, t.kind, t.sort_no"+
		" FROM review_tastes rt JOIN tastes t ON t.id = rt.taste_id"+
		" WHERE rt.review_id IN ("+strings.Join(ids, ",")+") ORDER BY t.sort_no, t.name", args...)
	if err != nil {
		return fmt.Errorf("store: 查标签: %w", err)
	}
	defer rows.Close()
	byReview := map[int64][]Taste{}
	for rows.Next() {
		var rid int64
		var t Taste
		if err := rows.Scan(&rid, &t.ID, &t.Slug, &t.Name, &t.Kind, &t.SortNo); err != nil {
			return err
		}
		byReview[rid] = append(byReview[rid], t)
	}
	for i := range items {
		if v, ok := byReview[items[i].ID]; ok {
			items[i].Tastes = v
		} else {
			items[i].Tastes = []Taste{}
		}
	}
	return rows.Err()
}

// attachShops 给没带店铺摘要的行补上店铺信息。
func (s *Store) attachShops(items []Review) error {
	// scanReviews 已经通过 LEFT JOIN 填好了，这里只兜底空切片场景。
	for i := range items {
		if items[i].Tastes == nil {
			items[i].Tastes = []Taste{}
		}
	}
	return nil
}

// attachBody 详情页才把长正文装上（列表接口不返回 body，省带宽）。
func (s *Store) attachBody(items []Review) error {
	for i := range items {
		var body string
		if err := s.db.QueryRow("SELECT body FROM reviews WHERE id=?", items[i].ID).Scan(&body); err != nil {
			return err
		}
		items[i].Body = body
	}
	return nil
}

// bindTastes 用 slug 重建一条点评的标签绑定。未知 slug 自动忽略。
func bindTastes(tx *sql.Tx, reviewID int64, slugs []string) error {
	if _, err := tx.Exec("DELETE FROM review_tastes WHERE review_id=?", reviewID); err != nil {
		return fmt.Errorf("store: 清标签绑定: %w", err)
	}
	for _, slug := range slugs {
		slug = strings.TrimSpace(slug)
		if slug == "" {
			continue
		}
		var tid int64
		err := tx.QueryRow("SELECT id FROM tastes WHERE slug=?", slug).Scan(&tid)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		} else if err != nil {
			return fmt.Errorf("store: 找标签 %s: %w", slug, err)
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO review_tastes (review_id, taste_id) VALUES (?,?)", reviewID, tid); err != nil {
			return fmt.Errorf("store: 绑标签: %w", err)
		}
	}
	return nil
}

func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }

func joinWhere(w []string) string {
	if len(w) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(w, " AND ")
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// escapeLike 转义 LIKE 通配符，防止用户输入 % 变成全表匹配。
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}
