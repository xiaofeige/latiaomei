package httpapi

// ============================================================
// 推店/附近类对话的「高德周边实况」注入（B 路数据）：
// 用户带定位时，以 TA 为圆心实时查高德附近餐饮 POI，把评分/人均/
// 扫街榜痕迹当周边参考注入系统设定。卡片仍只锚库存店（见 agent.go
// 铁律），这段只喂上下文，让辣条妹说话有据、能提「你旁边那条街有家
// 高德 4.6 分的……」，但不放开编新店的权限。
//
// 省配额：按 ~1km 网格落 amap_poi 缓存表（复用），TTL 内不重复打外网；
// 出错/没配 key 一律安静返回空串，绝不让推店因为这路挂了而开不了门。
// ============================================================

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"latiaomei/internal/amap"
	"latiaomei/internal/store"
)

// amapNearbyTTL 周边实况缓存时效：比鉴店单店（7 天）短，兼顾热度与配额。
const amapNearbyTTL = 3 * 24 * time.Hour

// nearbyGridKey 把坐标归一到 ~0.01°（约 1km）网格，同片区的用户共用一份缓存。
func nearbyGridKey(lat, lng float64) string {
	return fmt.Sprintf("around:%.2f,%.2f", lat, lng)
}

// agentNearbyNote 拿用户周边餐饮实况文本：缓存优先，miss 且允许联网才查高德。
func (s *Server) agentNearbyNote(ctx context.Context, loc *agentLoc, fetch bool) string {
	if loc == nil || s.st == nil || s.cfg == nil || !s.cfg.AmapNearby {
		return ""
	}
	key := nearbyGridKey(loc.Lat, loc.Lng)
	city := s.cfg.AmapCity
	if c, err := s.st.GetAmapPOI(city, key); err == nil {
		if time.Now().Unix()-c.FetchedAt < int64(amapNearbyTTL.Seconds()) {
			return nearbyNoteText(c.Info)
		}
	}
	if !fetch || s.cfg.AmapKey == "" {
		return ""
	}
	cli := &amap.Client{Key: s.cfg.AmapKey, Base: s.cfg.AmapBase, City: city}
	fctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	pois, err := cli.SearchNearby(fctx, fmt.Sprintf("%.6f", loc.Lat), fmt.Sprintf("%.6f", loc.Lng), 12)
	if err != nil {
		log.Printf("agent: 高德周边查询失败(%s): %v", key, err)
		return "" // 出错不落负缓存，下次还能试
	}
	info := "[]"
	if len(pois) > 0 {
		b, _ := json.Marshal(pois)
		info = string(b)
	}
	if err := s.st.PutAmapPOI(city, key, store.AmapPOICache{
		Name: key, Info: info, FetchedAt: time.Now().Unix(),
	}); err != nil {
		log.Printf("agent: 高德周边缓存落库失败(%s): %v", key, err)
	}
	return nearbyNoteText(info)
}

// nearbyNoteText 把缓存里的 POI 数组 JSON 压成注入用清单文本（最多 8 条，评分优先）。
func nearbyNoteText(info string) string {
	if info == "" || info == "[]" || info == "{}" {
		return ""
	}
	var ps []amap.POI
	if err := json.Unmarshal([]byte(info), &ps); err != nil || len(ps) == 0 {
		return ""
	}
	var lines []string
	for i, p := range ps {
		if i >= 8 {
			break
		}
		if strings.TrimSpace(p.Name) == "" {
			continue
		}
		var bits []string
		if r := strings.TrimSpace(p.Rating); r != "" && r != "0" {
			bits = append(bits, "评分"+r)
		}
		if c := strings.TrimSpace(p.Cost); c != "" && c != "0" {
			bits = append(bits, "人均"+c+"元")
		}
		if p.District != "" || p.BizArea != "" {
			bits = append(bits, strings.Trim(p.District+" "+p.BizArea, " "))
		}
		if p.ScanRanked {
			bits = append(bits, "高德扫街榜在榜")
		}
		line := "· " + trimRunes(p.Name, 24)
		if len(bits) > 0 {
			line += "（" + strings.Join(bits, "，") + "）"
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}
