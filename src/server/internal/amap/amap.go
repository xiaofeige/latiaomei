// Package amap 高德开放平台 Web 服务客户端 —— 鉴店 skill 的「到店数据」来源。
//
// 数据怎么拿：
//   - 高德「扫街榜」本身没有独立的公开榜单接口，但它的入选信息会挂在
//     POI 的展示字段上（tag / 特色 / 榜单文案里出现「扫街榜」字样），
//     评分、人均消费则在 place/detail 的 business 域里。
//   - 所以我们走官方 Web 服务：v5/place/text 按「关键词 + 杭州 + 餐饮类」搜，
//     show_fields=business 把评分/人均/商圈/营业时间带回来；再对原始 JSON
//     递归扫一遍「扫街」关键词，命中即视为有扫街榜痕迹（文案一并留证）。
//   - 需要在 https://console.amap.com 申请「Web服务」key（免费配额），
//     配到 LATIAOMEI_AMAP_KEY。查过的店落 SQLite 缓存（store 层），
//     省配额也防止每次对话都打外网。
package amap

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// POI 是从高德抠出来、给鉴店用的最小字段集。数值字段保持字符串原样，
// 高德给 "4.5" 还是 "" 我们都如实转述，不做二次加工。
type POI struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Address    string   `json:"address"`
	District   string   `json:"district"`                // adname，如 西湖区
	BizArea    string   `json:"biz_area"`                // 商圈，如 湖滨路
	Tag        string   `json:"tag"`                     // 特色标签
	Rating     string   `json:"rating"`                  // 高德综合评分
	Cost       string   `json:"cost"`                    // 人均（元）
	Opentime   string   `json:"opentime"`                // 营业时间
	ScanMents  []string `json:"scan_mentions,omitempty"` // 含「扫街」的原文片段（证据）
	ScanRanked bool     `json:"scan_ranked"`             // 是否检出扫街榜字样
}

// Client 一个无状态查询客户端。Base 仅为测试桩可替换。
type Client struct {
	Key  string
	Base string // 如 https://restapi.amap.com
	City string // 检索城市，默认 杭州
	HTTP *http.Client
}

const typeFood = "050000" // 高德 POI 分类：餐饮类

