package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"latiaomei/internal/store"
)

// ============================================================
// 流水线（v6）：worker ↔ 服务端的全部对话。
// worker（tools/pipeline）用 LATIAOMEI_PIPELINE_TOKEN 静态 Bearer 鉴权，
// 权限刻意收窄：只能领任务、看内容、建草稿、核销配额——不能删内容、不能管人。
// ============================================================

// pipe 校验流水线 token。未配置 token 时整个通道视为关闭（503），比默默放行安全。
func (s *Server) pipe(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.PipelineToken == "" {
			s.jsonErr(w, http.StatusServiceUnavailable, "流水线未启用：服务端未配置 LATIAOMEI_PIPELINE_TOKEN")
			return
		}
		tok, ok := bearerToken(r)
		if !ok || subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.PipelineToken)) != 1 {
			s.jsonErr(w, http.StatusUnauthorized, "流水线 token 不正确")
			return
		}
		next(w, r.WithContext(withActor(r.Context(), &Actor{Kind: "pipeline", Name: "pipeline", Role: "worker"}, time.Now().Add(time.Hour), true)))
	}
}

// bearerToken 只取 Authorization: Bearer 的值。
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, bearerPrefix) {
		if t := strings.TrimSpace(h[len(bearerPrefix):]); t != "" {
			return t, true
		}
	}
	return "", false
}

// ---- 三端用户的小令牌（HMAC 签的 openid，免建会话表）----

const mpTokenTTL = 30 * 24 * 3600

func (s *Server) mpSign(channel, openid string) string {
	exp := time.Now().Unix() + mpTokenTTL
	pay := channel + "|" + openid + "|" + strconv.FormatInt(exp, 10)
	mac := hmac.New(sha256.New, []byte(s.cfg.Secret))
	mac.Write([]byte(pay))
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString([]byte(pay)) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// mpVerify 验签并返回 channel/openid。
func (s *Server) mpVerify(tok string) (string, string, bool) {
	i := strings.LastIndexByte(tok, '.')
	if i <= 0 {
		return "", "", false
	}
	payRaw, err := base64.RawURLEncoding.DecodeString(tok[:i])
	if err != nil {
		return "", "", false
	}
	sigGot, err := base64.RawURLEncoding.DecodeString(tok[i+1:])
	if err != nil {
		return "", "", false
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.Secret))
	mac.Write(payRaw)
	if !hmac.Equal(mac.Sum(nil), sigGot) {
		return "", "", false
	}
	segs := strings.Split(string(payRaw), "|")
	if len(segs) != 3 {
		return "", "", false
	}
	exp, _ := strconv.ParseInt(segs[2], 10, 64)
	if exp < time.Now().Unix() {
		return "", "", false
	}
	return segs[0], segs[1], true
}

// ---- worker：任务生命周期 ----

func (s *Server) hPipeTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := intQuery(q.Get("limit"), 5, 20)
	tasks, err := s.st.ListTasks(pick(q.Get("status"), "pending", "running", "done", "failed", "skipped", "all"),
		q.Get("type"), limit)
	if err != nil {
		log500(s, w, err, "列任务")
		return
	}
	if tasks == nil {
		tasks = []store.Task{}
	}
	s.jsonOK(w, map[string]any{"tasks": tasks})
}

// hPipePoll 领取一批可执行任务。max_attempts 由 worker 决定策略，服务端给默认 3。
func (s *Server) hPipePoll(w http.ResponseWriter, r *http.Request) {
	maxA := intQuery(r.URL.Query().Get("max_attempts"), 3, 10)
	limit := intQuery(r.URL.Query().Get("limit"), 3, 20)
	tasks, err := s.st.PollTasks(s.st.Now().Unix(), maxA, limit)
	if err != nil {
		log500(s, w, err, "领任务")
		return
	}
	if tasks == nil {
		tasks = []store.Task{}
	}
	s.jsonOK(w, map[string]any{"tasks": tasks, "server_time": s.st.Now().Unix()})
}

func (s *Server) hPipeClaim(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.ClaimTask(id); err != nil {
		s.jsonErr(w, http.StatusConflict, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "status": "running"})
}

