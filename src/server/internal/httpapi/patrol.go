package httpapi

// ============================================================
// AI 巡逻（v14）：定时互联网巡逻 → 逐店风评判决 → 独立「AI 客观榜」。
//
// 三条设计红线（跟辣条妹的铁律对齐）：
//  1. 纯 AI 产物不进探店榜。巡逻判决只落 ai_rank 表，前端独立分区、
//     必带「未经本人实地验证」免责标；要进探店榜必须 promote 成
//     reviews draft，走人工放行。机器只有提案权。
//  2. 不硬编数据源。抖音/小红书/点评全是强反爬，自爬必死（鉴店 skill
//     已定论）；盘风评这一路继续走通义 enable_search 检索管线，锚点是
//     高德官方 POI（评分/人均/扫街榜=真实到店信号，抗刷）。
//  3. 成本可控。每轮只鉴 patrol_batch_size 家、间隔 patrol_interval_hours
//     小时、判过 patrol_repoll_days 天内不重判、榜满 patrol_max_entries
//     不再吸新（转为重判最旧的）。全部走 settings，后台可拨。
//
// 候选店从哪来：高德关键词发现（真实在案的店，模型报的名不敢信）。
// 证据三条腿：高德 POI（锚）× LLM 联网检索（各平台风评）× 辣条妹本人
// 实记（库存里踩过的店直接引用她的判词当第一手证据）。
// ============================================================

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"latiaomei/internal/amap"
	"latiaomei/internal/store"
)

// patrolRunState 巡逻互斥状态：同一进程只允许一轮在跑（定时器和手动共用）。
type patrolRunState struct {
	mu      sync.Mutex
	running bool
	startAt time.Time
}

func (s *Server) patrolLock() (release func(), ok bool) {
	st := s.patrolRun
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.running {
		return nil, false
	}
	st.running = true
	st.startAt = time.Now()
	return func() {
		st.mu.Lock()
		st.running = false
		st.mu.Unlock()
	}, true
}

// patrolTarget 一个巡逻目标：店名 + （可选）高德发现时带回的 POI。
type patrolTarget struct {
	Name string
	POI  *amap.POI
}

// ---- 判决 prompt ----

const patrolJSONSchema = `{"shop":"店名","known":true,"level":"solid|foggy|bust|unknown","score":7.5,` +
	`"confidence":0.6,"judge":"≤20字一句话终审","advice":"≤50字怎么点防翻车或勝退理由",` +
	`"summary":"80-150字风评综述","signals":[{"k":"信号名","v":"结论≤40字","good":1}],` +
	`"platforms":[{"name":"平台名","v":"≤30字表现","good":0}],` +
	`"dishes":["被网友点名的菜"],"sources":["本次采信的数据源名"]}`

const patrolSystemPrompt = `你是「辣条妹的御膳房」（杭州美食 IP）的 AI 巡逻判官。你是中立第三方：
不隶属任何店家、不收任何好处、不代表任何人的利益。你的唯一任务：把一家杭州餐馆在全网的真实风评
盘清楚，给出一份要负责任的判决。你判的是风评，不是味道——味道只有辣条妹本人吃过才有资格判。

判分口径（0-10 分）：
- 8.0 以上：多平台口碑一致好评，且到店信号硬（高德评分高/入选扫街榜=真实导航到店回头客）。
- 6.5-7.9：整体好评为主，有些争议点（高峰等位久、个别菜不稳定）。level=solid。
- 4.5-6.9 或 口碑明显掺水（吹得凶但差评扎堆、文案腔好评集中爆发）：level=foggy，judge 里点破水分在哪。
- ≤4.4：坐实的差评为主（难吃/宰客/卫生/货不对板），level=bust。
- 查不到实质风评：level=unknown，known=false，confidence 给 0.2 以下，judge 直说没底细。绝不硬编。

铁规：
1. 绝不编具体数字。没在检索结果里亲眼见到的「多少条评价/几分/多少粉丝」一律不许写；
   看不到数量就定性描述（「近期差评集中在上菜慢」）。平台查不到就在 platforms.v 写「没见过可靠信息」good=0。
2. signals 必须 3-6 条，至少覆盖：评论分布、刷单/水分检测、差评聚焦点。
3. platforms 必须盖满：大众点评、美团、小红书、抖音、高德（扫街榜/评分）。知乎/微博搜到了就加。
4. 语言：中文，市井、直接、毒舌但公道；禁绝对化用语（「全杭州最好吃」这种）。
5. 只输出一个严格 JSON 对象，不要 markdown 围栏，不要 JSON 外的任何文字。输出结构：
` + patrolJSONSchema

