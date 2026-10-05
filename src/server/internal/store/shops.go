package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Shop 是一家店。Stats 由点评聚合出来，不落库，避免和 reviews 不一致。
type Shop struct {
	ID        int64   `json:"id"`
	Slug      string  `json:"slug"`
	Name      string  `json:"name"`
	City      string  `json:"city"`
	District  string  `json:"district"`
	Address   string  `json:"address"`
	Lat       float64 `json:"lat"` // GCJ-02（后台地图选点直接存的 wx.chooseLocation 坐标）；0=未标
	Lng       float64 `json:"lng"`
	Cuisine   string  `json:"cuisine"`
	AvgPrice  int     `json:"avg_price"`
	Hours     string  `json:"hours"`
	DouyinURL string  `json:"douyin_url"`
	XhsURL    string  `json:"xhs_url"`
	Cover     string  `json:"cover"`
	Note      string  `json:"note"`
	CreatedAt int64   `json:"created_at"`
	UpdatedAt int64   `json:"updated_at"`
	ReviewCnt int64   `json:"review_count"`
	HangCnt   int64   `json:"hang_count"`
	LaCnt     int64   `json:"la_count"`
	AvgScore  float64 `json:"avg_score"`
	BestDish  string  `json:"best_dish"`
}

// ShopPage 分页结果。
type ShopPage struct {
	Items   []Shop `json:"items"`
	Total   int64  `json:"total"`
	Page    int    `json:"page"`
	Size    int    `json:"size"`
	HasMore bool   `json:"has_more"`
}

const shopCols = `id, slug, name, city, district, address, lat, lng, cuisine, avg_price, hours,
	douyin_url, xhs_url, cover, note, created_at, updated_at`

// shopAgg 是点评聚合出来的派生列。必须显式起别名：ListShops 的 orderBy 直接引用了
// review_count / avg_score，没别名时 SQLite 会报 no such column。
const shopAgg = `COALESCE(a.cnt,0) AS review_count, COALESCE(a.hang,0) AS hang_count,
	COALESCE(a.la,0) AS la_count, COALESCE(a.avg,0) AS avg_score, COALESCE(a.best,'') AS best_dish`

// shopJoin 把每家店的点评统计一次算出来，避免在列表里对每行再查一遍。
const shopJoin = ` LEFT JOIN (
	SELECT shop_id, COUNT(1) cnt,
	  SUM(CASE WHEN tier='hang' THEN 1 ELSE 0 END) hang,
	  SUM(CASE WHEN tier='la' THEN 1 ELSE 0 END) la,
	  AVG(CASE WHEN status='published' THEN score END) avg,
	  (SELECT dish FROM reviews x WHERE x.shop_id = reviews.shop_id AND x.status='published'
	    ORDER BY x.score DESC LIMIT 1) best
	FROM reviews GROUP BY shop_id) a ON a.shop_id = shops.id`

