package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"latiaomei/internal/store"
)

// ============================================================
// v13 项目制内容生产：管理小程序「项目」页 + worker 通道。
// 与旧「一键视频工坊」的区别：立项后是一个可反复交互的工作区——
// 加素材、改提示词、分步跑（出分镜→人改分镜→出成片→出文案），
// 每步一条 step 留痕；产物照旧只能进 social_items 等人工放行。
// ============================================================

// ---- 管理端（辣条妹）----

func (s *Server) hAdminProjects(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := s.st.ListProjects(pick(q.Get("status"), "open", "review", "done", "archived", "all"),
		intQuery(q.Get("limit"), 50, 200))
	if err != nil {
		log500(s, w, err, "列项目")
		return
	}
	if list == nil {
		list = []store.Project{}
	}
	s.jsonOK(w, map[string]any{"projects": list})
}

// hAdminCreateProject 立项：标题 + 制片提示词 + 首批素材（已上传的 /uploads/ 路径）。
func (s *Server) hAdminCreateProject(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Title  string   `json:"title"`
		Brief  string   `json:"brief"`
		Images []string `json:"images"`
		Opts   string   `json:"opts"` // JSON 字符串，原样入库
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(b.Title) == "" {
		s.jsonErr(w, http.StatusBadRequest, "项目标题不能空")
		return
	}
	p := &store.Project{
		Title: b.Title, Brief: strings.TrimSpace(b.Brief), Status: "open",
		Opts: json.RawMessage(orDefaultJSON(b.Opts)), CreatedBy: actorFrom(r.Context()).Label(),
	}
	if err := s.st.CreateProject(p); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, path := range b.Images {
		if !strings.HasPrefix(path, "/uploads/") {
			continue
		}
		_ = s.st.AddProjectAsset(&store.ProjectAsset{ProjectID: p.ID, Path: path, Kind: assetKindOf(path)})
	}
	s.auditAs(r, "project create", strconv.FormatInt(p.ID, 10))
	out, _ := s.st.GetProject(p.ID)
	s.jsonOK(w, out)
}

// hAdminProjectDetail 项目工作区全量：项目 + 素材 + 步骤时间线。
func (s *Server) hAdminProjectDetail(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	p, err := s.st.GetProject(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读项目")
		return
	}
	assets, _ := s.st.ListProjectAssets(id)
	steps, _ := s.st.ListProjectSteps(id)
	if assets == nil {
		assets = []store.ProjectAsset{}
	}
	if steps == nil {
		steps = []store.ProjectStep{}
	}
	s.jsonOK(w, map[string]any{"project": p, "assets": assets, "steps": steps})
}

