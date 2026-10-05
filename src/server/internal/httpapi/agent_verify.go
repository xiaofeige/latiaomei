package httpapi

// ============================================================
// 鉴店 skill（agent 的第二项「本事」）：用户问某家店靠谱吗、
// 会不会翻车、是不是刷的 —— 辣条妹当中立第三方，细盘风评。
//
// 证据三条腿：
//   1) 她本人探店实记：库存池里能匹配到店名/菜名就注入全部记录；
//   2) 高德到店数据：官方 v5 place 搜索（评分/人均/商圈/标签），
//      并对原始回包扫「扫街」字样 —— 高德扫街榜按真实导航到店选店，
//      入选信息挂在 POI 展示字段上，没有独立公开榜单接口，扫字样
//      是目前最稳的拿法。查过落 amap_poi 表缓存 7 天，省免费配额。
//   3) LLM 联网检索（enable_search）：抖音/小红书/点评/美团/知乎/微博
//      全是强反爬平台（签名+登录态），自爬不可持续；风评这一路交给
//      模型服务端检索管线去「人肉盘」。鉴店态开关是 LLMSearch，
//      推店/规划态另由 RecSearch 控制（v1.10 起推店也联网，但卡片仍锁库存）。
//
// 输出走 verdict 块（判决书卡），服务端逐字段清洗；清单外的店也能鉴，
// 但不许挂 slug、不许编具体数字（prompt 里已下死规则）。
// ============================================================

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"latiaomei/internal/amap"
	"latiaomei/internal/store"
)

// wantsVerify 鉴店意图词。兜底引擎和证据注入共用。
func wantsVerify(q string) bool {
	return wantsAny(q, "靠谱", "翻车", "踩雷", "爆雷", "炸雷", "水军", "刷的", "刷单", "刷评", "水分",
		"拔草", "坑不坑", "值不值", "值得去", "值得去吗", "风评", "口碑", "鉴店", "鉴一个", "鉴一下", "鉴个",
		"是不是真的", "能不能去", "虚不虚", "割韭菜")
}

// lastUserText 取最后一条用户消息（鉴店意图看最新这句话）。
func lastUserText(msgs []agentMsg) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return msgs[i].Content
		}
	}
	return ""
}

// agentMatchedShop 从库存池里认人：消息里出现完整店名（取最长命中）优先，
// 退一步用菜名命中（菜名至少 3 字防误伤）。
func agentMatchedShop(q string, pool *agentPool) (string, []*store.Review) {
	if q == "" || len(pool.all) == 0 {
		return "", nil
	}
	bestName, bestLen := "", 0
	for _, rv := range pool.all {
		if rv.Shop == nil {
			continue
		}
		n := []rune(rv.Shop.Name)
		if len(n) >= 2 && strings.Contains(q, rv.Shop.Name) && len(n) > bestLen {
			bestName, bestLen = rv.Shop.Name, len(n)
		}
	}
	if bestName == "" {
		for _, rv := range pool.all {
			if rv.Shop != nil && len([]rune(rv.Dish)) >= 3 && strings.Contains(q, rv.Dish) {
				bestName = rv.Shop.Name
				break
			}
		}
	}
	if bestName == "" {
		return "", nil
	}
	var rvs []*store.Review
	for _, rv := range pool.all {
		if rv.Shop != nil && rv.Shop.Name == bestName {
			rvs = append(rvs, rv)
		}
	}
	return bestName, rvs
}

// guessVerifyShop 库存外鉴店：从口语句子里抠疑似店名（人肉土办法）。
// 「XX这家店靠谱吗」取「这家」前；否则整句剔掉鉴店语气词。抠不出像样的
// 名字就放弃——宁可少查一路证据，别拿半截话去搜高德。
func guessVerifyShop(q string) string {
	cand := ""
	if i := strings.Index(q, "这家"); i > 0 {
		cand = q[:i]
	} else {
		cand = q
		for _, w := range []string{"靠谱吗", "靠谱不", "靠不靠谱", "会不会翻车", "会翻车吗", "能去吗", "值得去吗",
			"值不值得去", "怎么样", "风评如何", "是不是", "帮我鉴店", "帮我鉴一下", "帮我鉴个", "求鉴", "鉴店", "水分大吗"} {
			cand = strings.ReplaceAll(cand, w, "")
		}
	}
	for _, p := range []string{"帮我看看", "我想问问", "请问", "想问下", "评价一下", "看看", "说说", "帮我", "我想问", "麻烦"} {
		cand = strings.TrimPrefix(cand, p)
	}
	cand = strings.TrimSpace(strings.Trim(strings.TrimSpace(cand), "，,、。？?！!~的 "))
	r := []rune(cand)
	if len(r) < 2 || len(r) > 16 {
		return ""
	}
	if wantsAny(cand, "什么", "怎么", "为什么", "哪里", "哪家") {
		return ""
	}
	return cand
}

