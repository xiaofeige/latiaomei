package stats

import (
	"net/url"
	"strings"
)

// normalizePath 把路径规整成低基数形态：纯数字段和长十六进制段换成 :id，
// 非 ASCII 折叠成 ~，静态资源直接归到 (assets)。
// 目的是让扫描器造出来的怪 URL 无法把 stat_path 撑成几万行。
func normalizePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return "/"
	}
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if len(p) > maxPathLen {
		p = p[:maxPathLen]
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		if s == "" {
			continue
		}
		if isNumeric(s) || (len(s) >= 10 && isHexish(s)) {
			segs[i] = ":id"
			continue
		}
		var b strings.Builder
		for _, r := range strings.ToLower(s) {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
				b.WriteRune(r)
			case r > 127:
				b.WriteRune('~') // 中文路径折叠，避免百分号编码长串占坑
			}
		}
		segs[i] = b.String()
	}
	out := strings.Join(segs, "/")
	if !strings.HasPrefix(out, "/") {
		out = "/" + out
	}
	for _, ext := range assetExts {
		if strings.HasSuffix(out, ext) {
			return "(assets)"
		}
	}
	return out
}

var assetExts = []string{".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".webp", ".gif",
	".svg", ".ico", ".woff", ".woff2", ".ttf", ".map", ".txt", ".xml", ".json", ".rss", ".mp4"}

// normalizeRef 只留来源域名，不带路径和 query（既省磁盘也少点隐私风险）。
func normalizeRef(ref, selfHost string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "direct"
	}
	if !strings.Contains(ref, "//") {
		ref = "//" + ref
	}
	u, err := url.Parse(ref)
	if err != nil {
		return "direct"
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "direct"
	}
	if selfHost != "" && (host == selfHost || strings.HasSuffix(host, "."+selfHost)) {
		return "internal"
	}
	if len(host) > 80 {
		host = host[:80]
	}
	return host
}

// IsBot 判定爬虫/探针。只影响它进 bot 计数而不进 PV/UV。
// 微信、抖音内置浏览器属于真实读者，不算 bot。
func IsBot(ua string) bool {
	l := strings.ToLower(ua)
	if l == "" {
		return true // 空 UA 基本是脚本
	}
	for _, m := range botMarkers {
		if strings.Contains(l, m) {
			return true
		}
	}
	return false
}

var botMarkers = []string{
	"bot", "crawl", "spider", "slurp", "python-requests", "python-urllib", "curl/", "wget",
	"okhttp", "java/", "go-http-client", "httpclient", "scrapy", "feedspot", "semrush",
	"ahrefs", "dotbot", "petalbot", "applebot", "duckduckbot", "yandex", "baiduspider",
	"googlebot", "bingbot", "sogou", "bytespider", "bytedance", "pptx", "lighthouse",
	"headless", "phantom", "selenium", "puppet", "monitor", "uptime", "statuspage",
	"datadog", "newrelic", "zabbix", "prometheus", "nagios", "checker", "scanner",
	"censys", "net systems", "curl", "w3c_", "validator", "cybersec", "researchscan",
}

func deviceOf(ua string) string {
	l := strings.ToLower(ua)
	switch {
	case strings.Contains(l, "ipad"), strings.Contains(l, "tablet"):
		return "tablet"
	case strings.Contains(l, "mobile"), strings.Contains(l, "android"), strings.Contains(l, "iphone"):
		return "mobile"
	case l == "":
		return "unknown"
	default:
		return "desktop"
	}
}

// uaClass 参与 UV 指纹：粗分设备类别，避免同一个人升级浏览器就被算成两个人。
func uaClass(ua string) string { return deviceOf(ua) }

// ipKey 把 IP 做前缀聚合：IPv4 /24、IPv6 /64。
// 既防止 v6 尾号轮换刷出虚高 UV，也保证库里/内存里都不落完整 IP。
func ipKey(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "unknown"
	}
	if strings.Contains(ip, ":") {
		parts := strings.Split(ip, ":")
		if len(parts) >= 4 {
			return strings.Join(parts[:4], ":")
		}
		return ip
	}
	if i := strings.LastIndex(ip, "."); i > 0 {
		return ip[:i]
	}
	return ip
}

func sanitizeKey(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isHexish(s string) bool {
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}