// hAdminProjectSave 编辑项目（标题/提示词/状态/参数按需传）。
func (s *Server) hAdminProjectSave(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Title  *string `json:"title"`
		Brief  *string `json:"brief"`
		Status *string `json:"status"`
		Opts   *string `json:"opts"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var opts *json.RawMessage
	if b.Opts != nil {
		o := json.RawMessage(orDefaultJSON(*b.Opts))
		opts = &o
	}
	p, err := s.st.SaveProject(id, b.Title, b.Brief, b.Status, opts)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditAs(r, "project save", strconv.FormatInt(id, 10))
	s.jsonOK(w, p)
}

func (s *Server) hAdminProjectDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.DeleteProject(id); err != nil {
		if err == store.ErrNotFound {
			s.jsonErr(w, http.StatusNotFound, "项目不存在")
			return
		}
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditAs(r, "project delete", strconv.FormatInt(id, 10))
	s.jsonOK(w, map[string]any{"id": id, "deleted": true})
}

// hAdminProjectAsset 工作区加素材（图先走 /api/admin/upload 拿路径）。
func (s *Server) hAdminProjectAsset(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b store.ProjectAsset
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	b.ProjectID = id
	if b.Kind == "" {
		b.Kind = assetKindOf(b.Path)
	}
	if err := s.st.AddProjectAsset(&b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, b)
}

func (s *Server) hAdminProjectAssetDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	aid, err := strconv.ParseInt(r.PathValue("aid"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "aid 非法")
		return
	}
	if err := s.st.DeleteProjectAsset(id, aid); err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "素材不存在")
		return
	} else if err != nil {
		log500(s, w, err, "删素材")
		return
	}
	s.jsonOK(w, map[string]any{"id": aid, "deleted": true})
}

// ValidRenderer 出片渲染引擎白名单：hyperframes=图文卡渲染（默认）；
// openmontage=OpenMontage 纯动态剪辑（每镜 happyhorse 生视频 + video_stitch 拼接）。
func ValidRenderer(r string) bool { return r == "hyperframes" || r == "openmontage" }

// hAdminProjectStep 跑一步：kind=storyboard|video|copy，prompt 为本轮附加指令（可空）。
// video 步可带 storyboard_step_id 指定用哪一版（手）分镜，缺省用最近一条已完成的分镜；
// renderer 选出片引擎（hyperframes|openmontage，缺省用项目 opts.renderer，再缺省 hyperframes）。
func (s *Server) hAdminProjectStep(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Kind               string `json:"kind"`
		Prompt             string `json:"prompt"`
		StoryboardStepID   int64  `json:"storyboard_step_id"`
		Renderer           string `json:"renderer"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	p, err := s.st.GetProject(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读项目")
		return
	}
	if p.Status == "archived" {
		s.jsonErr(w, http.StatusBadRequest, "项目已归档，先恢复再跑")
		return
	}
	if !store.ValidStepKind(b.Kind) {
		s.jsonErr(w, http.StatusBadRequest, "未知步骤类型（storyboard/video/copy）")
		return
	}
	if b.Kind == "storyboard" && strings.TrimSpace(p.Brief) == "" && strings.TrimSpace(b.Prompt) == "" {
		s.jsonErr(w, http.StatusBadRequest, "提示词还是空的，先写两句制片说明")
		return
	}
	if b.Kind == "video" {
		// 校验指定分镜可用；不指定则要求项目里存在已完成的分镜。
		if b.StoryboardStepID > 0 {
			st, err := s.st.GetProjectStep(b.StoryboardStepID)
			if err != nil || st.ProjectID != id || st.Kind != "storyboard" || st.Status != "done" || strings.TrimSpace(st.Result) == "" {
				s.jsonErr(w, http.StatusBadRequest, "指定的分镜步骤不可用（不存在/不属于本项目/没跑完）")
				return
			}
		} else {
			steps, _ := s.st.ListProjectSteps(id)
			found := false
			for _, st := range steps {
				if st.Kind == "storyboard" && st.Status == "done" && strings.TrimSpace(st.Result) != "" {
					found = true
					break
				}
			}
			if !found {
				s.jsonErr(w, http.StatusBadRequest, "还没有可用的分镜，先跑「出分镜」")
				return
			}
		}
	}
	actor := actorFrom(r.Context()).Label()
	// 渲染引擎：步骤显式指定 > 项目 opts.renderer > 默认 hyperframes。
	renderer := b.Renderer
	if renderer == "" {
		var opts struct {
			Renderer string `json:"renderer"`
		}
		_ = json.Unmarshal(p.Opts, &opts)
		renderer = opts.Renderer
	}
	if renderer == "" {
		renderer = "hyperframes"
	}
	if !ValidRenderer(renderer) {
		s.jsonErr(w, http.StatusBadRequest, "未知渲染引擎（hyperframes/openmontage）")
		return
	}
	st := &store.ProjectStep{ProjectID: id, Kind: b.Kind, Prompt: strings.TrimSpace(b.Prompt), CreatedBy: actor}
	if err := s.st.CreateProjectStep(st); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	payload := map[string]any{"project_id": id, "step_id": st.ID, "kind": b.Kind, "renderer": renderer}
	if b.StoryboardStepID > 0 {
		payload["storyboard_step_id"] = b.StoryboardStepID
	}
	pj, _ := json.Marshal(payload)
	taskID, err := s.st.EnqueueProjectStep(id, st.ID, string(pj), 0)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.st.SetProjectStepTask(st.ID, taskID)
	s.auditAs(r, "project step "+b.Kind, strconv.FormatInt(id, 10))
	s.jsonOK(w, map[string]any{"step_id": st.ID, "task_id": taskID, "kind": b.Kind,
		"hint": "worker 领取后开跑；完成后回工作区看产物，不满意改提示词再跑一轮"})
}

