package store

// v14 ai_rank：巡逻榜 upsert 幂等、名次重建、已知店名池。

import (
	"path/filepath"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "t.db"), time.UTC)
	if err != nil {
		t.Fatalf("建库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestAIRankUpsertAndOverwrite(t *testing.T) {
	st := openTestStore(t)
	a := &AIRank{ShopName: "胖哥鱼头王", Level: "foggy", Score: 6.2, Confidence: 0.55,
		Judge: "吹得凶", Signals: []AIRankSignal{{K: "评论分布", V: "两极", Good: -1}}}
	if err := st.UpsertAIRank(a); err != nil {
		t.Fatal(err)
	}
	if a.ID == 0 || a.Tier != "renshang" || a.TierLabel != "人上人" {
		t.Fatalf("首插字段不对: %+v", a)
	}
	created := a.CreatedAt
	// 同店再判：覆盖判决，不新增行。
	b := &AIRank{ShopName: "胖哥鱼头王", Level: "solid", Score: 8.8, Confidence: 0.8,
		Judge: "风评回暖", Signals: []AIRankSignal{{K: "评论分布", V: "近期一致好评", Good: 1}}}
	if err := st.UpsertAIRank(b); err != nil {
		t.Fatal(err)
	}
	if b.ID != a.ID {
		t.Fatalf("应覆盖同一行: %d vs %d", b.ID, a.ID)
	}
	got, err := st.GetAIRank(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Level != "solid" || got.Tier != "hang" || got.CreatedAt != created {
		t.Fatalf("覆盖后不对: %+v", got)
	}
	// bust 高分要封顶成 NPC 档，防「不建议」却发夯牌。
	c := &AIRank{ShopName: "滤镜店", Level: "bust", Score: 9.9, Confidence: 0.9}
	if err := st.UpsertAIRank(c); err != nil {
		t.Fatal(err)
	}
	if c.Tier != "npc" {
		t.Fatalf("bust 封顶失效: %s", c.Tier)
	}
}

func TestAIRankRebuildAndKnown(t *testing.T) {
	st := openTestStore(t)
	mk := func(name string, score, conf float64) {
		if err := st.UpsertAIRank(&AIRank{ShopName: name, Score: score, Confidence: conf,
			Signals: []AIRankSignal{{K: "a", V: "b", Good: 1}, {K: "c", V: "d", Good: 0}}}); err != nil {
			t.Fatal(err)
		}
	}
	mk("甲", 7.0, 0.9)  // 6.3
	mk("乙", 8.0, 0.5)  // 4.0
	mk("丙", 9.0, 0.95) // 8.55 第一
	if n, err := st.RebuildAIRanks(); err != nil || n != 3 {
		t.Fatalf("重建 %d: %v", n, err)
	}
	items, total, err := st.ListAIRanks(AIRankFilter{Sort: "rank", Size: 10})
	if err != nil || total != 3 {
		t.Fatal(err)
	}
	if items[0].ShopName != "丙" || items[0].RankNo != 1 || items[2].ShopName != "乙" {
		t.Fatalf("名次不对: %v", items)
	}
	// 下架丙 → 名次重排，retired 不进榜。
	if err := st.SetAIRankStatus(items[0].ID, "retired"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RebuildAIRanks(); err != nil {
		t.Fatal(err)
	}
	items, total, _ = st.ListAIRanks(AIRankFilter{Sort: "rank", Size: 10})
	if total != 2 || items[0].ShopName != "甲" {
		t.Fatalf("下架后榜单不对: total=%d %v", total, items)
	}
	known, err := st.KnownAIRankNames(30)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"甲", "乙", "丙"} {
		if !known[n] {
			t.Fatalf("%s 应在已知池", n)
		}
	}
}

func TestAIRankCounters(t *testing.T) {
	st := openTestStore(t)
	if err := st.UpsertAIRank(&AIRank{ShopName: "甲", Level: "solid", Score: 8.2, Confidence: 0.7}); err != nil {
		t.Fatal(err)
	}
	c, err := st.CountAIRank()
	if err != nil {
		t.Fatal(err)
	}
	if c["total"].(int64) != 1 || c["active"].(int64) != 1 {
		t.Fatalf("计数不对: %v", c)
	}
}
