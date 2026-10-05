package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"latiaomei/internal/stats"
	"latiaomei/internal/store"
)

// TierMeta 是五档判定的说明，前端渲染徽章和"评级标准"都读这里。
type TierMeta struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Name  string `json:"name"`
	Desc  string `json:"desc"`
	Color string `json:"color"`
}

// tierMetas 顺序即榜单从上到下的强弱顺序。
var tierMetas = []TierMeta{
	{Code: "hang", Label: "夯", Name: "闭眼冲", Desc: "天花板级、封神。自己去过两次以上，或者一口就知道要常来。不用犹豫，直接冲。", Color: "#b58f4a"},
	{Code: "dingji", Label: "顶级", Name: "行业标杆", Desc: "顶尖水平，几乎无短板，仅次于夯。值得专门为它出门。", Color: "#d8b877"},
	{Code: "renshang", Label: "人上人", Name: "有亮点", Desc: "中上游水准，比普通好一截，有亮点、不踩雷。", Color: "#8aa06b"},
	{Code: "npc", Label: "NPC", Name: "平平无奇", Desc: "普通、平庸、没特色，不好不坏，主打一个路人甲。顺路可以吃，专门跑一趟就免了。", Color: "#8a8478"},
	{Code: "la", Label: "拉完了", Name: "彻底避雷", Desc: "差到极致、彻底踩雷。难吃，或者不值这个价。钱是我的，我也心疼。", Color: "#a0503c"},
}

// hBootstrap 返回首页需要的全部数据：站点文案 + 内容量 + 榜单摘要。
// 一次请求换掉前端 6 个并发查询，冷启动更快，也少一堆接口维护成本。
func (s *Server) hBootstrap(w http.ResponseWriter, r *http.Request) {
	settings, err := s.st.Settings()
	if err != nil {
		log500(s, w, err, "读配置")
		return
	}
	counters, err := s.st.Count()
	if err != nil {
		log500(s, w, err, "读计数")
		return
	}
	tastes, err := s.st.ListTastes("")
	if err != nil {
		log500(s, w, err, "读标签")
		return
	}
	var tasteList, sceneList []store.Taste
	for _, t := range tastes {
		if t.Kind == "scene" {
			sceneList = append(sceneList, t)
		} else {
			tasteList = append(tasteList, t)
		}
	}
	cities, err := s.st.Cities()
	if err != nil {
		log500(s, w, err, "读城市")
		return
	}
	featPage, _ := s.st.ListReviews(store.ReviewFilter{Status: "published", Kind: "tandian", Featured: true, Sort: "score", Size: 1})
	topPage, _ := s.st.ListReviews(store.ReviewFilter{Status: "published", Kind: "tandian", Sort: "rank", Size: 12})
	newPage, _ := s.st.ListReviews(store.ReviewFilter{Status: "published", Kind: "tandian", Sort: "new", Size: 6})
	avoidPage, _ := s.st.ListReviews(store.ReviewFilter{Status: "published", Kind: "tandian", Tiers: []string{"la"}, Sort: "new", Size: 6})
	yuPage, _ := s.st.ListReviews(store.ReviewFilter{Status: "published", Kind: "yushanfang", Sort: "new", Size: 12})
	shopPage, _ := s.st.ListShops("", "", "", 1, 6)

	var featured any
	if featPage != nil && len(featPage.Items) > 0 {
		featured = stripBody(featPage.Items[0])
	}
	out := map[string]any{
		"site":        settings,
		"counters":    counters,
		"tiers":       tierMetas,
		"tastes":      orEmpty(tasteList),
		"scenes":      orEmpty(sceneList),
		"cities":      orEmpty(cities),
		"featured":    featured,
		"top":         stripBodies(topPage),
		"latest":      stripBodies(newPage),
		"avoid":       stripBodies(avoidPage),
		"yushanfang":  stripBodies(yuPage),
		"hot_shops":   shopPage,
		"server_time": time.Now().Unix(),
	}
	s.jsonOK(w, out)
}

// hListReviews 榜单列表：档位 / 口味 / 城市 / 关键词 / 排序 / 分页。
func (s *Server) hListReviews(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	size := intQuery(q.Get("size"), 20, 100)
	f := store.ReviewFilter{
		Status: "published",
		Kind:   pick(q.Get("kind"), "tandian", "yushanfang", "all"),
		// wheel=1：只要转盘池。首页两个转盘用它取数，后台可以在管理端增减。
		WheelOnly: q.Get("wheel") == "1",
		Tiers:     splitList(q.Get("tier")),
		Tastes:    splitList(q.Get("taste")),
		City:      strings.TrimSpace(q.Get("city")),
		Q:         strings.TrimSpace(q.Get("q")),
		Sort:      pick(q.Get("sort"), "rank", "score", "new", "old", "price", "hot"),
		Page:      intQuery(q.Get("page"), 1, 10000),
		Size:      size,
	}
	page, err := s.st.ListReviews(f)
	if err != nil {
		log500(s, w, err, "查榜单")
		return
	}
	page.Items = stripBodies(page)
	s.jsonOK(w, page)
}

// hGetReview 点评详情。带上一条/下一条导航，前端不用再发一次列表请求。
func (s *Server) hGetReview(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(r.PathValue("slug"))
	if slug == "" {
		s.jsonErr(w, http.StatusBadRequest, "缺少 slug")
		return
	}
	rv, err := s.st.GetReview(slug)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "这条点评不存在或已下线")
			return
		}
		log500(s, w, err, "查点评")
		return
	}
	if rv.Status != "published" {
		s.jsonErr(w, http.StatusNotFound, "这条点评还没发布")
		return
	}
	go s.st.BumpReviewViews(rv.ID)
	related := s.st.RelatedReviews(rv, 4)
	s.jsonOK(w, map[string]any{
		"review":  rv,
		"related": stripBodies(&store.ReviewPage{Items: related}),
	})
}