// patrolUserPrompt 拼巡逻请求的用户消息：目标店 + 已备好的证据。
func patrolUserPrompt(name, city, evidence string) string {
	var sb strings.Builder
	sb.WriteString("【判这店】" + city + " · " + name + "\n")
	if evidence != "" {
		sb.WriteString("【服务端已查到的硬证据】（到店数据比检索风评权重高，风评与它对不上时优先信它）\n" + evidence + "\n")
	}
	sb.WriteString("现在开联网检索去盘这家店在各平台的真实风评，按规矩出 JSON 判决。")
	return sb.String()
}

// ---- 单店判决 ----

// patrolOne 对一家店出 AI 判决并落库。poi 可空（手动点判时按店名现查高德缓存/接口）。
func (s *Server) patrolOne(ctx context.Context, t patrolTarget, city string) (*store.AIRank, error) {
	name := strings.TrimSpace(t.Name)
	if name == "" {
		return nil, errors.New("空店名")
	}
	// 1) 高德证据：发现阶段带来的 POI 顺手落缓存；没有就查（缓存 7 天 TTL 自动生效）。
	amapNote := ""
	if t.POI != nil {
		if b, err := json.Marshal(t.POI); err == nil && s.cfg.AmapKey != "" {
			_ = s.st.PutAmapPOI(city, name, store.AmapPOICache{
				Name: name, Info: string(b), FetchedAt: time.Now().Unix(),
			})
		}
		amapNote = poiNote(t.POI)
	} else {
		amapNote = s.agentAmapNote(ctx, name, true)
	}
	// 2) 辣条妹本人实记：库存里踩过的店，她的判词是第一手证据，AI 不许大过它。
	ownNote := s.patrolOwnNotes(ctx, name)
	// 3) 组 prompt 调 LLM（联网检索开不开由 LLMSearch；关了就只能靠注入证据判）。
	var ev strings.Builder
	if amapNote != "" {
		ev.WriteString("- 高德到店：" + amapNote + "\n")
	} else {
		ev.WriteString("- 高德到店：没查到这家店的官方 POI，照实说，别编。\n")
	}
	if ownNote != "" {
		ev.WriteString("- 辣条妹本人实记（她亲自吃过，引用时注明「本人实探」）：\n" + ownNote)
	}
	sys := patrolSystemPrompt
	if s.cfg.LLMSearch {
		sys += "\n【联网】本条已开检索：大众点评/美团/小红书/抖音/知乎/微博/高德上关于这店的风评你能搜到就引用并标进 sources；搜不到照实说没见过可靠信息，绝不编。"
	} else {
		sys += "\n【离线】本条没开联网检索：只许依据消息里注入的证据判决，证据不够就 level=unknown，不要脑补平台风评。"
	}
	msgs := []map[string]string{
		{"role": "system", "content": sys},
		{"role": "user", "content": patrolUserPrompt(name, city, ev.String())},
	}
	raw, err := s.llmChatOpts(ctx, msgs, 0.3, 1800, s.cfg.LLMSearch && s.cfg.LLMKey != "")
	if err != nil {
		return nil, fmt.Errorf("LLM：%w", err)
	}
	a, err := parsePatrolVerdict(raw, name, city)
	if err != nil {
		return nil, err
	}
	a.AmapNote = amapNote
	a.Evidence = trimRunes(ev.String(), 2000)
	a.PatrolBatch = time.Now().Format("20060102-1504")
	if err := s.st.UpsertAIRank(a); err != nil {
		return nil, fmt.Errorf("落库：%w", err)
	}
	return a, nil
}