func (s *Server) hPipeFinish(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"` // done | failed | skipped
		Result string `json:"result"`
		Error  string `json:"error"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.FinishTask(id, b.Status, b.Result, b.Error); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// 链式发布：平台发布任务终结后，同内容同平台若还有已放行稿（入队时被去重挡住），补排一条。
	if b.Status == "done" || b.Status == "skipped" || b.Status == "failed" {
		s.chainNextSocialTask(id)
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status})
}

// hPipeEnqueue worker 也能主动入队（如 draft_gen 完成后排产视频、按指令补发文）。
// 防护：发布类任务（四平台）必须携带已放行的 item_id 才能入队——
// 机器可以催产内容，但不能绕过人审直接发。
func (s *Server) hPipeEnqueue(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Type     string          `json:"type"`
		ReviewID int64           `json:"review_id"`
		RunAfter int64           `json:"run_after"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !store.ValidTaskType(b.Type) {
		s.jsonErr(w, http.StatusBadRequest, "未知任务类型")
		return
	}
	if store.ValidSocialPlatform(b.Type) {
		var pl struct {
			ItemID int64 `json:"item_id"`
		}
		_ = json.Unmarshal(b.Payload, &pl)
		it, err := s.st.GetSocialItem(pl.ItemID)
		if err != nil || it.Status != "approved" {
			s.jsonErr(w, http.StatusForbidden, "发布任务必须携带已放行的 item_id：机器不能跳过人审自己发")
			return
		}
	}
	// v13：项目步骤任务重排（如 LLM 配额顺延）走专属入队，保持 step 语义不去重。
	if b.Type == store.TaskProjectStep {
		var pl struct {
			ProjectID int64 `json:"project_id"`
			StepID    int64 `json:"step_id"`
		}
		_ = json.Unmarshal(b.Payload, &pl)
		if pl.ProjectID <= 0 || pl.StepID <= 0 {
			s.jsonErr(w, http.StatusBadRequest, "project_step 重排需携带 payload.project_id/step_id")
			return
		}
		// 旧任务还挂在步骤上时先撤下，否则新任务的 (type,review_id) 会撞唯一索引。
		_ = s.st.SkipProjectStepTask(pl.StepID)
		taskID, err := s.st.EnqueueProjectStep(pl.ProjectID, pl.StepID, string(b.Payload), b.RunAfter)
		if err != nil {
			log500(s, w, err, "重排项目步骤")
			return
		}
		// 重排后步骤回到 pending（配额顺延路径里它刚被标成 skipped），否则回填会被终态拦住。
		if err := s.st.ReopenProjectStep(pl.StepID, taskID); err != nil {
			log500(s, w, err, "重开项目步骤")
			return
		}
		s.jsonOK(w, map[string]any{"added": true, "task_id": taskID})
		return
	}
	added, err := s.st.EnqueueTask(b.Type, b.ReviewID, b.Payload, b.RunAfter)
	if err != nil {
		log500(s, w, err, "入队")
		return
	}
	s.jsonOK(w, map[string]any{"added": added})
}

// ---- worker：读内容 / 产草稿 ----

// hPipeReview 完整内容（含正文）+ 绝对化图片 URL，worker 拿去渲染视频/写文章。
func (s *Server) hPipeReview(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	rv, err := s.st.GetReviewByID(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "内容不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读内容")
		return
	}
	s.jsonOK(w, map[string]any{"review": rv, "site": s.siteForPipeline()})
}

// siteForPipeline 把设置里的相对图片路径补成绝对 URL，worker 下载素材不用自己拼。
func (s *Server) siteForPipeline() map[string]string {
	set, _ := s.st.Settings()
	base := "https://" + s.cfg.Domain
	fix := func(p string) string {
		if strings.HasPrefix(p, "/") {
			return base + p
		}
		return p
	}
	out := make(map[string]string, len(set))
	for k, v := range set {
		if k == "ip_avatar" || k == "cover" {
			v = fix(v)
		}
		out[k] = v
	}
	out["base_url"] = base
	return out
}

func (s *Server) hPipeListReviews(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	size := intQuery(q.Get("size"), 20, 100)
	page, err := s.st.ListReviews(store.ReviewFilter{
		Status: pick(q.Get("status"), "published", "draft", "all"),
		Kind:   pick(q.Get("kind"), "tandian", "yushanfang", "all"),
		Sort:   pick(q.Get("sort"), "new"),
		Page:   intQuery(q.Get("page"), 1, 10000),
		Size:   size,
	})
	if err != nil {
		log500(s, w, err, "查内容")
		return
	}
	s.jsonOK(w, page)
}

