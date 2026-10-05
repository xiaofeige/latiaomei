package amap

// 用本地桩服务喂高德回包样例：字段抠取、扫街榜字样探测、错误处理。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const okBody = `{"status":"1","count":"2","pois":[
 {"id":"B001","name":"巷口面馆","address":"某路1号","adname":"上城区",
  "business":{"rating":"4.6","cost":"25","business_area":"湖滨","tag":"片儿川","opentime":"07:00-20:00"}},
 {"id":"B002","name":"巷口馄饨","address":"某路2号","adname":"拱墅区",
  "business":{"rating":"4.1","cost":"18","extend_pairs":[{"list":[{"groupon":[{"name":"扫街榜·馄饨榜第5名"}]}]}]}}
]}`

func stubServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("keywords"); got == "" {
			t.Error("keywords 没传")
		}
		if r.URL.Path != "/v5/place/text" {
			t.Errorf("路径错: %s", r.URL.Path)
		}
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSearchShop(t *testing.T) {
	srv := stubServer(t, okBody, 200)
	c := &Client{Key: "k", Base: srv.URL}
	poi, err := c.SearchShop(context.Background(), "巷口面馆")
	if err != nil || poi == nil {
		t.Fatalf("查询失败: %v", err)
	}
	if poi.Name != "巷口面馆" || poi.Rating != "4.6" || poi.Cost != "25" || poi.District != "上城区" {
		t.Fatalf("字段抠取错: %+v", poi)
	}
	if poi.ScanRanked {
		t.Fatal("第一条没有扫街字样，不该判入选")
	}
	// 同名优先兜底：模糊请求按相关度取第一条
	if poi2, _ := c.SearchShop(context.Background(), "巷口馄饨"); poi2 == nil || !poi2.ScanRanked {
		t.Fatalf("递归扫「扫街」失败: %+v", poi2)
	}
}

// nearbyStub 验证 /v5/place/around 端点与 location 参数。
func nearbyStub(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v5/place/around" {
			t.Errorf("路径错: %s", r.URL.Path)
		}
		loc := r.URL.Query().Get("location")
		if loc == "" || strings.Count(loc, ",") != 1 {
			t.Errorf("location 参数错: %q", loc)
		}
		w.WriteHeader(200)
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSearchNearby(t *testing.T) {
	srv := nearbyStub(t, okBody)
	c := &Client{Key: "k", Base: srv.URL}
	pois, err := c.SearchNearby(context.Background(), "30.2590", "120.1300", 12)
	if err != nil || len(pois) != 2 {
		t.Fatalf("周边查回失败: %v n=%d", err, len(pois))
	}
	if pois[0].Name != "巷口面馆" || pois[0].Rating != "4.6" {
		t.Fatalf("第一条字段错: %+v", pois[0])
	}
	if !pois[1].ScanRanked {
		t.Fatalf("第二条应检出扫街榜: %+v", pois[1])
	}
	if p2, _ := c.SearchNearby(context.Background(), "30.25", "120.13", 1); len(p2) != 1 {
		t.Fatalf("maxN 截断失败: %d", len(p2))
	}
	if p3, err3 := c.SearchNearby(context.Background(), "", "", 5); err3 != nil || p3 != nil {
		t.Fatalf("空坐标应 nil,nil: %v %v", p3, err3)
	}
}

func TestSearchShopErrors(t *testing.T) {
	srv := stubServer(t, `{"status":"0","info":"INVALID_USER_KEY"}`, 200)
	c := &Client{Key: "k", Base: srv.URL}
	if _, err := c.SearchShop(context.Background(), "任何店"); err == nil {
		t.Fatal("status=0 应报错")
	}
	srv2 := stubServer(t, `{"status":"1","pois":[]}`, 200)
	c2 := &Client{Key: "k", Base: srv2.URL}
	poi, err := c2.SearchShop(context.Background(), "查无此店")
	if err != nil || poi != nil {
		t.Fatalf("空结果应是 nil,nil: %v %v", poi, err)
	}
	c3 := &Client{Base: srv2.URL} // 没 key
	if _, err := c3.SearchShop(context.Background(), "店"); err == nil {
		t.Fatal("没配 key 应报错")
	}
}
