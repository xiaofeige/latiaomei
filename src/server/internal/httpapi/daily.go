// 辣条妹日报（v15）：每天自动生成一篇「今日判决 + 碎碎念」挂上首页。
//
// 为什么要有它：站点内容以前只在辣条妹手动发探店/菜谱时才动，访客来了看到的
// 是同一张脸同一份榜，回访动力弱。日报把已有的存量素材（探店榜、御膳房菜谱、
// AI 巡逻风评榜、许愿池呼声）按天轮值重新组合成「今日新内容」，再让 LLM 用
// 辣条妹口吻写两句——素材全部是站内已人审放行的数据，LLM 只做改写，不引入
// 任何未授权的外部平台内容；LLM 挂了自动落回纯模板，日报永不断更。
//
// 调度：StartDailyLoop 每 20 分钟醒一次，发现今天还没有日报就补一篇。
// 拨 settings 里的 daily_brief_enabled=0 可整体关停（默认开）。
// 站长后台改写过的（source=manual）当天不再被引擎覆盖。
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"latiaomei/internal/store"
)

// hDaily GET /api/daily?limit=14 —— 今日日报 + 往期回顾。
// 兜底：极端情况下（比如服务刚迁移完还没跑到定时器）当天没有日报，
// 这里同步补一篇模板版，保证前台首页永远有「今天」的东西可看。
func (s *Server) hDaily(w http.ResponseWriter, r *http.Request) {
	limit := intQuery(r.URL.Query().Get("limit"), 14, 60)
	today := s.st.Now().Format("2006-01-02")
	b, err := s.st.GetDailyBrief(today)
	if err == store.ErrNotFound {
		b = s.ensureDailyBrief(r.Context(), today)
	} else if err != nil {
		log500(s, w, err, "查日报")
		return
	}
	list, err := s.st.ListDailyBriefs(limit)
	if err != nil {
		log500(s, w, err, "查日报往期")
		return
	}
	s.jsonOK(w, map[string]any{"today": b, "list": orEmpty(list)})
}

// hAdminDailyRun POST /api/admin/daily/run —— 后台手动重生成今天的日报（force）。
func (s *Server) hAdminDailyRun(w http.ResponseWriter, r *http.Request) {
	today := s.st.Now().Format("2006-01-02")
	b, err := s.generateDailyBrief(r.Context(), today, true)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, "日报没生成出来："+err.Error())
		return
	}
	s.jsonOK(w, b)
}

// hAdminDailySave POST /api/admin/daily —— 站长手改今天（或指定日期）的日报。
// 手改后 source=manual，引擎当天不再覆盖。
func (s *Server) hAdminDailySave(w http.ResponseWriter, r *http.Request) {
	var b store.DailyBrief
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "body 得是日报 JSON")
		return
	}
	if b.Date == "" {
		b.Date = s.st.Now().Format("2006-01-02")
	}
	b.Source = "manual"
	b.Verdict = clipRunes(strings.ReplaceAll(b.Verdict, "\n", ""), 30)
	b.Blurb = clipRunes(strings.ReplaceAll(b.Blurb, "\n", " "), 160)
	if err := s.st.SaveDailyBrief(&b, true); err != nil {
		log500(s, w, err, "存日报")
		return
	}
	s.jsonOK(w, b)
}

// ---- 生成引擎 ----

// ensureDailyBrief 当天缺报时同步补一篇（先模板保底入库，再尝试 LLM 润色覆盖）。
// 并发放行到前台——内容源都是已审核素材，不涉及流水线的外部发布铁律。
func (s *Server) ensureDailyBrief(ctx context.Context, today string) *store.DailyBrief {
	b, err := s.generateDailyBrief(ctx, today, false)
	if err != nil {
		log.Printf("daily: 补日报失败(%s): %v", today, err)
		return &store.DailyBrief{Date: today, Verdict: "今天先转个盘，想吃什么转出来", Source: "fallback"}
	}
	return b
}

// generateDailyBrief 组一份日报。force=true 时连 manual 也覆盖（后台点「重生成」）。
// LLM 可用则润色 verdict/blurb，禁用/失败则落回模板（source=fallback）。
func (s *Server) generateDailyBrief(ctx context.Context, today string, force bool) (*store.DailyBrief, error) {
	b := s.dailyDraft(ctx, today)
	if s.cfg.LLMKey != "" && s.st.Setting("daily_brief_llm") != "0" {
		if v, blurb, ok := s.dailyPolish(ctx, b); ok {
			b.Verdict, b.Blurb = v, blurb
			b.Source = "auto"
		} else {
			b.Source = "fallback"
		}
	} else {
		b.Source = "fallback"
	}
	if err := s.st.SaveDailyBrief(b, force); err != nil {
		return nil, err
	}
	return b, nil
}

