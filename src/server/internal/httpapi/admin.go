package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"latiaomei/internal/store"
)

// hOverview 是后台首页要的一次性快照。
func (s *Server) hOverview(w http.ResponseWriter, r *http.Request) {
	days := intQuery(r.URL.Query().Get("days"), 14, 90)
	series, err := s.st.DailySeries(days)
	if err != nil {
		log500(s, w, err, "读趋势")
		return
	}
	today := s.st.Today()
	cur, err := s.st.Day(today)
	if err != nil {
		log500(s, w, err, "读今日")
		return
	}
	// 内存里已采集但还没落盘的部分补上，避免"今日 0"的错觉。
	if live := s.col.Stats(); live["date"] == today {
		if p, ok := live["pending_pv"].(int64); ok {
			cur.PV += p
		}
		if u, ok := live["uv_estimate"].(int64); ok && u > cur.UV {
			cur.UV = u
		}
	}
	yday := s.st.Now().AddDate(0, 0, -1).Format("2006-01-02")
	prev, _ := s.st.Day(yday)
	hourly, _ := s.st.Hourly(today)
	paths, _ := s.st.TopPaths(today, 10)
	refs, _ := s.st.TopRefs(today, 8)
	devices, _ := s.st.Devices(today)
	topRev, _ := s.st.TopContent("review", today, 8)
	topShop, _ := s.st.TopContent("shop", today, 6)
	counters, _ := s.st.Count()

	s.jsonOK(w, map[string]any{
		"today":       cur,
		"yesterday":   prev,
		"series":      orEmpty(series),
		"hourly":      hourly,
		"top_paths":   orEmpty(paths),
		"top_refs":    orEmpty(refs),
		"devices":     orEmpty(devices),
		"top_reviews": orEmpty(topRev),
		"top_shops":   orEmpty(topShop),
		"content":     counters,
		"storage":     s.storage(),
		"runtime":     s.runtime(),
	})
}

// hAnalytics 支持按日期下钻看某一天。
func (s *Server) hAnalytics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	date := strings.TrimSpace(q.Get("date"))
	if date == "" {
		date = s.st.Today()
	}
	if _, err := time.Parse("2006-01-02", date); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "date 需为 YYYY-MM-DD")
		return
	}
	d, err := s.st.Day(date)
	if err != nil {
		log500(s, w, err, "读某天")
		return
	}
	hourly, _ := s.st.Hourly(date)
	paths, _ := s.st.TopPaths(date, 25)
	refs, _ := s.st.TopRefs(date, 20)
	devices, _ := s.st.Devices(date)
	topRev, _ := s.st.TopContent("review", date, 20)
	topShop, _ := s.st.TopContent("shop", date, 20)
	s.jsonOK(w, map[string]any{"day": d, "hourly": hourly, "top_paths": orEmpty(paths),
		"top_refs": orEmpty(refs), "devices": orEmpty(devices),
		"top_reviews": orEmpty(topRev), "top_shops": orEmpty(topShop)})
}

func (s *Server) hAdminListReviews(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := pick(q.Get("status"), "all", "published", "draft")
	page, err := s.st.ListReviews(store.ReviewFilter{
		Status:    status,
		Kind:      pick(q.Get("kind"), "all", "tandian", "yushanfang"),
		WheelOnly: q.Get("wheel") == "1",
		Tiers:     splitList(q.Get("tier")),
		Tastes:    splitList(q.Get("taste")),
		City:      strings.TrimSpace(q.Get("city")),
		Q:         strings.TrimSpace(q.Get("q")),
		Sort:      pick(q.Get("sort"), "new", "rank", "score", "hot", "price"),
		Page:      intQuery(q.Get("page"), 1, 10000),
		Size:      intQuery(q.Get("size"), 20, 200), // 上限对齐 SetRanks 的 200：榜单调序页一次拉满
	})
	if err != nil {
		log500(s, w, err, "查点评")
		return
	}
	page.Items = stripBodies(page)
	s.jsonOK(w, page)
}

// hAdminGetReview 后台编辑用：列表接口不返回正文（省带宽），编辑前必须单独拿一条完整的。
func (s *Server) hAdminGetReview(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	rv, err := s.st.GetReviewByID(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "这条点评不存在")
			return
		}
		log500(s, w, err, "读点评")
		return
	}
	s.jsonOK(w, rv)
}