// hPipeCreateReview AI 产草稿专用：服务端强制 status=draft——
// 机器只能提案，发布权永远在辣条妹的审核点击里。
func (s *Server) hPipeCreateReview(w http.ResponseWriter, r *http.Request) {
	var b reviewBody
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if b.Dish = strings.TrimSpace(b.Dish); b.Dish == "" {
		s.jsonErr(w, http.StatusBadRequest, "菜名不能为空")
		return
	}
	rv := &store.Review{
		Slug: b.Slug, Kind: b.Kind, ShopID: b.ShopID, Dish: b.Dish, Tier: b.Tier, Score: b.Score,
		Spicy: b.Spicy, Price: b.Price, Headline: b.Headline, Body: b.Body, OrderTip: b.OrderTip,
		Revisit: b.Revisit, VisitDate: b.VisitDate, Cover: b.Cover, Images: b.Images,
		Featured: false, RankNo: 0, Status: "draft", Wheel: true,
	}
	if !store.ValidKind(rv.Kind) {
		rv.Kind = store.KindTandian
	}
	if rv.Tier == "" {
		rv.Tier = "npc"
	}
	if !store.ValidTier(rv.Tier) {
		s.jsonErr(w, http.StatusBadRequest, "档位非法")
		return
	}
	if err := s.st.SaveReview(rv, b.Tastes); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			s.jsonErr(w, http.StatusConflict, "slug 已存在，AI 草稿请换 slug 或先查再写")
			return
		}
		log500(s, w, err, "存草稿")
		return
	}
	out, err := s.st.GetReviewByID(rv.ID)
	if err != nil {
		log500(s, w, err, "回读草稿")
		return
	}
	s.auditAs(r, "pipeline draft-create", strconv.FormatInt(rv.ID, 10))
	s.jsonOK(w, out)
}

// ---- worker：指令与配额、配置 ----

func (s *Server) hPipeDirectives(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListDirectives("open", 50)
	if err != nil {
		log500(s, w, err, "读指令")
		return
	}
	if list == nil {
		list = []store.Directive{}
	}
	s.jsonOK(w, map[string]any{"directives": list})
}

func (s *Server) hPipeDirectiveDone(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"` // done | cancelled
		Note   string `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if b.Status != "done" && b.Status != "cancelled" {
		s.jsonErr(w, http.StatusBadRequest, "只能回填 done/cancelled")
		return
	}
	if err := s.st.SetDirectiveStatus(id, b.Status, b.Note); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status})
}

func (s *Server) hPipeSubscribers(w http.ResponseWriter, r *http.Request) {
	ch := pick(r.URL.Query().Get("channel"), "wxmini", "dymini", "gzh")
	subs, err := s.st.ListSubscribers(ch, intQuery(r.URL.Query().Get("limit"), 200, 1000))
	if err != nil {
		log500(s, w, err, "读订阅者")
		return
	}
	if subs == nil {
		subs = []store.Subscriber{}
	}
	s.jsonOK(w, map[string]any{"subscribers": subs})
}

func (s *Server) hPipeConsume(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Channel string `json:"channel"`
		OpenID  string `json:"openid"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !store.ValidMPChannel(b.Channel) || b.OpenID == "" {
		s.jsonErr(w, http.StatusBadRequest, "channel/openid 非法")
		return
	}
	if err := s.st.ConsumeQuota(b.Channel, b.OpenID); err != nil {
		log500(s, w, err, "核销配额")
		return
	}
	s.jsonOK(w, map[string]any{"consumed": true})
}

// hPipeSettings 下发运行参数（模板 ID、日产量上限等），worker 不必再抄一遍 env。
func (s *Server) hPipeSettings(w http.ResponseWriter, r *http.Request) {
	all, err := s.st.Settings()
	if err != nil {
		log500(s, w, err, "读配置")
		return
	}
	keys := []string{"pipeline_enabled", "pipeline_video", "pipeline_gzh", "pipeline_wxpush",
		"pipeline_douyin", "pipeline_xiaohongshu", "pipeline_zhihu", "pipeline_weibo",
		"wx_sub_tpl_id", "gzh_tpl_id", "video_daily_cap", "ip_name", "ip_handle", "ip_avatar",
		"douyin_url", "site_title", "site_tagline",
		// v13 项目制：主角定妆参考图 + happyhorse 开关
		"ip_char_three_view", "ip_char_closeup", "pipeline_happyhorse"}
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		out[k] = all[k]
	}
	s.jsonOK(w, map[string]any{"settings": out, "review_base": "https://" + s.cfg.Domain + "/review/"})
}

// ---- 辣条妹的管理端接口（复用后台会话/审计；小程序「指挥中心」页用）----

func (s *Server) hAdminDirectives(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListDirectives(pick(r.URL.Query().Get("status"), "open", "done", "cancelled", "all"), 100)
	if err != nil {
		log500(s, w, err, "读指令")
		return
	}
	if list == nil {
		list = []store.Directive{}
	}
	s.jsonOK(w, map[string]any{"directives": list})
}