// dailyDraft 纯数据拼图：今日主角（探店/御膳房按日期轮值）+ 巡逻榜头条 + 许愿池花絮。
// 轮值用 dayOfYear 取模，同一天跑多少次结果一致，日报不会下午晚上两张皮。
func (s *Server) dailyDraft(ctx context.Context, today string) *store.DailyBrief {
	doy := dailyIndex(today)
	b := &store.DailyBrief{Date: today, Tier: "hang", Links: []store.DailyLink{}}

	// 今日主角：探店榜轮值一家「夯/顶级」的（排序权重好的店先被翻牌）。
	if page, err := s.st.ListReviews(store.ReviewFilter{
		Status: "published", Kind: "tandian", Sort: "rank", Size: 60,
	}); err == nil && page != nil && len(page.Items) > 0 {
		items := page.Items
		r := items[doy%len(items)]
		b.Shop, b.Dish, b.Tier, b.Slug = shopNameOf(r), r.Dish, r.Tier, r.Slug
		b.Verdict = dailyVerdictByTier(r.TierLabel)
		b.Blurb = fmt.Sprintf("今天翻到「%s」的%s——辣条尺 %s 分，%s。%s",
			b.Shop, b.Dish, fmtScore(r.Score), r.TierLabel, firstNonEmpty(r.OrderTip, r.Headline))
		b.Links = append(b.Links, store.DailyLink{Label: "看这条探店", Href: "/review/" + r.Slug})
	}

	// 今日灶台：御膳房轮值一道她亲手做的。
	if page, err := s.st.ListReviews(store.ReviewFilter{
		Status: "published", Kind: "yushanfang", Sort: "new", Size: 30,
	}); err == nil && page != nil && len(page.Items) > 0 {
		y := page.Items[doy%len(page.Items)]
		b.Links = append(b.Links, store.DailyLink{
			Label: "今日灶台 · " + y.Dish, Href: "/review/" + y.Slug})
	}

	// 巡逻榜头条：ai_rank 榜首一句话风评（引擎每日巡逻的产物，天天可能在变）。
	if ranks, _, err := s.st.ListAIRanks(store.AIRankFilter{Status: "active", Sort: "rank", Size: 1}); err == nil && len(ranks) > 0 {
		a := ranks[0]
		if a.Judge != "" {
			b.Links = append(b.Links, store.DailyLink{
				Label: "AI 巡逻榜首 · " + a.ShopName + "：" + a.Judge, Href: "/ai-rank"})
		}
	}

	// 许愿池花絮：呼声最高的新许愿。
	if ws, err := s.st.ListWishes("new", 1); err == nil && len(ws) > 0 {
		b.Links = append(b.Links, store.DailyLink{
			Label: "有人在许愿池喊：" + clipRunes(ws[0].Content, 24), Href: "/taste"})
	}

	// 全空保底（刚 migrate 的新库）：给个能点的入口，首页日报条不空白。
	if b.Verdict == "" && len(b.Links) == 0 {
		b.Verdict = "菜还没排满，先转转今天的盘"
		b.Links = append(b.Links, store.DailyLink{Label: "去探店榜", Href: "/rank"})
	}
	if b.Blurb == "" {
		b.Blurb = "今天的日报是纯模板保底版。等辣条妹多踩几家店、巡逻榜多攒点风评，明天开始就有得唠了。"
	}
	return b
}

// dailyPolish 让 LLM 用辣条妹口吻重写「一句话判决 + 碎碎念」。
// 只喂站内素材原文，不带联网搜索（防它现编外部信息）；输出过禁词表与长度钳位。
func (s *Server) dailyPolish(ctx context.Context, b *store.DailyBrief) (string, string, bool) {
	var facts strings.Builder
	facts.WriteString("今日主角：" + b.Shop + " · " + b.Dish + "（判决 " + store.TierLabel(b.Tier) + "）\n")
	facts.WriteString("底稿：" + b.Verdict + " / " + b.Blurb + "\n")
	for _, l := range b.Links {
		facts.WriteString("花絮：" + l.Label + "\n")
	}
	msgs := []map[string]string{
		{"role": "system", "content": `你是杭州美食IP「辣条妹」的文案笔杆子，替她写每日日报的两段话。
口吻：本地老饕、泼辣直白、不恰饭、爱用「恰」「落胃」「条总」等杭嘉湖口头语，偶尔自嘲。
铁律：只许改写下面给出的站内素材，禁止编造店名、菜名、价格、评分。
只输出 JSON: {"verdict":"≤20字的今日一句话判决","blurb":"60-130字的今日碎碎念"}`},
		{"role": "user", "content": facts.String()},
	}
	raw, err := s.llmChat(ctx, msgs, 0.8, 400)
	if err != nil {
		log.Printf("daily: LLM 润色失败，落回模板: %v", err)
		return "", "", false
	}
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	var j struct {
		Verdict string `json:"verdict"`
		Blurb   string `json:"blurb"`
	}
	if err := json.Unmarshal([]byte(raw), &j); err != nil || j.Verdict == "" || j.Blurb == "" {
		return "", "", false
	}
	v := s.dailySanitize(clipRunes(strings.ReplaceAll(j.Verdict, "\n", ""), 30))
	bl := s.dailySanitize(clipRunes(strings.ReplaceAll(j.Blurb, "\n", " "), 160))
	if v == "" || bl == "" {
		return "", "", false // 禁词命中整段就弃用，宁要模板不要脏文案
	}
	return v, bl, true
}

