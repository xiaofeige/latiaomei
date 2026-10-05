package httpapi

import (
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"latiaomei/internal/stats"
)

// statusWriter 记下状态码，供统计判断 5xx。
type statusWriter struct {
	http.ResponseWriter
	code int
	n    int
}

func (w *statusWriter) WriteHeader(c int) {
	if w.code == 0 {
		w.code = c
	}
	w.ResponseWriter.WriteHeader(c)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(p)
	w.n += n
	return n, err
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// withMiddleware 是所有中间件的组装点。
func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}

		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("http: panic %v %s\n%s", rec, r.URL.Path, debug.Stack())
				if sw.code == 0 {
					s.jsonErr(sw, http.StatusInternalServerError, "服务器开了个小差")
				}
			}
			s.observe(r, sw)
		}()

		h := sw.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		// 后台页面禁止被索引；公开页由 HTML 里的 meta 控制。
		if strings.HasPrefix(r.URL.Path, "/admin") {
			h.Set("X-Robots-Tag", "noindex, nofollow")
		}

		// 只允许本站表单/后台跨源提交？这里不引入 CORS：接口只给同源前端用。
		if r.Method == http.MethodOptions {
			sw.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		next.ServeHTTP(sw, r)

		if d := time.Since(start); d > 3*time.Second {
			log.Printf("http: 慢请求 %s %s 耗时 %s", r.Method, r.URL.Path, d)
		}
	})
}

// observe 把一次请求翻译成统计事件。
func (s *Server) observe(r *http.Request, sw *statusWriter) {
	path := r.URL.Path
	ua := r.UserAgent()
	hit := stats.Hit{
		When:   time.Now(),
		IP:     clientIP(r),
		UA:     ua,
		Path:   path,
		Ref:    r.Header.Get("Referer"),
		Status: sw.code,
		IsBot:  stats.IsBot(ua),
	}
	switch {
	case path == "/api/healthz", path == "/api/track", path == "/favicon.ico":
		return // 探针和自埋点不重复计数
	case strings.HasPrefix(path, "/api/admin/"):
		hit.Kind = stats.KindAdmin
	case strings.HasPrefix(path, "/api/"):
		hit.Kind = stats.KindAPI
	case strings.HasPrefix(path, "/uploads/"), isAssetPath(path):
		hit.Kind = stats.KindAsset
	case r.Method != http.MethodGet:
		return
	default:
		hit.Kind = stats.KindDoc
		hit.TopKind, hit.TopKey = contentOf(path)
	}
	s.col.Observe(hit)
}

// contentOf 从 URL 里认出这是哪条点评/哪家店，喂给内容热榜。
func contentOf(path string) (string, string) {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	if len(segs) == 2 {
		switch segs[0] {
		case "review":
			return "review", segs[1]
		case "shop":
			return "shop", segs[1]
		}
	}
	return "", ""
}

func isAssetPath(p string) bool {
	for _, ext := range []string{".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".webp", ".gif",
		".svg", ".ico", ".woff", ".woff2", ".map", ".txt", ".xml", ".json", ".mp4"} {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}
