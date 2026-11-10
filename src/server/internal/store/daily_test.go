package store

import (
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"), time.Local)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestDailyBriefSaveGetList(t *testing.T) {
	s := newTestStore(t)
	b := &DailyBrief{Date: "2026-01-02", Shop: "霸王集", Dish: "片儿川", Tier: "hang",
		Verdict: "今日判决：夯", Blurb: "少汤多面。", Slug: "pianerchuan",
		Links: []DailyLink{{Label: "去榜单", Href: "/rank"}}}
	if err := s.SaveDailyBrief(b, false); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := s.GetDailyBrief("2026-01-02")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.TierLabel != "夯" || len(got.Links) != 1 {
		t.Fatalf("字段回写不对: %+v", got)
	}

	// manual 覆盖后，引擎（force=false）不许再动当天。
	b.Source = "manual"
	b.Verdict = "站长手改版"
	if err := s.SaveDailyBrief(b, true); err != nil {
		t.Fatalf("manual save: %v", err)
	}
	b2 := &DailyBrief{Date: "2026-01-02", Verdict: "引擎又来啦", Tier: "npc"}
	if err := s.SaveDailyBrief(b2, false); err != nil {
		t.Fatalf("engine save: %v", err)
	}
	got, _ = s.GetDailyBrief("2026-01-02")
	if got.Verdict != "站长手改版" || got.Source != "manual" {
		t.Fatalf("manual 保护失效: %+v", got)
	}
	// force=true（后台点重生成）可以覆盖 manual。
	b2.Source = "auto"
	if err := s.SaveDailyBrief(b2, true); err != nil {
		t.Fatalf("force save: %v", err)
	}
	got, _ = s.GetDailyBrief("2026-01-02")
	if got.Verdict != "引擎又来啦" {
		t.Fatalf("force 覆盖失败: %+v", got)
	}

	list, err := s.ListDailyBriefs(10)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %+v", err, list)
	}
	if _, err := s.GetDailyBrief("2026-01-03"); err != ErrNotFound {
		t.Fatalf("缺日期应报 ErrNotFound, got %v", err)
	}
}
