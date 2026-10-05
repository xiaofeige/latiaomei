package httpapi

// 周边实况注入：网格键归一、POI JSON→展示文本、异常输入安静降级。

import (
	"context"
	"strings"
	"testing"
)

func TestNearbyGridKey(t *testing.T) {
	// 同一片 ~1km 网格应归一到同一个 key
	a := nearbyGridKey(30.25904, 120.13002)
	b := nearbyGridKey(30.25901, 120.13008)
	if a != b {
		t.Fatalf("邻近坐标应同网格: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, "around:") {
		t.Fatalf("key 前缀错: %q", a)
	}
	if c := nearbyGridKey(30.30, 120.20); c == a {
		t.Fatal("远距离坐标不应共用网格")
	}
}

func TestNearbyNoteText(t *testing.T) {
	info := `[{"name":"巷口面馆","district":"上城区","biz_area":"湖滨","rating":"4.6","cost":"25"},` +
		`{"name":"某某火锅","rating":"0","scan_ranked":true}]`
	got := nearbyNoteText(info)
	if !strings.Contains(got, "巷口面馆") || !strings.Contains(got, "评分4.6") ||
		!strings.Contains(got, "人均25元") || !strings.Contains(got, "湖滨") {
		t.Fatalf("字段没拼全: %q", got)
	}
	if !strings.Contains(got, "高德扫街榜在榜") {
		t.Fatalf("扫街榜标记缺失: %q", got)
	}
	if strings.Contains(got, "评分0") || strings.Contains(got, "人均0") {
		t.Fatalf("0 值应跳过: %q", got)
	}
	for _, bad := range []string{"", "{}", "[]", "not json", `{"x":1}`} {
		if nearbyNoteText(bad) != "" {
			t.Fatalf("异常输入应空串: %q", bad)
		}
	}
}

func TestNearbyNoteDisabledWithoutLoc(t *testing.T) {
	s := &Server{} // st/cfg 均空：绝不能panic，安静返回空
	if got := s.agentNearbyNote(context.Background(), nil, true); got != "" {
		t.Fatal("无定位应空串")
	}
	// 有定位但没配置：同样安静空串，不发网络请求
	loc := &agentLoc{Lat: 30.25, Lng: 120.13}
	if got := s.agentNearbyNote(context.Background(), loc, true); got != "" {
		t.Fatal("缺配置应空串")
	}
}
