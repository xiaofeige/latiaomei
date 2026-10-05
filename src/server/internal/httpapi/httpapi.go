// Package httpapi 提供公开接口与后台接口，并托管前端静态文件。
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"latiaomei/internal/config"
	"latiaomei/internal/stats"
	"latiaomei/internal/store"
)

// Server 持有各层依赖。
type Server struct {
	cfg *config.Config
	st  *store.Store
	col *stats.Collector

	sessionTTL  time.Duration
	pruneCfg    store.PruneConfig
	uploadCache *sizeCache
	words       *agentWordsLoader
}

// New 构造 Server。
func New(cfg *config.Config, st *store.Store, col *stats.Collector) *Server {
	s := &Server{
		cfg:         cfg,
		st:          st,
		col:         col,
		sessionTTL:  14 * 24 * time.Hour,
		uploadCache: &sizeCache{ttl: 5 * time.Minute},
		words:       newAgentWordsLoader(cfg.WordsFile),
		pruneCfg: store.PruneConfig{
			PathDays: 400, HourDays: 45, RefDays: 200, TopDays: 200,
			PathTopN: 100, RefTopN: 50, TopTopN: 50,
			SessionTTL: 14 * 24 * time.Hour, VacuumPages: 20000,
		},
	}
	col.SetSelfHost(cfg.Domain)
	cookieSecure = cfg.CookieSecure // 会话 Cookie 的 Secure 开关，交给配置决定
	return s
}