// verifyTarget 综合两条路径定出本次对话要鉴的店名；库存内直接返店名。
func verifyTarget(q string, pool *agentPool) (string, []*store.Review) {
	if name, rvs := agentMatchedShop(q, pool); name != "" {
		return name, rvs
	}
	if wantsVerify(q) {
		if g := guessVerifyShop(q); g != "" {
			return g, nil
		}
	}
	return "", nil
}

// agentVerifyHint 给 LLM 系统设定拼「鉴店证据」段；返回证据文本和
// 是否处于鉴店态（鉴店态才开联网检索，省钱不失控）。
func (s *Server) agentVerifyHint(ctx context.Context, msgs []agentMsg, pool *agentPool) (string, bool) {
	name, rvs := verifyTarget(lastUserText(msgs), pool)
	if name == "" {
		return "", false
	}
	var sb strings.Builder
	sb.WriteString("\n\n【鉴店对象】用户想让你鉴的店：" + name + "（用 verdict 块给判决）\n")
	if len(rvs) > 0 {
		sb.WriteString("【辣条妹本人探店实记】（真实记录，第一列可作 verdict.slug）\n" + shopNoteText(rvs))
	} else {
		sb.WriteString("【辣条妹本人探店实记】库里没这家店的踩点记录 —— 分析风评可以，但 verdict 别挂 slug，拿不准就 level=unknown。\n")
	}
	if note := s.agentAmapNote(ctx, name, true); note != "" {
		sb.WriteString("【高德到店数据】（官方 POI，含扫街榜痕迹探测）\n" + name + " → " + note + "\n")
	} else if s.cfg.AmapKey == "" {
		sb.WriteString("【高德到店数据】未接入（服务端没配高德 key）：platforms 里高德扫街榜一条照实写「没查到」，good=0。\n")
	} else {
		sb.WriteString("【高德到店数据】没搜到这家店的官方 POI：platforms 里高德扫街榜一条照实说，别编。\n")
	}
	return sb.String(), true
}

// agentAmapCacheNote 兜底通道专用：只读缓存不发网络请求，保证本地引擎秒回。
func (s *Server) agentAmapCacheNote(msgs []agentMsg, pool *agentPool) string {
	name, _ := verifyTarget(lastUserText(msgs), pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.agentAmapNote(ctx, name, false)
}

const amapCacheTTL = 7 * 24 * time.Hour

// agentAmapNote 拿一家店的高德到店证据文本：缓存优先，miss 且允许联网才查。
// 没配 key / 查不到 / 出任何错都安静返回空串 —— 鉴店不能因为一路数据挂了就不开门。
func (s *Server) agentAmapNote(ctx context.Context, name string, fetch bool) string {
	if name == "" || s.st == nil { // 没库（如单测环境）不开查，鉴店少一路证据不致命
		return ""
	}
	city := s.cfg.AmapCity
	if c, err := s.st.GetAmapPOI(city, name); err == nil {
		if time.Now().Unix()-c.FetchedAt < int64(amapCacheTTL.Seconds()) {
			return amapNoteText(c.Info)
		}
	}
	if !fetch || s.cfg.AmapKey == "" {
		return ""
	}
	cli := &amap.Client{Key: s.cfg.AmapKey, Base: s.cfg.AmapBase, City: city}
	fctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	poi, err := cli.SearchShop(fctx, name)
	if err != nil {
		log.Printf("agent: 高德查询失败(%s): %v", name, err)
		return "" // 出错不落负缓存，下次还能试
	}
	info := "{}" // 搜不到也落一行，空结果 7 天内不反复打外网
	if poi != nil {
		b, _ := json.Marshal(poi)
		info = string(b)
	}
	if err := s.st.PutAmapPOI(city, name, store.AmapPOICache{
		Name: name, Info: info, FetchedAt: time.Now().Unix(),
	}); err != nil {
		log.Printf("agent: 高德缓存落库失败(%s): %v", name, err)
	}
	return amapNoteText(info)
}

// amapNoteText 把缓存里的 POI JSON 压成一行注入/展示用证据文本。
func amapNoteText(info string) string {
	if info == "" || info == "{}" {
		return ""
	}
	var p amap.POI
	if err := json.Unmarshal([]byte(info), &p); err != nil {
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
	if p.Tag != "" {
		bits = append(bits, "标签:"+trimRunes(p.Tag, 40))
	}
	if p.ScanRanked {
		bits = append(bits, "★扫街榜:检出入选痕迹("+trimRunes(strings.Join(p.ScanMents, " / "), 80)+")")
	} else {
		bits = append(bits, "扫街榜:未见入选痕迹")
	}
	return trimRunes(strings.Join(bits, " | "), 220)
}

// shopNoteText 本人探店实记 → 注入证据行。
func shopNoteText(rvs []*store.Review) string {
	var sb strings.Builder
	for _, rv := range rvs {
		price := "-"
		if rv.Price > 0 {
			price = fmt.Sprintf("%d元", rv.Price)
		}
		sb.WriteString(fmt.Sprintf("- %s | %s | %s档 | %.1f分 | 人均%s | 辣%d | %s\n",
			rv.Slug, rv.Dish, rv.TierLabel, rv.Score, price, rv.Spicy, trimRunes(rv.Headline, 40)))
	}
	return sb.String()
}

// ---- verdict 块清洗 ----

var verifyLevels = map[string]bool{"solid": true, "foggy": true, "bust": true, "unknown": true}

func cleanText(v any, maxRunes int) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "<nil>" {
		return ""
	}
	return trimRunes(s, maxRunes)
}

// signOf 把 LLM 给的 good 字段折成 1/0/-1（正/中/负）。
func signOf(v any) int {
	f, ok := v.(float64)
	if !ok {
		return 0
	}
	switch {
	case f > 0:
		return 1
	case f < 0:
		return -1
	}
	return 0
}

func sanitizeVerdict(b map[string]any, pool *agentPool) map[string]any {
	shop := cleanText(b["shop"], 30)
	if shop == "" {
		return nil
	}
	level := strings.ToLower(cleanText(b["level"], 12))
	if !verifyLevels[level] {
		level = "unknown"
	}
	judge := cleanText(b["judge"], 60)
	advice := cleanText(b["advice"], 80)
	score := 0.0
	if f, ok := b["score"].(float64); ok && f > 0 {
		score = math.Round(math.Min(f, 10)*10) / 10
	}
	signals := cleanVerdictList(b["signals"], 14, 60, 6)
	if len(signals) < 2 {
		return nil // 不到两条证据，不配叫判决书
	}
	platforms := cleanVerdictList(b["platforms"], 12, 40, 5)
	out := map[string]any{"type": "verdict", "shop": shop, "level": level,
		"judge": judge, "advice": advice, "signals": signals}
	if score > 0 {
		out["score"] = score
	}
	if len(platforms) > 0 {
		out["platforms"] = platforms
	}
	if slug := cleanText(b["slug"], 40); slug != "" {
		if rv := pool.byReview[slug]; rv != nil && rv.Shop != nil {
			out["slug"] = slug
			out["tier_label"] = rv.TierLabel // 端上角标：她本人给这店的档
		}
	}
	return out
}

// cleanVerdictList 通吃 signals（k/v/good）与 platforms（name/v/good）两种写法。
func cleanVerdictList(v any, kMax, vMax, capN int) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for _, e := range arr {
		m, _ := e.(map[string]any)
		k := cleanText(m["k"], kMax)
		if k == "" {
			k = cleanText(m["name"], kMax)
		}
		t := cleanText(m["v"], vMax)
		if k == "" || t == "" {
			continue
		}
		out = append(out, map[string]any{"k": k, "v": t, "good": signOf(m["good"])})
		if len(out) >= capN {
			break
		}
	}
	return out
}