// ListShops 按城市/关键词取店铺。
func (s *Store) ListShops(city, q, sort string, page, size int) (*ShopPage, error) {
	var where []string
	var args []any
	if city != "" {
		where = append(where, "city = ?")
		args = append(args, city)
	}
	if q = strings.TrimSpace(q); q != "" {
		like := "%" + escapeLike(q) + "%"
		where = append(where, "(name LIKE ? ESCAPE '\\' OR cuisine LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like)
	}
	w := joinWhere(where)
	if size <= 0 || size > 100 {
		size = 24
	}
	if page < 1 {
		page = 1
	}
	orderBy := "ORDER BY review_count DESC, avg_score DESC, id DESC"
	switch sort {
	case "new":
		orderBy = "ORDER BY created_at DESC, id DESC"
	case "name":
		orderBy = "ORDER BY name ASC"
	case "price":
		orderBy = "ORDER BY (avg_price = 0), avg_price ASC"
	}

	// 点评数/平均分/夯数直接从 reviews 算出来，一条聚合查询带走。
	base := "SELECT " + shopCols + ", " + shopAgg + " FROM shops" + shopJoin + w + " " + orderBy + " LIMIT ? OFFSET ?"

	var total int64
	if err := s.db.QueryRow("SELECT COUNT(1) FROM shops"+w, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("store: 数店铺: %w", err)
	}
	rows, err := s.db.Query(base, append(append([]any{}, args...), size, (page-1)*size)...)
	if err != nil {
		return nil, fmt.Errorf("store: 查店铺: %w", err)
	}
	defer rows.Close()
	items, err := scanShops(rows)
	if err != nil {
		return nil, err
	}
	return &ShopPage{Items: items, Total: total, Page: page, Size: size, HasMore: int64(page*size) < total}, nil
}

// GetShop 按 slug 取一家店（带统计）。
func (s *Store) GetShop(slug string) (*Shop, error) {
	rows, err := s.db.Query("SELECT "+shopCols+", "+shopAgg+" FROM shops"+shopJoin+" WHERE shops.slug = ?", slug)
	if err != nil {
		return nil, fmt.Errorf("store: 查店铺 %s: %w", slug, err)
	}
	defer rows.Close()
	items, err := scanShops(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, ErrNotFound
	}
	return &items[0], nil
}

// GetShopByID 按主键取店铺。
func (s *Store) GetShopByID(id int64) (*Shop, error) {
	rows, err := s.db.Query("SELECT "+shopCols+", 0,0,0,0,'' FROM shops WHERE id = ?", id) // 后台编辑只要店铺本身，统计列给零
	if err != nil {
		return nil, fmt.Errorf("store: 查店铺 %d: %w", id, err)
	}
	defer rows.Close()
	items, err := scanShops(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, ErrNotFound
	}
	return &items[0], nil
}

// SaveShop 新增或更新店铺。
func (s *Store) SaveShop(sh *Shop) error {
	sh.Name = strings.TrimSpace(sh.Name)
	if sh.Name == "" {
		return errors.New("store: 店名不能为空")
	}
	if sh.Slug == "" {
		sh.Slug = NewSlug("s")
	}
	sh.Slug = sanitizeSlug(sh.Slug)
	now := s.Now().Unix()

	var err error
	if sh.ID > 0 {
		_, err = s.exec(`UPDATE shops SET slug=?, name=?, city=?, district=?, address=?, lat=?, lng=?, cuisine=?,
				avg_price=?, hours=?, douyin_url=?, xhs_url=?, cover=?, note=?, updated_at=? WHERE id=?`,
			sh.Slug, sh.Name, sh.City, sh.District, sh.Address, sh.Lat, sh.Lng, sh.Cuisine, sh.AvgPrice, sh.Hours,
			sh.DouyinURL, sh.XhsURL, sh.Cover, sh.Note, now, sh.ID)
	} else {
		var res sql.Result
		res, err = s.exec(`INSERT INTO shops (slug, name, city, district, address, lat, lng, cuisine, avg_price,
				hours, douyin_url, xhs_url, cover, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			sh.Slug, sh.Name, sh.City, sh.District, sh.Address, sh.Lat, sh.Lng, sh.Cuisine, sh.AvgPrice, sh.Hours,
			sh.DouyinURL, sh.XhsURL, sh.Cover, sh.Note, now, now)
		if err == nil {
			sh.ID, _ = res.LastInsertId()
		}
	}
	if err != nil {
		return fmt.Errorf("store: 存店铺: %w", err)
	}
	sh.CreatedAt, sh.UpdatedAt = now, now
	return nil
}

// DeleteShop 删店铺；挂在它下面的点评保留但断链（避免误删内容资产）。
func (s *Store) DeleteShop(id int64) error {
	res, err := s.exec("DELETE FROM shops WHERE id=?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, err = s.exec("UPDATE reviews SET shop_id = 0 WHERE shop_id = ?", id)
	return err
}

// Cities 返回已有城市清单（筛选下拉用）。
func (s *Store) Cities() ([]string, error) {
	rows, err := s.db.Query("SELECT DISTINCT city FROM shops WHERE city != '' ORDER BY city")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err == nil {
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

func scanShops(rows *sql.Rows) ([]Shop, error) {
	var out []Shop
	for rows.Next() {
		var sh Shop
		if err := rows.Scan(&sh.ID, &sh.Slug, &sh.Name, &sh.City, &sh.District, &sh.Address,
			&sh.Lat, &sh.Lng, &sh.Cuisine, &sh.AvgPrice, &sh.Hours, &sh.DouyinURL, &sh.XhsURL, &sh.Cover, &sh.Note,
			&sh.CreatedAt, &sh.UpdatedAt, &sh.ReviewCnt, &sh.HangCnt, &sh.LaCnt, &sh.AvgScore, &sh.BestDish); err != nil {
			return nil, fmt.Errorf("store: 扫店铺: %w", err)
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}
