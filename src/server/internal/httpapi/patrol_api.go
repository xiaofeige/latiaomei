package httpapi

// v14 AI 巡逻榜接口层。
//   - 公开：GET /api/ai-rank、GET /api/ai-rank/{id} —— 独立「AI 客观榜」，
//     响应里必带 disclaimer（纯 AI 检索归纳、未经本人实地验证），前端不许装人榜。
//   - 后台：GET/POST /api/admin/patrol* —— 巡逻状态、立即巡逻、榜单管理、
//     promote 晋升（落 reviews draft，走人工放行铁律，机器没有自发行权）。

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"latiaomei/internal/store"
)

const airankDisclaimer = "本榜为 AI 定时巡逻产物：通义联网检索全网风评（大众点评/美团/小红书/抖音/知乎/微博）" +
	"＋高德到店数据，由 AI 归纳判决，未经辣条妹本人实地验证。分是风评分，不是味道分；参考请打七折。"

// hListAIRank 公开巡逻榜列表（只回 active；抹掉证据快照省带宽）。
func (s *Server) hListAIRank(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, total, err := s.aiRankList(store.AIRankFilter{
		Status: "active",
		Level:  strings.TrimSpace(q.Get("level")),
		City:   strings.TrimSpace(q.Get("city")),
		Q:      strings.TrimSpace(q.Get("q")),
		Sort:   pick(q.Get("sort"), "rank", "score", "new", "patrol"),
		Page:   intQuery(q.Get("page"), 1, 10000),
		Size:   intQuery(q.Get("size"), 20, 100),
	})
	if err != nil {
		log500(s, w, err, "查巡逻榜")
		return
	}
	size := intQuery(q.Get("size"), 20, 100)
	pageNum := intQuery(q.Get("page"), 1, 10000)
	s.jsonOK(w, map[string]any{
		"items":       page,
		"total":       total,
		"page":        pageNum,
		"size":        size,
		"has_more":    int64(pageNum*size) < total,
		"disclaimer":  airankDisclaimer,
		"updated_at":  patrolLastRun(s),
		"ai_only":     true,
		"level_metas": levelMetas(),
	})
}

// hGetAIRank 单条判决（公开）。证据快照不外泄。
func (s *Server) hGetAIRank(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		s.jsonErr(w, http.StatusBadRequest, "id 不合法")
		return
	}
	a, err := s.st.GetAIRank(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "这条判决不存在")
			return
		}
		log500(s, w, err, "查判决")
		return
	}
	if a.Status != "active" {
		s.jsonErr(w, http.StatusNotFound, "这条判决已下架")
		return
	}
	go s.st.BumpAIRankViews(a.ID)
	a.Evidence = ""
	s.jsonOK(w, map[string]any{"item": a, "disclaimer": airankDisclaimer})
}

// hAdminPatrolStatus 巡逻面板数据：开关快照 + 是否在跑 + 计数 + 上次结果。
func (s *Server) hAdminPatrolStatus(w http.ResponseWriter, r *http.Request) {
	cnt, err := s.st.CountAIRank()
	if err != nil {
		log500(s, w, err, "数巡逻榜")
		return
	}
	set, _ := s.st.Settings()
	snap := map[string]string{}
	for _, k := range []string{"patrol_enabled", "patrol_interval_hours", "patrol_batch_size",
		"patrol_repoll_days", "patrol_keywords", "patrol_max_entries", "patrol_last_run", "patrol_last_result"} {
		snap[k] = set[k]
	}
	s.patrolRun.mu.Lock()
	running, since := s.patrolRun.running, s.patrolRun.startAt
	s.patrolRun.mu.Unlock()
	s.jsonOK(w, map[string]any{
		"settings":      snap,
		"counts":        cnt,
		"running":       running,
		"running_since": since.Unix(),
		"llm_ready":     s.cfg.LLMKey != "",
		"llm_search":    s.cfg.LLMSearch,
		"amap_ready":    s.cfg.AmapKey != "",
		"model":         s.cfg.LLMModel,
	})
}

