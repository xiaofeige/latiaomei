package httpapi

// 鉴店 skill 单测：意图识别、店名匹配、verdict 清洗、兜底判决。

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"latiaomei/internal/config"
	"latiaomei/internal/store"
)

func TestWantsVerifyAndGuess(t *testing.T) {
	if !wantsVerify("巷口面馆靠谱吗") || !wantsVerify("这家会不会翻车") || !wantsVerify("是不是刷的单") {
		t.Fatal("鉴店意图词没接住")
	}
	if wantsVerify("附近有什么好吃的") {
		t.Fatal("普通推荐不该误触发鉴店")
	}
	if g := guessVerifyShop("弄堂里这家店靠谱吗"); g != "弄堂里" {
		t.Fatalf("「这家」前抠店名失败: %q", g)
	}
	if g := guessVerifyShop("帮我看看老张糖醋排骨会不会翻车"); g != "老张糖醋排骨" {
		t.Fatalf("剔语气词抠店名失败: %q", g)
	}
	if g := guessVerifyShop("附近有什么好吃的"); g != "" {
		t.Fatalf("非鉴店句不该抠名字: %q", g)
	}
}

func TestAgentMatchedShop(t *testing.T) {
	pool := testPool()
	name, rvs := agentMatchedShop("巷口面馆靠谱吗，会不会翻车", pool)
	if name != "巷口面馆" || len(rvs) != 1 || rvs[0].Slug != "pianer-chuan" {
		t.Fatalf("店名匹配失败: %s %v", name, rvs)
	}
	if name, _ := agentMatchedShop("片儿川哪家强", pool); name != "巷口面馆" {
		t.Fatalf("菜名兜底匹配失败: %s", name)
	}
	if name, _ := agentMatchedShop("随便吃点啥", pool); name != "" {
		t.Fatalf("不该命中: %s", name)
	}
}

func TestSanitizeVerdict(t *testing.T) {
	pool := testPool()
	blk := map[string]any{
		"type": "verdict", "shop": "巷口面馆", "level": "SOLID", "score": 9.4,
		"judge": "当季笋雪菜真材实料", "advice": "饭点去排队短，点大碗",
		"signals": []any{
			map[string]any{"k": "评论分布", "v": "好评集中在味道，差评只吐槽座位", "good": 1},
			map[string]any{"k": "刷单检测", "v": "未见模板化五星", "good": 0},
			map[string]any{"k": "x", "v": ""}, // 空 v 应被丢
		},
		"platforms": []any{
			map[string]any{"name": "高德扫街榜", "v": "检出入选痕迹", "good": 2.5},
		},
		"slug": "pianer-chuan",
	}
	out := sanitizeVerdict(blk, pool)
	if out == nil {
		t.Fatal("合法 verdict 不该被丢")
	}
	if out["level"] != "solid" || out["slug"] != "pianer-chuan" || out["tier_label"] != "夯" {
		t.Fatalf("清洗结果不对: %v", out)
	}
	sigs := out["signals"].([]map[string]any)
	if len(sigs) != 2 {
		t.Fatalf("空证据应被丢，实得 %d", len(sigs))
	}
	plats := out["platforms"].([]map[string]any)
	if plats[0]["k"] != "高德扫街榜" || plats[0]["good"] != 1 {
		t.Fatalf("platforms name→k 归一或 good 折符号失败: %v", plats[0])
	}
	// 编造 slug：块保留但 slug 字段必须丢
	blk["slug"] = "根本不存在的店"
	if out = sanitizeVerdict(blk, pool); out["slug"] != nil {
		t.Fatal("编造 slug 应被剥掉")
	}
	// 证据不足两块不配判决
	blk["signals"] = []any{map[string]any{"k": "a", "v": "b"}}
	if sanitizeVerdict(blk, pool) != nil {
		t.Fatal("signals 不足应整块丢弃")
	}
	// level 不认识 → unknown
	blk["signals"] = []any{map[string]any{"k": "a", "v": "b", "good": 1}, map[string]any{"k": "c", "v": "d"}}
	blk["level"] = "绝对靠谱"
	if out = sanitizeVerdict(blk, pool); out["level"] != "unknown" {
		t.Fatalf("非法 level 应折成 unknown: %v", out["level"])
	}
}