// patrolOwnNotes 库存匹配：这家店辣条妹踩过哪些菜，压成证据行。
func (s *Server) patrolOwnNotes(ctx context.Context, name string) string {
	page, err := s.st.ListShops("", name, "", 1, 20)
	if err != nil || page == nil {
		return ""
	}
	var shopID int64
	for _, sh := range page.Items {
		if sh.Name == name {
			shopID = sh.ID
			break
		}
	}
	if shopID == 0 {
		return ""
	}
	rvs, err := s.st.ListReviews(store.ReviewFilter{Status: "published", ShopID: shopID, Sort: "score", Size: 10})
	if err != nil || rvs == nil || len(rvs.Items) == 0 {
		return ""
	}
	var lines []string
	for _, rv := range rvs.Items {
		lines = append(lines, fmt.Sprintf("  %s｜%s档 %.1f分｜%s",
			rv.Dish, rv.TierLabel, rv.Score, trimRunes(rv.Headline, 40)))
	}
	return strings.Join(lines, "\n") + "\n"
}

// parsePatrolVerdict 从模型回包抠 JSON 并清洗成 AIRank。
// 模型偶尔会包围栏/说废话：取第一个 { 到最后一个 }；清洗时逐字段钳位。
func parsePatrolVerdict(raw, name, city string) (*store.AIRank, error) {
	i, j := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if i < 0 || j <= i {
		return nil, fmt.Errorf("回包里没有 JSON：%s", trimRunes(raw, 80))
	}
	var v struct {
		Shop       string  `json:"shop"`
		Known      *bool   `json:"known"`
		Level      string  `json:"level"`
		Score      float64 `json:"score"`
		Confidence float64 `json:"confidence"`
		Judge      string  `json:"judge"`
		Advice     string  `json:"advice"`
		Summary    string  `json:"summary"`
		Signals    []struct {
			K    string `json:"k"`
			V    string `json:"v"`
			Good *int   `json:"good"`
		} `json:"signals"`
		Platforms []struct {
			Name string `json:"name"`
			V    string `json:"v"`
			Good *int   `json:"good"`
		} `json:"platforms"`
		Dishes  []string `json:"dishes"`
		Sources []string `json:"sources"`
	}
	if err := json.Unmarshal([]byte(raw[i:j+1]), &v); err != nil {
		return nil, fmt.Errorf("JSON 解析失败：%v", err)
	}
	a := &store.AIRank{
		City: city,
		// 店名永远以巡逻目标为准：模型偶尔会回一个相近但不一样的名（甚至编名），
		// 直接采信会把判例挂到不存在的店上。模型回的只用来对得上时互验。
		ShopName:   name,
		Level:      strings.ToLower(cleanText(v.Level, 12)),
		Score:      math.Round(math.Max(0, math.Min(10, v.Score))*10) / 10,
		Confidence: math.Round(math.Max(0, math.Min(1, v.Confidence))*100) / 100,
		Judge:      cleanText(v.Judge, 60),
		Advice:     cleanText(v.Advice, 100),
		Summary:    cleanText(v.Summary, 400),
	}
	if !store.ValidALevel(a.Level) {
		a.Level = "unknown"
	}
	// 模型回的名对不上巡逻目标时留痕在 judge 前缀，但不改店名（防挂错店）。
	if mn := cleanText(v.Shop, 30); mn != "" && mn != name && !strings.Contains(mn, name) && !strings.Contains(name, mn) {
		a.Judge = "〔AI回名:" + trimRunes(mn, 20) + "〕" + a.Judge
	}
	// 没把握的判决不许冒充高分：known=false 一律按 unknown 处理。
	if v.Known != nil && !*v.Known {
		a.Level = "unknown"
		if a.Confidence > 0.2 {
			a.Confidence = 0.2
		}
	}
	for _, sg := range v.Signals {
		k, t := cleanText(sg.K, 20), cleanText(sg.V, 80)
		if k == "" || t == "" {
			continue
		}
		a.Signals = append(a.Signals, store.AIRankSignal{K: k, V: t, Good: clampSign(sg.Good)})
		if len(a.Signals) >= 6 {
			break
		}
	}
	for _, pf := range v.Platforms {
		k, t := cleanText(pf.Name, 14), cleanText(pf.V, 60)
		if k == "" || t == "" {
			continue
		}
		a.Platforms = append(a.Platforms, store.AIRankSignal{K: k, V: t, Good: clampSign(pf.Good)})
		if len(a.Platforms) >= 7 {
			break
		}
	}
	for _, d := range v.Dishes {
		if d = cleanText(d, 30); d != "" {
			a.Dishes = append(a.Dishes, d)
		}
		if len(a.Dishes) >= 8 {
			break
		}
	}
	for _, src := range v.Sources {
		if src = cleanText(src, 20); src != "" {
			a.Sources = append(a.Sources, src)
		}
		if len(a.Sources) >= 10 {
			break
		}
	}
	if len(a.Signals) < 2 && a.Level != "unknown" {
		// 证据不足三条信号的「有把握判决」不可信，降级。
		a.Level = "unknown"
		a.Confidence = math.Min(a.Confidence, 0.2)
	}
	return a, nil
}

