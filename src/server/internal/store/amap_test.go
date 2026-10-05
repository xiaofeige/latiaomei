package store

// v11 amap_poi 缓存表：建库迁移 + 读写幂等。

import (
	"path/filepath"
	"testing"
	"time"
)

func TestAmapPOICache(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "t.db"), time.UTC)
	if err != nil {
		t.Fatalf("建库: %v", err)
	}
	defer st.Close()
	if _, err := st.GetAmapPOI("杭州", "巷口面馆"); err == nil {
		t.Fatal("空表应查不到")
	}
	if err := st.PutAmapPOI("杭州", "巷口面馆", AmapPOICache{Name: "巷口面馆", Info: `{"rating":"4.6"}`, FetchedAt: 111}); err != nil {
		t.Fatalf("写入: %v", err)
	}
	// 覆盖写（键归一：店名里的空格无所谓）
	if err := st.PutAmapPOI("杭州", "巷口 面馆", AmapPOICache{Name: "巷口面馆", Info: "{}", FetchedAt: 222}); err != nil {
		t.Fatalf("覆盖: %v", err)
	}
	c, err := st.GetAmapPOI("杭州", "巷口面馆")
	if err != nil || c.FetchedAt != 222 || c.Info != "{}" {
		t.Fatalf("读回不对: %v %+v", err, c)
	}
}