type reviewBody struct {
	ID        int64    `json:"id"`
	Slug      string   `json:"slug"`
	Kind      string   `json:"kind"`
	ShopID    int64    `json:"shop_id"`
	Dish      string   `json:"dish"`
	Tier      string   `json:"tier"`
	Score     float64  `json:"score"`
	Spicy     int      `json:"spicy"`
	Price     int      `json:"price"`
	Headline  string   `json:"headline"`
	Body      string   `json:"body"`
	OrderTip  string   `json:"order_tip"`
	Revisit   int      `json:"revisit"`
	VisitDate string   `json:"visit_date"`
	Cover     string   `json:"cover"`
	Images    []string `json:"images"`
	Featured  bool     `json:"featured"`
	Wheel     *bool    `json:"wheel"` // 不传=保持原值（新增时不传默认进转盘）
	RankNo    int      `json:"rank_no"`
	Status    string   `json:"status"`
	Tastes    []string `json:"tastes"`
}

func (s *Server) hAdminSaveReview(w http.ResponseWriter, r *http.Request) {
	var b reviewBody
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if idParam := r.PathValue("id"); idParam != "" {
		if id, err := strconv.ParseInt(idParam, 10, 64); err == nil {
			b.ID = id
		}
	}
	if b.Dish = strings.TrimSpace(b.Dish); b.Dish == "" {
		s.jsonErr(w, http.StatusBadRequest, "菜名不能为空")
		return
	}
	rv := &store.Review{
		ID: b.ID, Slug: b.Slug, Kind: b.Kind, ShopID: b.ShopID, Dish: b.Dish, Tier: b.Tier, Score: b.Score,
		Spicy: b.Spicy, Price: b.Price, Headline: b.Headline, Body: b.Body, OrderTip: b.OrderTip,
		Revisit: b.Revisit, VisitDate: b.VisitDate, Cover: b.Cover, Images: b.Images,
		Featured: b.Featured, RankNo: b.RankNo, Status: b.Status,
	}
	// wheel 没传时：新建默认进转盘；编辑保留原值，免得老表单整行更新把转盘开关误关掉。
	switch {
	case b.Wheel != nil:
		rv.Wheel = *b.Wheel
	case b.ID > 0:
		if old, err := s.st.GetReviewByID(b.ID); err == nil {
			rv.Wheel = old.Wheel
		}
	default:
		rv.Wheel = true
	}
	if err := s.st.SaveReview(rv, b.Tastes); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			s.jsonErr(w, http.StatusConflict, "这个 slug 已经被占用了，换一个")
			return
		}
		log500(s, w, err, "存点评")
		return
	}
	out, err := s.st.GetReviewByID(rv.ID)
	if err != nil {
		log500(s, w, err, "回读点评")
		return
	}
	s.jsonOK(w, out)
}

func (s *Server) hAdminDeleteReview(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.DeleteReview(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "这条点评已经删过了")
			return
		}
		log500(s, w, err, "删点评")
		return
	}
	s.jsonOK(w, map[string]any{"deleted": id})
}

func (s *Server) hAdminReviewStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetReviewStatus(id, b.Status); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// 审核通过即分发：发布这一个动作，自动为抖音视频/公众号/订阅推送入队，
	// 后续零人工。渠道开关在设置里，辣条妹随时能改发布方向。
	enqueued := 0
	if b.Status == "published" {
		enqueued = s.st.EnqueueForReview(id)
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status, "tasks_enqueued": enqueued})
}

func (s *Server) hAdminFeatured(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.SetFeatured(id); err != nil {
		log500(s, w, err, "设特写")
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "featured": true})
}

// hAdminReviewWheel 开/关某条内容的转盘资格（首页两个转盘各自的取数池）。
func (s *Server) hAdminReviewWheel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		On bool `json:"on"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetWheel(id, b.On); err != nil {
		log500(s, w, err, "设转盘")
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "wheel": b.On})
}

// hAdminSetRanks 排行榜拖拽调序：ids 就是新的名次顺序（1..N）。
// 路由用静态段 rank，Go 的 mux 会优先匹配它而不是 /reviews/{id}。
func (s *Server) hAdminSetRanks(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Kind string  `json:"kind"`
		IDs  []int64 `json:"ids"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !store.ValidKind(b.Kind) {
		s.jsonErr(w, http.StatusBadRequest, "kind 需为 tandian 或 yushanfang")
		return
	}
	// 只允许把同栏目的内容排进同一个榜，防止拖拽时把别的栏目的 id 带进来串榜。
	for _, id := range b.IDs {
		rv, err := s.st.GetReviewByID(id)
		if err != nil {
			s.jsonErr(w, http.StatusBadRequest, fmt.Sprintf("id %d 不存在", id))
			return
		}
		if rv.Kind != b.Kind {
			s.jsonErr(w, http.StatusBadRequest, fmt.Sprintf("「%s」不属于栏目 %s", rv.Dish, b.Kind))
			return
		}
	}
	if err := s.st.SetRanks(b.IDs); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"kind": b.Kind, "count": len(b.IDs)})
}