// Handler 组装路由与中间件。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// ---- 公开接口 ----
	mux.HandleFunc("GET /api/bootstrap", s.hBootstrap)
	mux.HandleFunc("GET /api/reviews", s.hListReviews)
	mux.HandleFunc("GET /api/reviews/{slug}", s.hGetReview)
	mux.HandleFunc("GET /api/shops", s.hListShops)
	mux.HandleFunc("GET /api/shops/{slug}", s.hGetShop)
	mux.HandleFunc("GET /api/taxonomy", s.hTaxonomy)
	mux.HandleFunc("POST /api/track", s.hTrack)
	mux.HandleFunc("GET /api/healthz", s.hHealth)

	// ---- 用户端小程序（v6：微信/抖音粉丝侧，只读内容 + 订阅记账）----
	mux.HandleFunc("GET /api/mp/config", s.hMpConfig)
	mux.HandleFunc("POST /api/mp/wx/login", s.hMpWxLogin)
	mux.HandleFunc("POST /api/mp/dy/login", s.hMpDyLogin)
	mux.HandleFunc("POST /api/mp/subscribe", s.hMpSubscribe)
	mux.HandleFunc("POST /api/mp/wish", s.hMpWishNew)
	// v10 呼声墙：公开列表 + 喊一声（点赞），呼声最高的辣条妹优先去踩
	mux.HandleFunc("GET /api/mp/wish/wall", s.hMpWishWall)
	mux.HandleFunc("POST /api/mp/wish/like", s.hMpWishLike)
	// v11 吃货 AI Agent：辣条妹大脑（生成式 UI 块协议，LLM 挂了自动本地兜底）
	mux.HandleFunc("POST /api/mp/agent/chat", s.hMpAgentChat)
	mux.HandleFunc("GET /api/mp/wish/mine", s.hMpWishMine)

	// ---- 流水线 worker（v6：tools/pipeline 专用，静态 token）----
	mux.HandleFunc("GET /api/pipeline/poll", s.pipe(s.hPipePoll))
	mux.HandleFunc("GET /api/pipeline/tasks", s.pipe(s.hPipeTasks))
	mux.HandleFunc("POST /api/pipeline/tasks/{id}/claim", s.pipe(s.hPipeClaim))
	mux.HandleFunc("POST /api/pipeline/tasks/{id}/finish", s.pipe(s.hPipeFinish))
	mux.HandleFunc("POST /api/pipeline/tasks", s.pipe(s.hPipeEnqueue))
	mux.HandleFunc("POST /api/pipeline/social-items", s.pipe(s.hPipeCreateSocialItem))
	mux.HandleFunc("GET /api/pipeline/social-items/{id}", s.pipe(s.hPipeGetSocialItem))
	mux.HandleFunc("POST /api/pipeline/social-items/{id}/result", s.pipe(s.hPipeSocialResult))
	mux.HandleFunc("GET /api/pipeline/reviews", s.pipe(s.hPipeListReviews))
	mux.HandleFunc("GET /api/pipeline/reviews/{id}", s.pipe(s.hPipeReview))
	mux.HandleFunc("POST /api/pipeline/reviews", s.pipe(s.hPipeCreateReview))
	mux.HandleFunc("GET /api/pipeline/directives", s.pipe(s.hPipeDirectives))
	mux.HandleFunc("POST /api/pipeline/directives/{id}/done", s.pipe(s.hPipeDirectiveDone))
	mux.HandleFunc("GET /api/pipeline/subscribers", s.pipe(s.hPipeSubscribers))
	mux.HandleFunc("POST /api/pipeline/subscribers/consume", s.pipe(s.hPipeConsume))
	mux.HandleFunc("GET /api/pipeline/settings", s.pipe(s.hPipeSettings))
	// v13 项目制：worker 读项目全貌 + 回填步骤结果。
	mux.HandleFunc("GET /api/pipeline/projects/{id}", s.pipe(s.hPipeProject))
	mux.HandleFunc("POST /api/pipeline/project-steps/{id}/finish", s.pipe(s.hPipeProjectStepFinish))

	// ---- 后台接口 ----
	mux.HandleFunc("POST /api/admin/login", s.hLogin)
	mux.HandleFunc("POST /api/admin/logout", s.hLogout)
	mux.HandleFunc("GET /api/admin/session", s.hSession)

	// ---- 微信小程序登录（无账号密码页，微信身份即凭证）----
	mux.HandleFunc("POST /api/admin/wx/login", s.hWxLogin) // 唯一不带鉴权的入口，内部已限频
	mux.HandleFunc("GET /api/admin/wx/me", s.auth(s.hWxMe))
	mux.HandleFunc("POST /api/admin/wx/logout", s.auth(s.hWxLogout))
	mux.HandleFunc("GET /api/admin/wx/members", s.auth(s.hWxMembers))
	mux.HandleFunc("POST /api/admin/wx/members", s.auth(s.hWxMemberAction))
	mux.HandleFunc("GET /api/admin/wx/audit", s.auth(s.hWxAudit))

	mux.HandleFunc("GET /api/admin/overview", s.auth(s.hOverview))
	mux.HandleFunc("GET /api/admin/analytics", s.auth(s.hAnalytics))
	mux.HandleFunc("GET /api/admin/reviews", s.auth(s.hAdminListReviews))
	mux.HandleFunc("GET /api/admin/reviews/{id}", s.auth(s.hAdminGetReview))
	mux.HandleFunc("POST /api/admin/reviews", s.auth(s.csrf(s.hAdminSaveReview)))
	mux.HandleFunc("PUT /api/admin/reviews/{id}", s.auth(s.csrf(s.hAdminSaveReview)))
	mux.HandleFunc("DELETE /api/admin/reviews/{id}", s.auth(s.csrf(s.hAdminDeleteReview)))
	mux.HandleFunc("POST /api/admin/reviews/{id}/status", s.auth(s.csrf(s.hAdminReviewStatus)))
	mux.HandleFunc("POST /api/admin/reviews/{id}/featured", s.auth(s.csrf(s.hAdminFeatured)))
	mux.HandleFunc("POST /api/admin/reviews/{id}/wheel", s.auth(s.csrf(s.hAdminReviewWheel)))
	mux.HandleFunc("POST /api/admin/reviews/rank", s.auth(s.csrf(s.hAdminSetRanks)))

	mux.HandleFunc("GET /api/admin/shops", s.auth(s.hAdminListShops))
	mux.HandleFunc("POST /api/admin/shops", s.auth(s.csrf(s.hAdminSaveShop)))
	mux.HandleFunc("PUT /api/admin/shops/{id}", s.auth(s.csrf(s.hAdminSaveShop)))
	mux.HandleFunc("DELETE /api/admin/shops/{id}", s.auth(s.csrf(s.hAdminDeleteShop)))

	mux.HandleFunc("GET /api/admin/tastes", s.auth(s.hAdminListTastes))
	mux.HandleFunc("POST /api/admin/tastes", s.auth(s.csrf(s.hAdminSaveTaste)))
	mux.HandleFunc("PUT /api/admin/tastes/{id}", s.auth(s.csrf(s.hAdminSaveTaste)))
	mux.HandleFunc("DELETE /api/admin/tastes/{id}", s.auth(s.csrf(s.hAdminDeleteTaste)))

	mux.HandleFunc("GET /api/admin/settings", s.auth(s.hAdminSettings))
	mux.HandleFunc("PUT /api/admin/settings", s.auth(s.csrf(s.hAdminSaveSettings)))

	// ---- 指挥中心（v6：辣条妹发号施令的唯一入口）----
	mux.HandleFunc("GET /api/admin/directives", s.auth(s.hAdminDirectives))
	mux.HandleFunc("POST /api/admin/directives", s.auth(s.csrf(s.hAdminAddDirective)))
	mux.HandleFunc("POST /api/admin/directives/{id}/status", s.auth(s.csrf(s.hAdminDirectiveStatus)))
	mux.HandleFunc("DELETE /api/admin/directives/{id}", s.auth(s.csrf(s.hAdminDeleteDirective)))
	mux.HandleFunc("GET /api/admin/tasks", s.auth(s.hAdminTasks))
	mux.HandleFunc("POST /api/admin/tasks/{id}/{action}", s.auth(s.csrf(s.hAdminTaskAction)))
	mux.HandleFunc("POST /api/admin/tasks", s.auth(s.csrf(s.hAdminEnqueue)))
	mux.HandleFunc("POST /api/admin/missions", s.auth(s.csrf(s.hAdminMission)))
	mux.HandleFunc("GET /api/admin/social-items", s.auth(s.hAdminSocialItems))
	mux.HandleFunc("POST /api/admin/social-items/{id}/save", s.auth(s.csrf(s.hAdminSocialSave)))
	mux.HandleFunc("POST /api/admin/social-items/{id}/{action}", s.auth(s.csrf(s.hAdminSocialAction)))

	// ---- 许愿池（v8：粉丝许愿 → 后台分析 → 一键翻牌成指令）----
	mux.HandleFunc("GET /api/admin/wishes", s.auth(s.hAdminWishes))
	mux.HandleFunc("POST /api/admin/wishes/{id}/status", s.auth(s.csrf(s.hAdminWishStatus)))
	mux.HandleFunc("POST /api/admin/wishes/{id}/directive", s.auth(s.csrf(s.hAdminWishToDirective)))
	mux.HandleFunc("DELETE /api/admin/wishes/{id}", s.auth(s.csrf(s.hAdminWishDelete)))

	mux.HandleFunc("GET /api/admin/uploads", s.auth(s.hAdminUploads))
	mux.HandleFunc("POST /api/admin/upload", s.auth(s.csrf(s.hAdminUpload)))
	mux.HandleFunc("DELETE /api/admin/uploads/{id}", s.auth(s.csrf(s.hAdminDeleteUpload)))

	mux.HandleFunc("POST /api/admin/maintenance", s.auth(s.csrf(s.hAdminMaintenance)))
	mux.HandleFunc("GET /api/admin/export", s.auth(s.hAdminExport))
	// v10 视频工坊（管理小程序 Tab3）：提示词优化 / 做视频下单 / 非图片素材上传。
	mux.HandleFunc("POST /api/admin/ai/polish", s.auth(s.csrf(s.hAdminAiPolish)))
	mux.HandleFunc("POST /api/admin/video-missions", s.auth(s.csrf(s.hAdminVideoMission)))
	mux.HandleFunc("POST /api/admin/upload/file", s.auth(s.csrf(s.hAdminUploadFile)))
	// v13 项目制内容生产（管理小程序「项目」页）。
	mux.HandleFunc("GET /api/admin/projects", s.auth(s.hAdminProjects))
	mux.HandleFunc("POST /api/admin/projects", s.auth(s.csrf(s.hAdminCreateProject)))
	mux.HandleFunc("GET /api/admin/projects/{id}", s.auth(s.hAdminProjectDetail))
	mux.HandleFunc("PUT /api/admin/projects/{id}", s.auth(s.csrf(s.hAdminProjectSave)))
	mux.HandleFunc("DELETE /api/admin/projects/{id}", s.auth(s.csrf(s.hAdminProjectDelete)))
	mux.HandleFunc("POST /api/admin/projects/{id}/assets", s.auth(s.csrf(s.hAdminProjectAsset)))
	mux.HandleFunc("DELETE /api/admin/projects/{id}/assets/{aid}", s.auth(s.csrf(s.hAdminProjectAssetDelete)))
	mux.HandleFunc("POST /api/admin/projects/{id}/steps", s.auth(s.csrf(s.hAdminProjectStep)))
	mux.HandleFunc("POST /api/admin/project-steps/{id}/save", s.auth(s.csrf(s.hAdminProjectStepSave)))
	mux.HandleFunc("POST /api/admin/project-steps/{id}/retry", s.auth(s.csrf(s.hAdminProjectStepRetry)))

	// ---- 静态资源与 SPA ----
	mux.Handle("GET /uploads/", http.StripPrefix("/uploads/", s.uploadsServer()))
	mux.HandleFunc("GET /", s.spa)

	return s.withMiddleware(mux)
}