func TestAgentParseAndSanitizeVerdict(t *testing.T) {
	pool := testPool()
	raw := `{"thinking":"鉴一下","blocks":[{"type":"verdict","shop":"巷口面馆","level":"solid","judge":"靠谱","signals":[{"k":"实探","v":"均分4.9","good":1},{"k":"刷单","v":"未见","good":0}],"platforms":[{"name":"抖音","v":"没查到","good":0}],"slug":"pianer-chuan"}],"chips":["再鉴一家"]}`
	ans, err := agentParseAndSanitize(raw, pool, nil)
	if err != nil || len(ans.Blocks) != 1 {
		t.Fatalf("verdict 应过审: %v %v", err, ans)
	}
	if ans.Blocks[0]["type"] != "verdict" {
		t.Fatalf("块类型错: %v", ans.Blocks[0])
	}
}

func TestFallbackVerify(t *testing.T) {
	pool := testPool()
	ans := agentFallback([]agentMsg{{Role: "user", Content: "巷口面馆靠谱吗，会不会翻车"}}, agentPrefs{}, nil, pool, "高德在案 | ★扫街榜:检出")
	if ans.Blocks == nil {
		t.Fatal("兜底鉴店不能空")
	}
	var v map[string]any
	for _, b := range ans.Blocks {
		if b["type"] == "verdict" {
			v = b
		}
	}
	if v == nil {
		t.Fatalf("应产出 verdict 块: %+v", ans.Blocks)
	}
	if v["shop"] != "巷口面馆" || v["level"] != "solid" || v["slug"] != "pianer-chuan" {
		t.Fatalf("判决字段不对: %v", v)
	}
	sigs := v["signals"].([]map[string]any)
	hasAmap := false
	for _, s := range sigs {
		if s["k"] == "高德到店" {
			hasAmap = true
		}
	}
	if !hasAmap {
		t.Fatal("传了高德证据应进 signals")
	}
	// 没报店名 → 引导报店名，不产 verdict
	ans = agentFallback([]agentMsg{{Role: "user", Content: "帮我鉴个店，会不会翻车"}}, agentPrefs{}, nil, pool, "")
	for _, b := range ans.Blocks {
		if b["type"] == "verdict" {
			t.Fatal("没店名不该有 verdict")
		}
	}
	if !strings.Contains(ans.Blocks[0]["md"].(string), "店名") {
		t.Fatal("应引导用户报店名")
	}
}

func TestAmapNoteText(t *testing.T) {
	if amapNoteText("") != "" || amapNoteText("{}") != "" || amapNoteText("坏json") != "" {
		t.Fatal("空/坏数据应安静返回空")
	}
	b, _ := json.Marshal(map[string]any{
		"name": "巷口面馆", "rating": "4.6", "cost": "25", "district": "上城",
		"scan_ranked": true, "scan_mentions": []string{"扫街榜·面馆热门榜第8名"},
	})
	note := amapNoteText(string(b))
	if !strings.Contains(note, "4.6") || !strings.Contains(note, "★扫街榜") {
		t.Fatalf("证据文本缺字段: %s", note)
	}
}

func TestAgentVerifyHintShape(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"), time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	srv := &Server{cfg: &config.Config{AmapCity: "杭州"}, st: st} // 没 LLM/AMAP key 也要能安静出证据
	pool := testPool()
	hint, on := srv.agentVerifyHint(context.Background(), []agentMsg{{Role: "user", Content: "巷口面馆靠谱吗"}}, pool)
	if !on {
		t.Fatal("库存店被点名应进鉴店态")
	}
	if !strings.Contains(hint, "鉴店对象") || !strings.Contains(hint, "pianer-chuan") || !strings.Contains(hint, "未接入") {
		t.Fatalf("证据段缺项: %s", hint)
	}
	if _, on := srv.agentVerifyHint(context.Background(), []agentMsg{{Role: "user", Content: "附近吃啥"}}, pool); on {
		t.Fatal("非鉴店不该进鉴店态")
	}
}