func (s *Server) hAdminAddDirective(w http.ResponseWriter, r *http.Request) {
	var b store.Directive
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	b.CreatedBy = actorFrom(r.Context()).Label()
	if err := s.st.AddDirective(&b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"ok": true})
}

func (s *Server) hAdminDirectiveStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetDirectiveStatus(id, b.Status, b.Note); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status})
}

func (s *Server) hAdminDeleteDirective(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.DeleteDirective(id); err != nil {
		s.jsonErr(w, http.StatusNotFound, "指令不存在")
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "deleted": true})
}

func (s *Server) hAdminTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tasks, err := s.st.ListTasks(pick(q.Get("status"), "pending", "running", "done", "failed", "skipped", "all"),
		q.Get("type"), intQuery(q.Get("limit"), 50, 200))
	if err != nil {
		log500(s, w, err, "读任务")
		return
	}
	sum, _ := s.st.TaskSummary()
	socialSum, _ := s.st.SocialItemSummary()
	stats, _ := s.st.MPStats()
	if tasks == nil {
		tasks = []store.Task{}
	}
	if stats == nil {
		stats = []map[string]any{}
	}
	s.jsonOK(w, map[string]any{"tasks": tasks, "summary": sum, "social_summary": socialSum, "reach": stats,
		"pipeline_on": s.cfg.PipelineToken != ""})
}

func (s *Server) hAdminTaskAction(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	switch r.PathValue("action") {
	case "retry":
		err = s.st.RetryTask(id)
	case "skip":
		err = s.st.SkipTask(id)
	default:
		s.jsonErr(w, http.StatusBadRequest, "未知操作")
		return
	}
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "action": r.PathValue("action")})
}

// hAdminEnqueue 手动补发渠道（比如公众号开关当时关着，过后想补一篇）。
func (s *Server) hAdminEnqueue(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Type     string `json:"type"`
		ReviewID int64  `json:"review_id"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !store.ValidTaskType(b.Type) || store.ValidSocialPlatform(b.Type) {
		// 四平台发布任务不走这里：得先在待审列表里放行（见 hAdminSocialApprove）。
		s.jsonErr(w, http.StatusBadRequest, "未知任务类型；发布类任务请走「待审文案→放行」")
		return
	}
	if b.ReviewID > 0 {
		if _, err := s.st.GetReviewByID(b.ReviewID); err != nil {
			s.jsonErr(w, http.StatusBadRequest, "内容不存在")
			return
		}
	}
	added, err := s.st.EnqueueTask(b.Type, b.ReviewID, nil, 0)
	if err != nil {
		log500(s, w, err, "入队")
		return
	}
	s.jsonOK(w, map[string]any{"added": added})
}

// ============================================================
// v9 发任务（mission）与四平台文案人审：管理小程序「AI 流水线」页专用。
// ============================================================

// hAdminMission 发任务：选一条内容 + 若干平台，入队一个 social_gen 任务。
// worker 负产平台化文案进待审列表；这里不碰发布，发布只能靠后面的放行动作。
func (s *Server) hAdminMission(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ReviewID  int64    `json:"review_id"`
		Platforms []string `json:"platforms"`
		Note      string   `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if b.ReviewID <= 0 {
		s.jsonErr(w, http.StatusBadRequest, "请选择一条内容")
		return
	}
	rv, err := s.st.GetReviewByID(b.ReviewID)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "内容不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读内容")
		return
	}
	if rv.Status != "published" {
		s.jsonErr(w, http.StatusBadRequest, "只能给已发布的内容发分发任务（草稿先审核发布）")
		return
	}
	seen := map[string]bool{}
	plats := make([]string, 0, len(b.Platforms))
	for _, p := range b.Platforms {
		if !store.ValidSocialPlatform(p) || seen[p] {
			s.jsonErr(w, http.StatusBadRequest, "平台不合法："+p)
			return
		}
		seen[p] = true
		plats = append(plats, p)
	}
	if len(plats) == 0 {
		s.jsonErr(w, http.StatusBadRequest, "至少选一个平台")
		return
	}
	actor := actorFrom(r.Context())
	payload := map[string]any{"review_id": b.ReviewID, "platforms": plats, "note": b.Note, "by": actor.Label()}
	added, err := s.st.EnqueueTask(store.TaskSocialGen, b.ReviewID, payload, 0)
	if err != nil {
		log500(s, w, err, "发任务")
		return
	}
	s.auditAs(r, "pipeline mission", strconv.FormatInt(b.ReviewID, 10))
	s.jsonOK(w, map[string]any{"added": added, "platforms": plats,
		"hint": "文案进「待审」后辣条妹放行才会自动发；未入队说明同内容已有未终结的生成任务"})
}