// hAdminProjectStepSave 手改分镜：把编辑后的 storyboard JSON 写回 step，
// 之后「出成片」带 storyboard_step_id 就用这一版渲染。
func (s *Server) hAdminProjectStepSave(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Result string `json:"result"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(b.Result), &v); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "分镜不是合法 JSON，改坏了就重新出一版")
		return
	}
	if err := s.st.SaveProjectStepResult(id, b.Result); err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "步骤不存在或不是可改的分镜稿")
		return
	} else if err != nil {
		log500(s, w, err, "存分镜")
		return
	}
	s.auditAs(r, "project step-save", strconv.FormatInt(id, 10))
	s.jsonOK(w, map[string]any{"id": id, "saved": true})
}

// hAdminProjectStepRetry 重跑一步：按原 kind/prompt 再开一条新 step（历史保留）。
func (s *Server) hAdminProjectStepRetry(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	old, err := s.st.GetProjectStep(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "步骤不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读步骤")
		return
	}
	actor := actorFrom(r.Context()).Label()
	st := &store.ProjectStep{ProjectID: old.ProjectID, Kind: old.Kind, Prompt: old.Prompt, CreatedBy: actor}
	if err := s.st.CreateProjectStep(st); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	payload := map[string]any{"project_id": old.ProjectID, "step_id": st.ID, "kind": old.Kind, "retry_of": old.ID}
	pj, _ := json.Marshal(payload)
	// 旧任务若还没终结（排队中重跑），先撤下再排新的，避免同号任务撞唯一索引。
	_ = s.st.SkipProjectStepTask(old.ID)
	taskID, err := s.st.EnqueueProjectStep(old.ProjectID, st.ID, string(pj), 0)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.st.SetProjectStepTask(st.ID, taskID)
	s.auditAs(r, "project step-retry", strconv.FormatInt(old.ID, 10))
	s.jsonOK(w, map[string]any{"step_id": st.ID, "task_id": taskID, "kind": old.Kind})
}

// ---- worker 通道 ----

// hPipeProject worker 读项目全貌：项目 + 素材 + 步骤（含已手改的分镜稿）+ 主角定妆参考图。
func (s *Server) hPipeProject(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	p, err := s.st.GetProject(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读项目")
		return
	}
	assets, _ := s.st.ListProjectAssets(id)
	steps, _ := s.st.ListProjectSteps(id)
	set, _ := s.st.Settings()
	charRefs := []map[string]string{}
	for _, k := range []string{"ip_char_three_view", "ip_char_closeup"} {
		if v := set[k]; v != "" {
			charRefs = append(charRefs, map[string]string{"key": k, "path": v})
		}
	}
	s.jsonOK(w, map[string]any{"project": p, "assets": assets, "steps": steps,
		"char_refs": charRefs, "site": s.siteForPipeline()})
}

// hPipeProjectStepFinish worker 回填步骤结果（done/failed/skipped + result JSON）。
func (s *Server) hPipeProjectStepFinish(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"`
		Result string `json:"result"`
		Error  string `json:"error"`
		Note   string `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.FinishProjectStep(id, b.Status, b.Result, b.Error, b.Note); err == store.ErrNotFound {
		s.jsonErr(w, http.StatusConflict, "步骤不存在或已终结")
		return
	} else if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status})
}

// ---- 小工具 ----

func orDefaultJSON(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || !json.Valid([]byte(s)) {
		return "{}"
	}
	return s
}

// assetKindOf 按扩展名粗分素材类型；视频/音频素材 worker 走不同处理。
func assetKindOf(path string) string {
	low := strings.ToLower(path)
	if strings.HasSuffix(low, ".jpg") || strings.HasSuffix(low, ".jpeg") ||
		strings.HasSuffix(low, ".png") || strings.HasSuffix(low, ".webp") || strings.HasSuffix(low, ".gif") {
		return "image"
	}
	return "file"
}
