package httpapi

// ── ops：只读运营数据接口（供无限飞管理控制台小程序拉运营看板）────────
//
// 鉴权：静态 token（LATIAOMEI_OPS_TOKEN），走 X-Ops-Token 头，与后台会话/
// CSRF 体系无关；未配置 token 时整组接口关闭（404）。只出不进：这里没有任何
// 写操作，也不暴露口令、openid 明细等敏感字段。
//
// 接口：GET /api/ops/stats?days=N —— 一次性返回流量（今日/昨日/逐日/分时/
// 页面/来源/设备/内容热榜）+ 内容量 + 流水线队列（tasks/social/projects）+
// 粉丝侧（订阅/许愿/AI 巡逻榜）。采集口径与后台首页 hOverview 同源。

import (
	"crypto/subtle"
	"net/http"
	"time"

	"latiaomei/internal/store"
)

// ops 中间件：校验 X-Ops-Token。
func (s *Server) ops(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.OpsToken == "" {
			s.jsonErr(w, http.StatusNotFound, "ops 接口未启用：服务端未配置 LATIAOMEI_OPS_TOKEN")
			return
		}
		tok := r.Header.Get("X-Ops-Token")
		if tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.OpsToken)) != 1 {
			s.jsonErr(w, http.StatusUnauthorized, "ops token 不正确")
			return
		}
		next(w, r)
	}
}

// opsDay 是逐日序列行：stat_day 原始口径 + 内容阅读 + 当日新发布数。
type opsDay struct {
	store.DayRow
	Content   int64 `json:"content"`   // 当日 review+shop 内容页阅读次数
	Published int64 `json:"published"` // 当日新发布点评数
}

// hOpsStats GET /api/ops/stats?days=N。
func (s *Server) hOpsStats(w http.ResponseWriter, r *http.Request) {
	days := intQuery(r.URL.Query().Get("days"), 14, 120)

	series, err := s.st.DailySeries(days)
	if err != nil {
		log500(s, w, err, "ops 读趋势")
		return
	}
	today := s.st.Today()
	cur, err := s.st.Day(today)
	if err != nil {
		log500(s, w, err, "ops 读今日")
		return
	}
	// 与 hOverview 同款：把内存里未落盘的采集量补上，避免"今日 0"的错觉。
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

	contentMap, _ := s.st.ContentSeries(days)
	pubMap, _ := s.st.PublishedSeries(days)
	full := make([]opsDay, 0, len(series))
	seen := map[string]bool{}
	for _, d := range series {
		full = append(full, opsDay{DayRow: d, Content: contentMap[d.Date], Published: pubMap[d.Date]})
		seen[d.Date] = true
	}
	// 今日行大概率还没进 stat_day（统计 30s 才落一批），序列末尾补上。
	if !seen[today] {
		c := cur
		c.Date = today
		full = append(full, opsDay{DayRow: c, Content: contentMap[today], Published: pubMap[today]})
	}

	hourly, _ := s.st.Hourly(today)
	paths, _ := s.st.TopPaths(today, 12)
	refs, _ := s.st.TopRefs(today, 8)
	devices, _ := s.st.Devices(today)
	topRev, _ := s.st.TopContent("review", today, 8)
	topShop, _ := s.st.TopContent("shop", today, 6)
	counters, _ := s.st.Count()

	tasks, _ := s.st.TaskSummary()
	social, _ := s.st.SocialItemSummary()
	projects, _ := s.st.ProjectSummary()
	subs, _ := s.st.MPStats()
	wishes, _ := s.st.WishStats()
	aiRank, _ := s.st.CountAIRank()
	dirs, _ := s.st.ListDirectives("open", 200)
	if dirs == nil {
		dirs = []store.Directive{}
	}

	s.jsonOK(w, map[string]any{
		"ok":          true,
		"server_day":  today,
		"generated":   time.Now().Format(time.RFC3339),
		"days":        days,
		"today":       cur,
		"yesterday":   prev,
		"series":      full,
		"hourly":      hourly,
		"top_paths":   orEmpty(paths),
		"top_refs":    orEmpty(refs),
		"devices":     orEmpty(devices),
		"top_reviews": orEmpty(topRev),
		"top_shops":   orEmpty(topShop),
		"content":     counters,
		"pipeline": map[string]any{
			"tasks":           tasks,
			"social":          social,
			"projects":        projects,
			"directives_open": len(dirs),
		},
		"audience": map[string]any{
			"subscribers": subs,
			"wishes":      wishes,
			"ai_rank":     aiRank,
		},
		"collector": s.col.Stats(),
	})
}