func (s *Server) hAdminListShops(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, err := s.st.ListShops(strings.TrimSpace(q.Get("city")), strings.TrimSpace(q.Get("q")),
		pick(q.Get("sort"), "new", "name", "price"), intQuery(q.Get("page"), 1, 10000), intQuery(q.Get("size"), 30, 200))
	if err != nil {
		log500(s, w, err, "查店铺")
		return
	}
	s.jsonOK(w, page)
}

func (s *Server) hAdminSaveShop(w http.ResponseWriter, r *http.Request) {
	var sh store.Shop
	if err := decode(r, &sh); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if idParam := r.PathValue("id"); idParam != "" {
		if id, err := strconv.ParseInt(idParam, 10, 64); err == nil {
			sh.ID = id
		}
	}
	if err := s.st.SaveShop(&sh); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			s.jsonErr(w, http.StatusConflict, "这个 slug 已被占用")
			return
		}
		log500(s, w, err, "存店铺")
		return
	}
	s.jsonOK(w, sh)
}

func (s *Server) hAdminDeleteShop(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.DeleteShop(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "这家店已经删过了")
			return
		}
		log500(s, w, err, "删店铺")
		return
	}
	s.jsonOK(w, map[string]any{"deleted": id})
}

func (s *Server) hAdminListTastes(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListTastes(strings.TrimSpace(r.URL.Query().Get("kind")))
	if err != nil {
		log500(s, w, err, "查标签")
		return
	}
	s.jsonOK(w, orEmpty(list))
}

func (s *Server) hAdminSaveTaste(w http.ResponseWriter, r *http.Request) {
	var t store.Taste
	if err := decode(r, &t); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if idParam := r.PathValue("id"); idParam != "" {
		if id, err := strconv.ParseInt(idParam, 10, 64); err == nil {
			t.ID = id
		}
	}
	if err := s.st.SaveTaste(&t); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			s.jsonErr(w, http.StatusConflict, "这个 slug 已被占用")
			return
		}
		log500(s, w, err, "存标签")
		return
	}
	s.jsonOK(w, t)
}

func (s *Server) hAdminDeleteTaste(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.DeleteTaste(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "这个标签已经删过了")
			return
		}
		log500(s, w, err, "删标签")
		return
	}
	s.jsonOK(w, map[string]any{"deleted": id})
}

func (s *Server) hAdminSettings(w http.ResponseWriter, r *http.Request) {
	all, err := s.st.Settings()
	if err != nil {
		log500(s, w, err, "读配置")
		return
	}
	s.jsonOK(w, map[string]any{"settings": all, "keys": store.SettingKeys})
}

func (s *Server) hAdminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Settings map[string]string `json:"settings"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	allow := map[string]bool{}
	for _, k := range store.SettingKeys {
		allow[k] = true
	}
	clean := map[string]string{}
	for k, v := range b.Settings {
		if allow[k] {
			clean[k] = v
		}
	}
	if len(clean) == 0 {
		s.jsonErr(w, http.StatusBadRequest, "没有可保存的配置项")
		return
	}
	if err := s.st.SaveSettings(clean); err != nil {
		log500(s, w, err, "存配置")
		return
	}
	s.st.InvalidateSettingsCache()
	s.jsonOK(w, map[string]any{"saved": len(clean)})
}

func (s *Server) hAdminUploads(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListUploads(intQuery(r.URL.Query().Get("size"), 100, 500))
	if err != nil {
		log500(s, w, err, "读上传")
		return
	}
	s.jsonOK(w, map[string]any{"items": orEmpty(list), "storage": s.storage()})
}

func (s *Server) hAdminDeleteUpload(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	u, err := s.st.DeleteUpload(id, s.cfg.UploadDir())
	if err != nil {
		if strings.Contains(err.Error(), "仍被") {
			s.jsonErr(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "记录不存在")
			return
		}
		log500(s, w, err, "删上传")
		return
	}
	s.jsonOK(w, map[string]any{"deleted": u.Path})
}

// hAdminMaintenance 把运维动作合成一个口子：prune / vacuum / purge / flush。
func (s *Server) hAdminMaintenance(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Action string `json:"action"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	switch b.Action {
	case "flush":
		s.col.Flush()
		s.jsonOK(w, map[string]any{"action": "flush", "detail": "增量已落盘"})
	case "prune":
		s.col.Prune()
		rep, err := s.st.Prune(s.pruneConfig())
		if err != nil {
			log500(s, w, err, "清理")
			return
		}
		s.jsonOK(w, map[string]any{"action": "prune", "detail": rep})
	case "vacuum":
		if err := s.st.Vacuum(); err != nil {
			log500(s, w, err, "VACUUM")
			return
		}
		s.jsonOK(w, map[string]any{"action": "vacuum", "detail": s.storage()})
	case "purge":
		n, freed, err := s.st.PurgeOrphanUploads(s.cfg.UploadDir(), 3)
		if err != nil {
			log500(s, w, err, "清孤儿图")
			return
		}
		s.uploadCache.invalidate()
		s.jsonOK(w, map[string]any{"action": "purge", "deleted": n, "freed_bytes": freed})
	case "reset-uv":
		s.jsonErr(w, http.StatusBadRequest, "UV 口径不重置，避免历史断档")
	default:
		s.jsonErr(w, http.StatusBadRequest, "未知动作")
	}
}