func clampSign(g *int) int {
	if g == nil {
		return 0
	}
	switch {
	case *g > 0:
		return 1
	case *g < 0:
		return -1
	}
	return 0
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func poiNote(p *amap.POI) string {
	if p == nil {
		return ""
	}
	var bits []string
	if p.Name != "" {
		bits = append(bits, "高德在案："+p.Name)
	}
	if r := strings.TrimSpace(p.Rating); r != "" && r != "0" {
		bits = append(bits, "高德评分"+r)
	}
	if c := strings.TrimSpace(p.Cost); c != "" && c != "0" {
		bits = append(bits, "人均"+c+"元")
	}
	if p.District != "" || p.BizArea != "" {
		bits = append(bits, strings.Trim(p.District+" "+p.BizArea, " "))
	}
	if p.ScanRanked {
		bits = append(bits, "★扫街榜:检出入选痕迹")
	} else {
		bits = append(bits, "扫街榜:未见入选痕迹")
	}
	return trimRunes(strings.Join(bits, " | "), 220)
}

// ---- 候选发现 ----

// patrolTargets 组一轮巡逻的目标池：
//   - 优先新店（高德关键词发现，跳过判过/库存已有的），按高德分降序；
//   - 新店不够且榜单未封顶：凑多少算多少；
//   - 榜单已满：转为重判在榜最旧的 active 店（风评会过时，旧判例要翻新）。
func (s *Server) patrolTargets(ctx context.Context, need int) ([]patrolTarget, error) {
	city := s.cfg.AmapCity
	if city == "" {
		city = "杭州"
	}
	repollDays := s.settingInt("patrol_repoll_days", 30, 1, 365)
	known, err := s.st.KnownAIRankNames(repollDays)
	if err != nil {
		return nil, err
	}
	skip := map[string]bool{}
	page, err := s.st.ListShops(city, "", "", 1, 200)
	if err == nil && page != nil {
		for _, sh := range page.Items {
			skip[sh.Name] = true // 她踩过的店探店榜有真话，巡逻先去啃没吃过的
		}
	}
	var out []patrolTarget
	if s.cfg.AmapKey != "" {
		cli := &amap.Client{Key: s.cfg.AmapKey, Base: s.cfg.AmapBase, City: city}
		var found []amap.POI
		for _, kw := range splitList(s.st.Setting("patrol_keywords")) {
			if kw == "" {
				continue
			}
			pois, err := cli.Discover(ctx, kw, 15)
			if err != nil {
				log.Printf("patrol: 高德发现(%s)失败: %v", kw, err)
				continue // 一个关键词断了不拦整轮
			}
			for _, p := range pois {
				n := strings.TrimSpace(p.Name)
				if n == "" || known[n] || skip[n] || len([]rune(n)) > 30 {
					continue
				}
				found = append(found, p)
			}
		}
		// 高德评分降序：先啃有真实到店信号的热店；评分空的排后面。
		sort.SliceStable(found, func(i, j int) bool {
			return amapRatingNum(found[i].Rating) > amapRatingNum(found[j].Rating)
		})
		uniq := map[string]bool{}
		for _, p := range found {
			if uniq[p.Name] {
				continue
			}
			uniq[p.Name] = true
			pp := p
			out = append(out, patrolTarget{Name: pp.Name, POI: &pp})
			if len(out) >= need {
				return out, nil
			}
		}
	}
	// 无高德/没发现到新店的兜底：轮值鉴站内店铺档案里的店（AI 盘的是全网公开风评，
	// 与她本人实探的探店榜互不污染；settings patrol_fallback_own=0 可关）。
	if len(out) < need && s.st.Setting("patrol_fallback_own") != "0" {
		if sp, err := s.st.ListShops(city, "", "", 1, 200); err == nil && sp != nil && len(sp.Items) > 0 {
			have := map[string]bool{}
			for _, o := range out {
				have[o.Name] = true
			}
			start := dailyIndex(s.st.Now().Format("2006-01-02")) % len(sp.Items)
			for i := range sp.Items {
				sh := sp.Items[(start+i)%len(sp.Items)]
				n := strings.TrimSpace(sh.Name)
				if n == "" || known[n] || have[n] {
					continue
				}
				out = append(out, patrolTarget{Name: n})
				if len(out) >= need {
					break
				}
			}
		}
	}
	// 新店不够：榜单没满就有多少算多少；满了就重判最旧的。
	if len(out) < need {
		cnt, _ := s.st.CountAIRank()
		maxN := s.settingInt("patrol_max_entries", 200, 10, 2000)
		if active, _ := cnt["active"].(int64); active >= int64(maxN) {
			old, _, err := s.st.ListAIRanks(store.AIRankFilter{Status: "active", Sort: "patrol", Size: need - len(out)})
			if err == nil {
				for i := range old {
					out = append(out, patrolTarget{Name: old[i].ShopName})
				}
			}
		}
	}
	return out, nil
}

func amapRatingNum(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return f
}

// ---- 巡逻执行 ----

type patrolStats struct {
	Target  int      `json:"target"`
	Done    int      `json:"done"`
	Failed  int      `json:"failed"`
	Names   []string `json:"names,omitempty"`
	Errors  []string `json:"errors,omitempty"`
	Elapsed string   `json:"elapsed"`
}

// runPatrol 跑一轮巡逻（同步执行；调用方决定是后台 goroutine 还是接口内等）。
// explicit 非空 = 点名鉴店（手动触发，上限 12 防接口被人当机枪使）。
func (s *Server) runPatrol(ctx context.Context, explicit []string) (patrolStats, error) {
	release, ok := s.patrolLock()
	if !ok {
		return patrolStats{}, errors.New("上一轮巡逻还在跑，稍后再触发")
	}
	defer release()
	if s.cfg.LLMKey == "" {
		return patrolStats{}, errors.New("未配置 LATIAOMEI_LLM_API_KEY，巡逻开不了")
	}
	city := s.cfg.AmapCity
	if city == "" {
		city = "杭州"
	}
	var targets []patrolTarget
	if len(explicit) > 0 {
		for _, n := range explicit {
			n = strings.TrimSpace(n)
			if n != "" {
				targets = append(targets, patrolTarget{Name: n})
			}
			if len(targets) >= 12 {
				break
			}
		}
	} else {
		need := s.settingInt("patrol_batch_size", 5, 1, 20)
		t, err := s.patrolTargets(ctx, need)
		if err != nil {
			return patrolStats{}, err
		}
		targets = t
	}
	st := patrolStats{Target: len(targets)}
	if len(targets) == 0 {
		st.Elapsed = "0s"
		s.recordPatrol(st, "没有可巡逻的候选店（高德没配/全都判过）")
		return st, nil
	}
	begin := time.Now()
	for i, t := range targets {
		if ctx.Err() != nil {
			break
		}
		a, err := s.patrolOne(ctx, t, city)
		if err != nil {
			st.Failed++
			st.Errors = append(st.Errors, trimRunes(t.Name+"："+err.Error(), 80))
			log.Printf("patrol: 鉴店失败(%s): %v", t.Name, err)
		} else {
			st.Done++
			st.Names = append(st.Names, a.ShopName)
			log.Printf("patrol: %s → %s %.1f分（把握 %.0f%%）", a.ShopName, a.Level, a.Score, a.Confidence*100)
		}
		if i < len(targets)-1 {
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second): // 歇口，别把外网接口打太急
			}
		}
	}
	if n, err := s.st.RebuildAIRanks(); err != nil {
		log.Printf("patrol: 重排名次失败: %v", err)
	} else {
		_ = n
	}
	st.Elapsed = time.Since(begin).Round(time.Second).String()
	s.recordPatrol(st, "")
	return st, nil
}