// SearchShop 按店名搜一家店；搜不到返回 nil, nil（不是错误）。
func (c *Client) SearchShop(ctx context.Context, name string) (*POI, error) {
	if c.Key == "" {
		return nil, fmt.Errorf("amap: 未配置 key")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	base := c.Base
	if base == "" {
		base = "https://restapi.amap.com"
	}
	city := c.City
	if city == "" {
		city = "杭州"
	}
	cli := c.HTTP
	if cli == nil {
		cli = &http.Client{Timeout: 8 * time.Second}
	}
	q := url.Values{}
	q.Set("keywords", name)
	q.Set("types", typeFood)
	q.Set("city", city)
	q.Set("citylimit", "true")
	q.Set("show_fields", "business")
	q.Set("page_size", "5")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(base, "/")+"/v5/place/text?"+q.Encode()+"&key="+url.QueryEscape(c.Key), nil)
	if err != nil {
		return nil, err
	}
	res, err := cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("amap: 网络: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 512<<10))
	if err != nil {
		return nil, fmt.Errorf("amap: 读包: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("amap: HTTP %d %s", res.StatusCode, trim(string(raw), 80))
	}
	return pickPOI(raw, name)
}

// SearchNearby 以用户坐标为圆心搜周边餐饮 POI（v5/place/around），按距离适中的
// 高德分序；最多返 maxN 条。lat/lng 为高德坐标串（十进制度）。失败/无结果不报错。
func (c *Client) SearchNearby(ctx context.Context, lat, lng string, maxN int) ([]POI, error) {
	if c.Key == "" {
		return nil, fmt.Errorf("amap: 未配置 key")
	}
	if strings.TrimSpace(lat) == "" || strings.TrimSpace(lng) == "" {
		return nil, nil
	}
	base := c.Base
	if base == "" {
		base = "https://restapi.amap.com"
	}
	cli := c.HTTP
	if cli == nil {
		cli = &http.Client{Timeout: 8 * time.Second}
	}
	if maxN <= 0 || maxN > 25 {
		maxN = 12
	}
	q := url.Values{}
	q.Set("location", lng+","+lat) // 高德经度在前
	q.Set("types", typeFood)
	q.Set("sortrule", "distance")
	q.Set("show_fields", "business")
	q.Set("page_size", fmt.Sprint(maxN))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(base, "/")+"/v5/place/around?"+q.Encode()+"&key="+url.QueryEscape(c.Key), nil)
	if err != nil {
		return nil, err
	}
	res, err := cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("amap: 网络: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 512<<10))
	if err != nil {
		return nil, fmt.Errorf("amap: 读包: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("amap: HTTP %d %s", res.StatusCode, trim(string(raw), 80))
	}
	return pickPOIs(raw, maxN)
}

// pickPOI 解析高德回包：status!=1 报错；命中多条时优先名字对得上的。
func pickPOI(raw []byte, want string) (*POI, error) {
	j, err := decodePlaces(raw)
	if err != nil {
		return nil, err
	}
	if len(j.Pois) == 0 {
		return nil, nil
	}
	best := 0 // 名称完全一致者优先，否则取第一条（高德已按相关度排）
	for i, p := range j.Pois {
		if strings.TrimSpace(fmt.Sprint(p["name"])) == want {
			best = i
			break
		}
	}
	poi := poiFromMap(j.Pois[best])
	return &poi, nil
}

// pickPOIs 解析多条 POI（周边搜用），最多 maxN 条；高德已按距离/相关度排序。
func pickPOIs(raw []byte, maxN int) ([]POI, error) {
	j, err := decodePlaces(raw)
	if err != nil {
		return nil, err
	}
	var out []POI
	for i, p := range j.Pois {
		if maxN > 0 && i >= maxN {
			break
		}
		out = append(out, poiFromMap(p))
	}
	return out, nil
}

type placesResp struct {
	Status string           `json:"status"`
	Info   string           `json:"info"`
	Count  string           `json:"count"`
	Pois   []map[string]any `json:"pois"`
}

func decodePlaces(raw []byte) (*placesResp, error) {
	var j placesResp
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, fmt.Errorf("amap: 回包解析失败: %w", err)
	}
	if j.Status != "1" {
		return nil, fmt.Errorf("amap: %s", trim(j.Info, 60))
	}
	return &j, nil
}

// poiFromMap 从高德单条 POI 原始 map 抠出最小字段集，并递归扫「扫街」字样。
func poiFromMap(p map[string]any) POI {
	poi := POI{}
	poi.ID = str(p["id"])
	poi.Name = str(p["name"])
	poi.Address = str(p["address"])
	poi.District = str(p["adname"])
	if b, ok := p["business"].(map[string]any); ok {
		poi.BizArea = str(b["business_area"])
		poi.Tag = str(b["tag"])
		poi.Rating = str(b["rating"])
		poi.Cost = str(b["cost"])
		poi.Opentime = str(b["opentime"])
	}
	poi.ScanMents = scanMentions(p)
	poi.ScanRanked = len(poi.ScanMents) > 0
	return poi
}

// scanMentions 递归收集含「扫街」的字符串片段（最多 3 条，各截 60 字）。
func scanMentions(v any) []string {
	var out []string
	var walk func(any)
	walk = func(x any) {
		if len(out) >= 3 {
			return
		}
		switch t := x.(type) {
		case string:
			if strings.Contains(t, "扫街") {
				out = append(out, trim(t, 60))
			}
		case map[string]any:
			for _, e := range t {
				walk(e)
			}
		case []any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return out
}

func str(v any) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "<nil>" {
		return ""
	}
	return s
}

func trim(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