// hListShops 店铺列表。
func (s *Server) hListShops(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, err := s.st.ListShops(strings.TrimSpace(q.Get("city")), strings.TrimSpace(q.Get("q")),
		pick(q.Get("sort"), "", "new", "name", "price"), intQuery(q.Get("page"), 1, 10000), intQuery(q.Get("size"), 24, 100))
	if err != nil {
		log500(s, w, err, "查店铺")
		return
	}
	s.jsonOK(w, page)
}

// hGetShop 店铺详情 + 这家店的全部点评。
func (s *Server) hGetShop(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(r.PathValue("slug"))
	sh, err := s.st.GetShop(slug)
	if err != nil {
		if err == store.ErrNotFound {
			s.jsonErr(w, http.StatusNotFound, "还没有这家店的档案")
			return
		}
		log500(s, w, err, "查店铺")
		return
	}
	reviews, err := s.st.ListReviews(store.ReviewFilter{Status: "published", ShopID: sh.ID, Sort: "score", Size: 50})
	if err != nil {
		log500(s, w, err, "查店铺点评")
		return
	}
	reviews.Items = stripBodies(reviews)
	s.jsonOK(w, map[string]any{"shop": sh, "reviews": reviews})
}

// hTaxonomy 只取筛选字典，供筛选面板单独刷新。
func (s *Server) hTaxonomy(w http.ResponseWriter, r *http.Request) {
	tastes, err := s.st.ListTastes("")
	if err != nil {
		log500(s, w, err, "读标签")
		return
	}
	cities, err := s.st.Cities()
	if err != nil {
		log500(s, w, err, "读城市")
		return
	}
	counters, err := s.st.Count()
	if err != nil {
		log500(s, w, err, "读计数")
		return
	}
	s.jsonOK(w, map[string]any{"tiers": tierMetas, "tastes": orEmpty(tastes),
		"cities": orEmpty(cities), "counters": counters})
}

// hTrack 接收前端上报的路由切换。SPA 换页不打服务端，光靠中间件会漏计。
func (s *Server) hTrack(w http.ResponseWriter, r *http.Request) {
	var body struct {
		P string `json:"p"`
	}
	if err := decode(r, &body); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	p := strings.TrimSpace(body.P)
	if p == "" || p[0] != '/' || !trackLimit.allow(clientIP(r)) {
		w.WriteHeader(http.StatusNoContent) // 静默丢弃：埋点不该给用户体验添堵
		return
	}
	kind, key := contentOf(p)
	s.col.Observe(statsHit(r, p, kind, key))
	w.WriteHeader(http.StatusNoContent)
}

// hHealth 给 systemd/nginx 探活用，也被后台"运行状态"卡片读。
func (s *Server) hHealth(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	err := s.st.DB().Ping()
	disk, _ := s.st.DiskUsage()
	out := map[string]any{
		"ok":         err == nil,
		"db_latency": time.Since(start).String(),
		"db_bytes":   disk.DBBytes,
		"wal_bytes":  disk.WALBytes,
		"uptime":     time.Since(bootTime).String(),
	}
	if err != nil {
		out["error"] = err.Error()
		s.writeJSON(w, http.StatusServiceUnavailable, out)
		return
	}
	s.writeJSON(w, http.StatusOK, out)
}

var bootTime = time.Now()

func statsHit(r *http.Request, path, topKind, topKey string) stats.Hit {
	ua := r.UserAgent()
	return stats.Hit{
		When:    time.Now(),
		IP:      clientIP(r),
		UA:      ua,
		Path:    path,
		Ref:     r.Header.Get("Referer"),
		Status:  http.StatusOK,
		Kind:    stats.KindTrack,
		TopKind: topKind,
		TopKey:  topKey,
		IsBot:   stats.IsBot(ua),
	}
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// stripBodies 把列表结果里的长正文抹掉：列表页用不上，白白多倍带宽。
func stripBodies(page *store.ReviewPage) []store.Review {
	if page == nil {
		return []store.Review{}
	}
	for i := range page.Items {
		page.Items[i].Body = ""
	}
	return page.Items
}

func stripBody(rv store.Review) store.Review {
	rv.Body = ""
	return rv
}

func splitList(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func intQuery(v string, def, max int) int {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func pick(v string, allowed ...string) string {
	for _, a := range allowed {
		if a == v {
			return v
		}
	}
	return allowed[0]
}

// rateLimit 是一个粗糙的每 IP 滑动窗口，只用来保护 /api/track。
type rateLimit struct {
	mu     sync.Mutex
	hits   map[string]*rlEntry
	lastGC time.Time
}

type rlEntry struct {
	n  int
	at time.Time
}

func (l *rateLimit) allow(ip string) bool {
	const limit = 40 // 每分钟每 IP 最多 40 次路由上报，正常浏览够用了
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastGC) > 10*time.Minute {
		l.hits = map[string]*rlEntry{}
		l.lastGC = now
	}
	e := l.hits[ip]
	if e == nil {
		l.hits[ip] = &rlEntry{n: 1, at: now}
		return true
	}
	if now.Sub(e.at) > time.Minute {
		e.n, e.at = 1, now
		return true
	}
	e.n++
	return e.n <= limit
}

var trackLimit = &rateLimit{hits: map[string]*rlEntry{}, lastGC: time.Now()}