// hAdminPatrolRun 立即巡逻。body {shops:["店名"...]}：点名鉴店（≤12 家，同步等判决，
// 单店给个前端能直接刷新的体验）；空 body：按候选池异步跑一轮，接口立刻回。
func (s *Server) hAdminPatrolRun(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Shops []string `json:"shops"`
	}
	if err := decode(r, &b); err != nil {
		if strings.Contains(err.Error(), "请求体为空") {
			b.Shops = nil // 空 body = 整轮异步巡逻，合法
		} else {
			s.jsonErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	actor := actorFrom(r.Context())
	if len(b.Shops) > 0 {
		names := make([]string, 0, len(b.Shops))
		for _, n := range b.Shops {
			if n = strings.TrimSpace(n); n != "" {
				names = append(names, n)
			}
		}
		if len(names) == 0 {
			s.jsonErr(w, http.StatusBadRequest, "店名是空的")
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
		defer cancel()
		st, err := s.runPatrol(ctx, names)
		if err != nil {
			s.jsonErr(w, http.StatusBadGateway, "巡逻没跑成："+err.Error())
			return
		}
		s.auditAs(r, "patrol", actor.Label()+" 点名鉴店 "+strings.Join(names, ","))
		s.jsonOK(w, map[string]any{"mode": "sync", "stats": st})
		return
	}
	go func() {
		st, err := s.runPatrol(context.Background(), nil)
		if err != nil {
			log.Printf("patrol: 手动整轮巡逻失败: %v", err)
			return
		}
		log.Printf("patrol: 手动整轮巡逻收队：目标 %d 成 %d 败 %d", st.Target, st.Done, st.Failed)
	}()
	s.auditAs(r, "patrol", actor.Label()+" 触发整轮巡逻")
	s.jsonOK(w, map[string]any{"mode": "async", "hint": "巡逻在后台跑，刷「巡逻台账」看结果"})
}

// hAdminListAIRank 后台榜列表：可按 level/status 筛，带证据快照。
func (s *Server) hAdminListAIRank(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := pick(q.Get("status"), "active", "retired", "all")
	page, total, err := s.aiRankList(store.AIRankFilter{
		Status: status,
		Level:  strings.TrimSpace(q.Get("level")),
		Q:      strings.TrimSpace(q.Get("q")),
		Sort:   pick(q.Get("sort"), "rank", "score", "new", "patrol"),
		Page:   intQuery(q.Get("page"), 1, 10000),
		Size:   intQuery(q.Get("size"), 20, 100),
	})
	if err != nil {
		log500(s, w, err, "查巡逻榜(后台)")
		return
	}
	s.jsonOK(w, map[string]any{"items": page, "total": total})
}

// hAdminAIRankStatus 上架/下架。
func (s *Server) hAdminAIRankStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		s.jsonErr(w, http.StatusBadRequest, "id 不合法")
		return
	}
	var b struct {
		Status string `json:"status"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetAIRankStatus(id, b.Status); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "判决不存在")
			return
		}
		log500(s, w, err, "改判决状态")
		return
	}
	if _, err := s.st.RebuildAIRanks(); err != nil {
		log.Printf("patrol: 下架后重排名次失败: %v", err)
	}
	s.jsonOK(w, map[string]any{"ok": true})
}

// hAdminAIRankDelete 删判例（清库用；平时下架留痕就够）。
func (s *Server) hAdminAIRankDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		s.jsonErr(w, http.StatusBadRequest, "id 不合法")
		return
	}
	if err := s.st.DeleteAIRank(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "判决不存在")
			return
		}
		log500(s, w, err, "删判决")
		return
	}
	s.jsonOK(w, map[string]any{"ok": true})
}

// hAdminAIRankPromote 晋升：把 AI 判决落成探店榜的一条 draft（走人工放行铁律）。
// 店档案没有就建（带 AI 判出的地址/菜系/人均，备注注明 AI 建档待核）；
// 幂等：已晋升过且草稿还在就直接回旧草稿，不重复塞。
func (s *Server) hAdminAIRankPromote(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		s.jsonErr(w, http.StatusBadRequest, "id 不合法")
		return
	}
	a, err := s.st.GetAIRank(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.jsonErr(w, http.StatusNotFound, "判决不存在")
			return
		}
		log500(s, w, err, "查判决")
		return
	}
	if a.PromotedID > 0 {
		if old, err := s.st.GetReviewByID(a.PromotedID); err == nil {
			s.jsonOK(w, map[string]any{"existed": true, "review_id": old.ID, "slug": old.Slug,
				"hint": "这家已经晋升过，草稿还在点评列表"})
			return
		}
		// 旧草稿被删了：复位后允许重进。
	}
	shopID, err := s.ensureShopForPromote(a)
	if err != nil {
		log500(s, w, err, "晋升建档")
		return
	}
	score5 := a.Score / 2
	dish := a.ShopName
	if len(a.Dishes) > 0 {
		dish = a.Dishes[0]
	}
	headline := a.Judge
	if headline == "" {
		headline = "AI 巡逻判决：" + store.LevelLabel(a.Level)
	}
	body := buildPromoteBody(a)
	rv := &store.Review{
		Slug:     store.NewSlug("ai"),
		ShopID:   shopID,
		Dish:     dish,
		Tier:     store.TierFromScore(a.Score, a.Level),
		Score:    score5,
		Price:    a.AvgPrice,
		Headline: headline,
		Body:     body,
		Status:   "draft",
		Kind:     store.KindTandian,
		Wheel:    false,
	}
	if err := s.st.SaveReview(rv, nil); err != nil {
		log500(s, w, err, "晋升建草稿")
		return
	}
	if err := s.st.SetAIRankPromoted(a.ID, rv.ID); err != nil {
		log.Printf("patrol: 记晋升痕迹失败(%d): %v", a.ID, err)
	}
	actor := actorFrom(r.Context())
	s.auditAs(r, "patrol-promote", fmt.Sprintf("%s 晋升「%s」→ 草稿 %s", actor.Label(), a.ShopName, rv.Slug))
	s.jsonOK(w, map[string]any{"review_id": rv.ID, "slug": rv.Slug,
		"hint": "草稿已进点评列表：辣条妹核实/改写后点发布，没放行它进不了探店榜"})
}

// ensureShopForPromote 找到同名店档案就复用；没有就按 AI 证据建一档。
func (s *Server) ensureShopForPromote(a *store.AIRank) (int64, error) {
	page, err := s.st.ListShops(a.City, a.ShopName, "", 1, 20)
	if err != nil {
		return 0, err
	}
	if page != nil {
		for _, sh := range page.Items {
			if sh.Name == a.ShopName {
				return sh.ID, nil
			}
		}
	}
	sh := &store.Shop{
		Slug:     store.NewSlug("s"),
		Name:     a.ShopName,
		City:     a.City,
		District: a.District,
		Address:  a.Address,
		Cuisine:  a.Cuisine,
		AvgPrice: a.AvgPrice,
		Note:     "AI 巡逻晋升时自动建档（地址/人均来自风评证据，未实地核对）",
	}
	if err := s.st.SaveShop(sh); err != nil {
		return 0, err
	}
	return sh.ID, nil
}

// buildPromoteBody 把 AI 判决拼成草稿正文：人审时辣条妹看到全貌。
func buildPromoteBody(a *store.AIRank) string {
	var sb strings.Builder
	sb.WriteString("【这条是 AI 巡逻晋升稿，未经本人实地验证，发布前必须自己吃一遍】\n\n")
	if a.Summary != "" {
		sb.WriteString("AI 风评综述：" + a.Summary + "\n\n")
	}
	sb.WriteString(fmt.Sprintf("AI 判决：%s（%.1f/10，把握 %.0f%%）｜终审：%s\n",
		store.LevelLabel(a.Level), a.Score, a.Confidence*100, a.Judge))
	if a.Advice != "" {
		sb.WriteString("建议：" + a.Advice + "\n")
	}
	if len(a.Signals) > 0 {
		sb.WriteString("\n信号：\n")
		for _, sg := range a.Signals {
			sb.WriteString(fmt.Sprintf("- %s：%s%s\n", sg.K, signMark(sg.Good), sg.V))
		}
	}
	if len(a.Platforms) > 0 {
		sb.WriteString("\n各平台盘查：\n")
		for _, pf := range a.Platforms {
			sb.WriteString(fmt.Sprintf("- %s：%s%s\n", pf.K, signMark(pf.Good), pf.V))
		}
	}
	if a.AmapNote != "" {
		sb.WriteString("\n高德到店：" + a.AmapNote + "\n")
	}
	if len(a.Sources) > 0 {
		sb.WriteString("采信源：" + strings.Join(a.Sources, "、") + "\n")
	}
	sb.WriteString(fmt.Sprintf("\n（巡逻批次 %s，判于 %s）", a.PatrolBatch,
		time.Unix(a.LastPatrolAt, 0).Format("2006-01-02 15:04")))
	return sb.String()
}

func signMark(g int) string {
	switch {
	case g > 0:
		return "〔正面〕"
	case g < 0:
		return "〔负面〕"
	}
	return "〔中性〕"
}

// aiRankList 公共查询：列表接口统一抹证据快照，空列表回 [] 不回 null。
func (s *Server) aiRankList(f store.AIRankFilter) ([]store.AIRank, int64, error) {
	items, total, err := s.st.ListAIRanks(f)
	if err != nil {
		return nil, 0, err
	}
	if items == nil {
		items = []store.AIRank{}
	}
	for i := range items {
		items[i].Evidence = ""
	}
	return items, total, nil
}

func patrolLastRun(s *Server) int64 {
	n, _ := strconv.ParseInt(s.st.Setting("patrol_last_run"), 10, 64)
	return n
}

func levelMetas() []map[string]any {
	return []map[string]any{
		{"code": "solid", "label": "靠谱", "desc": "多平台风评一致好，到店信号硬"},
		{"code": "foggy", "label": "有水分", "desc": "吹得凶但风评掺水，去之前谨慎"},
		{"code": "bust", "label": "不建议", "desc": "坐实差评为主，AI 举牌劝退"},
		{"code": "unknown", "label": "没底细", "desc": "全网扒不到实质风评，AI 不装懂"},
	}
}