// recordPatrol 把轮次结果落 settings，后台/概览可见「上次巡逻」。
func (s *Server) recordPatrol(st patrolStats, note string) {
	summary := fmt.Sprintf("目标%d 成功%d 失败%d 耗时%s", st.Target, st.Done, st.Failed, st.Elapsed)
	if note != "" {
		summary += "｜" + note
	}
	if len(st.Errors) > 0 {
		summary += "｜首错:" + st.Errors[0]
	}
	_ = s.st.SaveSettings(map[string]string{
		"patrol_last_run":    strconv.FormatInt(time.Now().Unix(), 10),
		"patrol_last_result": trimRunes(summary, 300),
	})
}

// settingInt 读 settings 里的整数项，脏值/越界回落默认并钳位。
func (s *Server) settingInt(key string, def, lo, hi int) int {
	n, err := strconv.Atoi(strings.TrimSpace(s.st.Setting(key)))
	if err != nil || n < lo || n > hi {
		return def
	}
	return n
}

// ---- 定时调度 ----

// StartPatrolLoop 起后台巡逻调度：每 10 分钟醒一次，检查开关与间隔；到点跑一轮。
// 间隔与开关都读 settings（patrol_interval_hours / patrol_enabled），拨开关不用重启。
func (s *Server) StartPatrolLoop(ctx context.Context) {
	go func() {
		// 启动后先等 90 秒：让服务过热身、日志归位，也避免重启风暴连环巡逻。
		timer := time.NewTimer(90 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				s.maybeScheduledPatrol(ctx)
				timer.Reset(10 * time.Minute)
			}
		}
	}()
}

func (s *Server) maybeScheduledPatrol(ctx context.Context) {
	if s.cfg.LLMKey == "" || s.st.Setting("patrol_enabled") != "1" {
		return
	}
	interval := s.settingInt("patrol_interval_hours", 24, 1, 168)
	last, _ := strconv.ParseInt(s.st.Setting("patrol_last_run"), 10, 64)
	if time.Now().Unix()-last < int64(interval)*3600 {
		return
	}
	st, err := s.runPatrol(ctx, nil)
	if err != nil {
		log.Printf("patrol: 定时巡逻没跑成: %v", err)
		return
	}
	log.Printf("patrol: 定时巡逻收队：目标 %d，判成 %d，败 %d", st.Target, st.Done, st.Failed)
}