// uploadsServer 托管 /uploads/ 静态文件；URL 带 ?dl=1 时按「附件下载」返回。
// 用途：管理小程序「复制源文件链接」给出成片 mp4 加 dl=1，电脑浏览器粘贴即直接下载源文件。
func (s *Server) uploadsServer() http.Handler {
	fs := http.FileServer(http.Dir(s.cfg.UploadDir()))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("dl") == "1" {
			name := path.Base(r.URL.Path)
			w.Header().Set("Content-Disposition",
				`attachment; filename="`+name+`"; filename*=UTF-8''`+url.PathEscape(name))
		}
		fs.ServeHTTP(w, r)
	})
}

// 后台入口故意不用 /admin 这类一眼能猜到的路径：前台页面里不放任何链接，
// robots.txt 也屏蔽，只有站长本人知道这个地址。
const (
	adminPath = "/latiaomei"            // URL 入口
	adminPage = "/latiaomei/index.html" // 对应 web 目录下的文件
)

// spa 提供前端文件；非 /api 且找不到文件时回 index.html，交给前端路由。
func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.jsonErr(w, http.StatusNotFound, "接口不存在")
		return
	}
	p := r.URL.Path
	if p == "/" {
		p = "/index.html"
	}
	// 后台走独立页面；用 hash 路由，不需要额外回退。
	if p == adminPath || p == adminPath+"/" {
		p = adminPage
	}
	full, ok := webPath(s.cfg.WebDir, p)
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if fi, err := os.Stat(full); err == nil && !fi.IsDir() {
		setStaticCache(w, p)
		http.ServeFile(w, r, full)
		return
	}
	if strings.HasPrefix(p, adminPath) {
		setStaticCache(w, adminPage)
		http.ServeFile(w, r, s.cfg.WebDir+adminPage)
		return
	}
	// 其余（/rank、/review/xxx…）回首页，由前端接管路由。
	if strings.Contains(p, ".") {
		http.NotFound(w, r)
		return
	}
	setStaticCache(w, "/index.html")
	http.ServeFile(w, r, s.cfg.WebDir+"/index.html")
}