// ---- 兜底引擎的鉴店判决（只用本地真实数据，不给模型脑补空间） ----

func fallbackVerdict(name string, rvs []*store.Review, amapNote string) map[string]any {
	var sum float64
	dist := map[string]int{}
	bad := false
	for _, rv := range rvs {
		sum += rv.Score
		dist[rv.TierLabel]++
		if rv.Tier == "la" || rv.Score < 3 {
			bad = true
		}
	}
	avg := sum / float64(len(rvs))
	level, good := "foggy", 0
	if bad {
		level, good = "bust", -1
	} else if avg >= 4.5 && dist["NPC"] == 0 && dist["拉完了"] == 0 {
		level, good = "solid", 1
	}
	var parts []string
	for _, t := range []string{"夯", "顶级", "人上人", "NPC", "拉完了"} {
		if dist[t] > 0 {
			parts = append(parts, fmt.Sprintf("%s×%d", t, dist[t]))
		}
	}
	signals := []map[string]any{
		{"k": "辣条妹实探", "v": fmt.Sprintf("本人打卡%d条，均分%.1f（%s）", len(rvs), avg, strings.Join(parts, " / ")), "good": good},
		{"k": "刷单检测", "v": "离线兜底模式盘不了平台评价库，此条保守计", "good": 0},
		{"k": "差评聚焦点", "v": "兜底模式看不到差评原文，看判决请点进她的探店原文", "good": 0},
	}
	if amapNote != "" {
		g := 0
		if strings.Contains(amapNote, "★扫街榜:检出") {
			g = 1
		}
		signals = append(signals, map[string]any{"k": "高德到店", "v": trimRunes(amapNote, 60), "good": g})
	}
	judge := rvs[0].Headline
	for _, rv := range rvs { // 拿最高分那条的判决语当门面
		if rv.Score > rvs[0].Score {
			judge = rv.Headline
		}
	}
	out := map[string]any{
		"type": "verdict", "shop": name, "level": level,
		"score":   math.Round(avg*2*10) / 10, // 5 分制折成 10 分制
		"judge":   trimRunes(judge, 40),
		"signals": signals,
		"advice":  "点单前翻她这篇实探原文，档位不会骗人",
	}
	if rvs[0].Slug != "" {
		out["slug"] = rvs[0].Slug
		out["tier_label"] = rvs[0].TierLabel
	}
	return out
}