// hAdminExport 导出内容 JSON（点评/店铺/标签/配置），当轻量备份用。
// 统计数据故意不导：它是持续增长的聚合表，导出来也没法复现口径。
func (s *Server) hAdminExport(w http.ResponseWriter, r *http.Request) {
	reviews, err := s.st.ListReviews(store.ReviewFilter{Status: "all", Size: 100, Sort: "new"})
	if err != nil {
		log500(s, w, err, "导出")
		return
	}
	// 分页取全量：个人站数据量小，100 页 * 100 条足够覆盖，取到空为止。
	for page := 2; page <= 100; page++ {
		if !reviews.HasMore {
			break
		}
		next, err := s.st.ListReviews(store.ReviewFilter{Status: "all", Size: 100, Sort: "new", Page: page})
		if err != nil || len(next.Items) == 0 {
			break
		}
		reviews.Items = append(reviews.Items, next.Items...)
		reviews.HasMore = next.HasMore
	}
	for i := range reviews.Items {
		full, err := s.st.GetReviewByID(reviews.Items[i].ID)
		if err == nil {
			reviews.Items[i] = *full
		}
	}
	shops, _ := s.st.ListShops("", "", "name", 1, 200)
	tastes, _ := s.st.ListTastes("")
	settings, _ := s.st.Settings()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="latiaomei-content-`+s.st.Today()+`.json"`)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(map[string]any{
		"exported_at": time.Now().Format(time.RFC3339),
		"app":         "latiaomei",
		"reviews":     reviews.Items,
		"shops":       shops.Items,
		"tastes":      tastes,
		"settings":    settings,
	})
}

// storage 报告磁盘占用。uploads 目录体积走 5 分钟缓存，避免每次进后台都遍历磁盘。
func (s *Server) storage() map[string]any {
	disk, err := s.st.DiskUsage()
	if err != nil {
		disk = store.DiskStats{}
	}
	uploads, files := s.uploadCache.size(func() (int64, int64) { return dirSize(s.cfg.UploadDir()) })
	return map[string]any{
		"db_bytes":       disk.DBBytes,
		"wal_bytes":      disk.WALBytes,
		"freeable_bytes": disk.FreeableByte,
		"upload_bytes":   uploads,
		"upload_files":   files,
		"total_bytes":    disk.DBBytes + disk.WALBytes + uploads,
		"db_err":         err != nil,
	}
}

func (s *Server) runtime() map[string]any {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	lastPrune := s.st.Setting("last_prune_at")
	return map[string]any{
		"go_version":    runtime.Version(),
		"goroutines":    runtime.NumGoroutine(),
		"mem_alloc":     m.Alloc,
		"mem_sys":       m.Sys,
		"uptime_secs":   int64(time.Since(bootTime).Seconds()),
		"collector":     s.col.Stats(),
		"last_prune_at": lastPrune,
	}
}

func (s *Server) pruneConfig() store.PruneConfig {
	return s.pruneCfg
}

// sizeCache 给目录体积加一层带 TTL 的缓存。
type sizeCache struct {
	mu       sync.Mutex
	bytes    int64
	files    int64
	computed time.Time
	ttl      time.Duration
}

func (c *sizeCache) size(fn func() (int64, int64)) (int64, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ttl == 0 {
		c.ttl = 5 * time.Minute
	}
	if time.Since(c.computed) > c.ttl {
		c.bytes, c.files = fn()
		c.computed = time.Now()
	}
	return c.bytes, c.files
}

func (c *sizeCache) invalidate() {
	c.mu.Lock()
	c.computed = time.Time{}
	c.mu.Unlock()
}

// dirSize 遍历目录算体积，跳过缩略图以外的隐藏文件。
func dirSize(dir string) (int64, int64) {
	var total, count int64
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == dir && os.IsNotExist(err) {
				return filepath.SkipAll
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
			count++
		}
		return nil
	})
	return total, count
}