// webPath 把 URL 路径映射到 web 目录下的真实文件，挡住 ../ 越界。
func webPath(root, p string) (string, bool) {
	rel := filepath.Clean("/" + strings.TrimPrefix(p, "/"))
	full := filepath.Join(root, strings.TrimPrefix(rel, "/"))
	cleanRoot := filepath.Clean(root)
	if full == cleanRoot || strings.HasPrefix(full, cleanRoot+string(filepath.Separator)) {
		return full, true
	}
	return "", false
}

func setStaticCache(w http.ResponseWriter, p string) {
	switch {
	case strings.HasSuffix(p, ".html"):
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(p, "/img/"), strings.HasPrefix(p, "/css/"), strings.HasPrefix(p, "/js/"):
		w.Header().Set("Cache-Control", "public, max-age=86400")
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
}

// jsonOK 输出 data 字段。
func (s *Server) jsonOK(w http.ResponseWriter, data any) {
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data})
}

func (s *Server) jsonErr(w http.ResponseWriter, code int, msg string) {
	s.writeJSON(w, code, map[string]any{"ok": false, "error": msg})
}

func (s *Server) writeJSON(w http.ResponseWriter, code int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("http: 序列化响应: %v", err)
		http.Error(w, "internal", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_, _ = w.Write(b)
}

// decode 读 JSON 请求体，限制 1MB 防放大。
func decode(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("请求体为空")
		}
		return fmt.Errorf("JSON 解析失败: %w", err)
	}
	return nil
}

// clientIP 取 nginx 传来的真实 IP。只有本机反代才会写这些头，
// 服务只监听 127.0.0.1，因此可以信任。
func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
