package store

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// DefaultSettings 是站点/IP 文案的出厂值。改了这里等于改了"未覆盖的默认"，
// 后台 settings 表里的值优先级更高。
var DefaultSettings = map[string]string{
	"site_title":      "辣条妹的御膳房",
	"site_tagline":    "10年吃遍杭州 · 只恰真的",
	"seo_description": "辣条妹只做一件事：杭州美食文化。10年老杭州外地人，吃遍杭州美食。五档判定（夯/顶级/人上人/NPC/拉完了），总榜、店铺档案、避雷榜、口味筛选，全是不恰饭的真话。",
	"ip_name":         "辣条妹",
	"ip_handle":       "@辣条妹的御膳房",
	"ip_avatar":       "/img/seed/avatar.jpg",
	"ip_city":         "杭州",
	"ip_quote":        "来杭州 10 年，我只做好一件事——把杭州的美食一家一家吃透。",
	"ip_bio":          "一个来杭州 10 年的外地人。10 年，够把一座城从早面吃到夜宵，也够分辨哪家是真手艺、哪家在收割游客。\n\n辣条妹只做杭州美食文化这一件事：自己掏钱、自己排队、吃完当天就写。难吃的也照写，所以写出来的好吃才算数。",
	"fans_display":    "28.6w",
	"douyin_url":      "https://v.douyin.com/",
	"xhs_url":         "https://www.xiaohongshu.com/",
	// 小程序码图片路径（/uploads/… 或 /img/…）：后台「站点配置」上传后填入；
	// 留空则首页不显示扫码卡。图请用微信公众平台生成的官方小程序码（建议 ≥430px 的 PNG）。
	"mp_qrcode":    "",
	"announcement": "",
	"footer_note":  "辣条妹的御膳房 · 10年老杭州外地人，只做杭州美食",
	// ICP 备案号：留空则页脚不显示；填了会链到工信部 beian.miit.gov.cn（备案要求）。
	"icp":           "",
	"page_size":     "20",
	"track_enabled": "1",
	"allow_bots":    "0",
	// ---- v6 流水线：辣条妹在管理小程序里拨开关，就是“发布方向” ----
	"pipeline_enabled": "1", // 总开关：关掉后发布不再自动入队分发任务
	"pipeline_video":   "1", // 抖音短视频（hyperframes 渲染 + 发布）
	"pipeline_gzh":     "1", // 公众号同步发文
	"pipeline_wxpush":  "1", // 小程序订阅消息推送
	// v7 社媒分发：agent 运营主战场是小红书/知乎/微博（图文/长文/短图文），默认开；
	// 抖音只发视频，等 publishers.json 配好 cookie 再拨开（成片由 pipeline_video 产）。
	// v9 语义收紧：这些开关只控制「自动产待审文案」（social_gen），
	// 真发布必须辣条妹在管理小程序「AI 流水线」页逐条放行——机器永远没有自发行权。
	"pipeline_douyin":      "0", // 抖图文/视频分发文案（需成片+cookie）
	"pipeline_xiaohongshu": "1", // 小红书文案（主战场）
	"pipeline_zhihu":       "1", // 知乎文案（主战场）
	"pipeline_weibo":       "1", // 微博文案（主战场）
	"wx_sub_tpl_id":        "",  // 用户端小程序订阅消息模板 ID（公众平台申请后填）
	"gzh_tpl_id":           "",  // 公众号模板消息 ID（服务号才有；留空=只发文不提醒）
	"video_daily_cap":      "2", // 每天最多自动产几条抖音视频，防批量轰炸
	// ---- v13 项目制：主角定妆参考与 happyhorse 视频生成 ----
	// 辣条妹 3D 形象参考图（三视图/特写）。出现在视频里的人物镜头一律以这两张为准：
	// 分镜 LLM 照描述写人，happyhorse 镜头拿它们做人物一致性参考。
	"ip_char_three_view": "/uploads/charref/latiaomei-three-view.jpg",
	"ip_char_closeup":    "/uploads/charref/latiaomei-closeup.jpg",
	// happyhorse（token-plan 视频生成模型）开关：1=项目出片时允许把人物镜头交给
	// happyhorse 生成动态片段；0=全部走 hyperframes。模型名由 worker 侧 .env 配。
	"pipeline_happyhorse": "1",
}

// SettingKeys 是后台可编辑的白名单，避免把内部 key 也暴露出去。
var SettingKeys = func() []string {
	var ks []string
	for k := range DefaultSettings {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}()

// Settings 返回全部配置（默认值 + 库内覆盖），结果有缓存。
func (s *Store) Settings() (map[string]string, error) {
	s.cachedMu.RLock()
	if len(s.cachedSet) > 0 {
		out := make(map[string]string, len(DefaultSettings)+len(s.cachedSet))
		for k, v := range DefaultSettings {
			out[k] = v
		}
		for k, v := range s.cachedSet {
			out[k] = v
		}
		s.cachedMu.RUnlock()
		return out, nil
	}
	s.cachedMu.RUnlock()

	rows, err := s.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, fmt.Errorf("store: 查配置: %w", err)
	}
	defer rows.Close()
	m := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		m[k] = v
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.cachedMu.Lock()
	s.cachedSet = m
	s.cachedMu.Unlock()

	out := make(map[string]string, len(DefaultSettings)+len(m))
	for k, v := range DefaultSettings {
		out[k] = v
	}
	for k, v := range m {
		out[k] = v
	}
	return out, nil
}

// Setting 取单项，找不到时回默认值。
func (s *Store) Setting(key string) string {
	all, err := s.Settings()
	if err != nil {
		return DefaultSettings[key]
	}
	if v, ok := all[key]; ok {
		return v
	}
	return DefaultSettings[key]
}

// SaveSettings 批量写入并清缓存。允许任意 key，但后台表单只暴露白名单，
// 内部 key（如 last_prune_at）就走这个口子更新。
func (s *Store) SaveSettings(m map[string]string) error {
	if len(m) == 0 {
		return nil
	}
	now := s.Now().Unix()
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return s.tx(func(tx *sql.Tx) error {
		for _, k := range keys {
			v := strings.TrimSpace(m[k])
			if _, err := tx.Exec(`INSERT INTO settings(key, value, updated_at) VALUES (?,?,?)
					ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
				sanitizeSlug2(k), v, now); err != nil {
				return fmt.Errorf("store: 存配置 %s: %w", k, err)
			}
		}
		return nil
	})
}

// sanitizeSlug2 只用于 key：限制字符集，避免脏 key 进库。
func sanitizeSlug2(k string) string {
	k = strings.ToLower(strings.TrimSpace(k))
	var b strings.Builder
	for _, r := range k {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// InvalidateSettingsCache 让下一次读配置重新查库。
func (s *Store) InvalidateSettingsCache() {
	s.cachedMu.Lock()
	s.cachedSet = map[string]string{}
	s.cachedMu.Unlock()
}