// dailySanitize 日报文案消毒：命中回复禁词表就整段作废（返回空串）。
func (s *Server) dailySanitize(t string) string {
	for _, bad := range s.agentWordsGet().denyWords {
		if bad != "" && strings.Contains(t, bad) {
			return ""
		}
	}
	return t
}

func dailyVerdictByTier(label string) string {
	switch label {
	case "夯":
		return "今日判决：夯，闭眼冲"
	case "顶级":
		return "今日判决：顶级，值得专门排队"
	case "人上人":
		return "今日判决：人上人，落胃不踩雷"
	case "NPC":
		return "今日判决：NPC，平平无奇顺路恰"
	case "拉完了":
		return "今日判决：拉完了，快跑别去"
	default:
		return "今日判决：" + label
	}
}

// dailyIndex 日期序号（day-of-year），轮值取模用。
func dailyIndex(today string) int {
	t, err := time.Parse("2006-01-02", today)
	if err != nil {
		return int(time.Now().Unix()) % 97
	}
	return t.YearDay()
}

func fmtScore(f float64) string { return strings.TrimSuffix(fmt.Sprintf("%.1f", f), ".0") }

// shopNameOf 探店条目的店名；御膳房/无店关联时给个兜底称呼。
func shopNameOf(r store.Review) string {
	if r.Shop != nil && r.Shop.Name != "" {
		return r.Shop.Name
	}
	if r.Kind == "yushanfang" {
		return "御膳房灶台"
	}
	return "无名小馆"
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ---- 定时调度 ----

// StartDailyLoop 后台日报调度：启动 60 秒后补今天的第一篇，之后每 20 分钟
// 醒一次；跨过零点（或日报被关闭又重开、库被清过）都能自愈补上。
func (s *Server) StartDailyLoop(ctx context.Context) {
	go func() {
		timer := time.NewTimer(60 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				if s.st.Setting("daily_brief_enabled") != "0" {
					today := s.st.Now().Format("2006-01-02")
					if _, err := s.st.GetDailyBrief(today); err == store.ErrNotFound {
						if _, err := s.generateDailyBrief(ctx, today, false); err != nil {
							log.Printf("daily: 今日日报没生成: %v", err)
						} else {
							log.Printf("daily: 今日日报已上新（%s）", today)
						}
					}
				}
				timer.Reset(20 * time.Minute)
			}
		}
	}()
}

// ---- sitemap：每天现算，配合日报/巡逻的日更，搜索引擎收录才有新东西可抓 ----

func (s *Server) hSitemap(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimRight("https://"+s.cfg.Domain, "/")
	if s.cfg.Domain == "" {
		domain = "https://" + r.Host
	}
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n")
	addURL := func(loc, freq string, prio float64) {
		fmt.Fprintf(&sb, "  <url><loc>%s%s</loc><changefreq>%s</changefreq><priority>%.1f</priority></url>\n",
			domain, loc, freq, prio)
	}
	addURL("/", "daily", 1.0)
	addURL("/daily", "daily", 0.9)
	for _, p := range []string{"/rank", "/ai-rank", "/tandian", "/yushanfang", "/shops", "/taste", "/about"} {
		addURL(p, "weekly", 0.6)
	}
	if page, err := s.st.ListReviews(store.ReviewFilter{Status: "published", Kind: "all", Sort: "new", Size: 100}); err == nil && page != nil {
		for _, it := range page.Items {
			addURL("/review/"+it.Slug, "monthly", 0.7)
		}
	}
	if page, err := s.st.ListShops("", "", "", 1, 100); err == nil && page != nil {
		for _, sh := range page.Items {
			addURL("/shop/"+sh.Slug, "monthly", 0.5)
		}
	}
	sb.WriteString("</urlset>\n")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte(sb.String()))
}