func (s *Server) hAdminSocialItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := s.st.ListSocialItems(pick(q.Get("status"), "pending", "approved", "rejected", "published", "failed", "all"),
		q.Get("platform"), intQuery(q.Get("limit"), 50, 200))
	if err != nil {
		log500(s, w, err, "读待审文案")
		return
	}
	if items == nil {
		items = []store.SocialItem{}
	}
	sum, _ := s.st.SocialItemSummary()
	s.jsonOK(w, map[string]any{"items": items, "summary": sum})
}

// hAdminSocialSave 改稿：标题/正文/话题。已发布/已驳回的不动。
func (s *Server) hAdminSocialSave(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Title string   `json:"title"`
		Body  string   `json:"body"`
		Tags  []string `json:"tags"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(b.Body) == "" {
		s.jsonErr(w, http.StatusBadRequest, "正文不能清空")
		return
	}
	for i, t := range b.Tags {
		b.Tags[i] = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	}
	tags, _ := json.Marshal(b.Tags)
	if err := s.st.SaveSocialDraft(id, strings.TrimSpace(b.Title), b.Body, tags); err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "文案不存在或已发布/已驳回")
		return
	} else if err != nil {
		log500(s, w, err, "改稿")
		return
	}
	s.auditAs(r, "pipeline social-save", strconv.FormatInt(id, 10))
	s.jsonOK(w, map[string]any{"id": id, "saved": true})
}

// hAdminSocialAction 放行 / 驳回。放行才入队发布；驳回连带撤未跑的发布任务。
func (s *Server) hAdminSocialAction(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Note string `json:"note"`
	}
	_ = decode(r, &b)
	actor := actorFrom(r.Context()).Label()
	switch act := r.PathValue("action"); act {
	case "approve":
		err = s.st.ApproveSocialItem(id, actor)
	case "reject":
		err = s.st.RejectSocialItem(id, actor, b.Note)
	default:
		s.jsonErr(w, http.StatusBadRequest, "未知操作")
		return
	}
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "文案不存在")
		return
	}
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditAs(r, "pipeline social-"+r.PathValue("action"), strconv.FormatInt(id, 10))
	s.jsonOK(w, map[string]any{"id": id, "action": r.PathValue("action")})
}

// ---- worker 侧 social_items 通道 ----

// chainNextSocialTask 若刚终结的是四平台发布任务，且同 review+platform 还有已放行稿，
// 补排下一条发布任务（放行时被 uq_task_open 去重挡住的滞留稿不丢发）。
func (s *Server) chainNextSocialTask(taskID int64) {
	t, err := s.st.GetTask(taskID)
	if err != nil || !store.ValidSocialPlatform(t.Type) {
		return
	}
	if nx, err := s.st.NextApprovedItem(t.ReviewID, t.Type); err == nil {
		_, _ = s.st.EnqueueTask(t.Type, t.ReviewID, map[string]any{"item_id": nx.ID}, 0)
	}
}

// hPipeCreateSocialItem AI 产完一个平台的文案就落一条待审。服务端强制 pending。
func (s *Server) hPipeCreateSocialItem(w http.ResponseWriter, r *http.Request) {
	var b store.SocialItem
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if b.ReviewID < 0 {
		s.jsonErr(w, http.StatusBadRequest, "review_id 非法")
		return
	}
	// v10：视频工坊产出的稿没有关联点评（review_id=0），但同样强制 pending 等人工放行。
	if b.ReviewID == 0 && !store.ValidSocialPlatform(b.Platform) {
		s.jsonErr(w, http.StatusBadRequest, "review_id=0 的稿子必须是平台稿")
		return
	}
	if err := s.st.CreateSocialItem(&b); err != nil {
		log500(s, w, err, "落待审文案")
		return
	}
	s.jsonOK(w, b)
}

// hPipeGetSocialItem 发布前回读：worker 据此判断 item 是否仍处 approved（驳回/改稿的即时生效）。
func (s *Server) hPipeGetSocialItem(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	it, err := s.st.GetSocialItem(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "文案不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读文案")
		return
	}
	s.jsonOK(w, it)
}

// hPipeSocialResult worker 回填发布结果（published/failed）。
func (s *Server) hPipeSocialResult(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"`
		Result string `json:"result"`
		Note   string `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetSocialItemResult(id, b.Status, b.Result, b.Note); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status})
}
