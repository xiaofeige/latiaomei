package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ============================================================
// v13 项目制内容生产（projects / project_assets / project_steps）
// 一条视频或一组文案 = 一个项目，而不是一次 pipeline 跑到底：
// 辣条妹先立项 → 工作区反复加素材、改提示词 → 分步跑（出分镜 → 人改分镜 →
// 出成片 → 出平台文案），每一步都是一条可回溯的 step，跑坏了重跑不丢历史。
// 铁律不变：step 产物只进 social_items 等人工放行，机器没有自发通道。
// ============================================================

// 项目状态：open=进行中 review=等放行 done=已交付 archived=归档
func ValidProjectStatus(st string) bool {
	switch st {
	case "open", "review", "done", "archived":
		return true
	}
	return false
}

// 步骤类型白名单。
func ValidStepKind(k string) bool {
	switch k {
	case "storyboard", "video", "copy":
		return true
	}
	return false
}

// StepLabel 给人看的步骤名（小程序时间线用）。
func StepLabel(k string) string {
	switch k {
	case "storyboard":
		return "出分镜"
	case "video":
		return "出成片"
	case "copy":
		return "出平台文案"
	}
	return k
}

type Project struct {
	ID         int64           `json:"id"`
	Title      string          `json:"title"`
	Brief      string          `json:"brief"`
	Status     string          `json:"status"`
	Opts       json.RawMessage `json:"opts"`
	CreatedBy  string          `json:"created_by"`
	CreatedAt  int64           `json:"created_at"`
	UpdatedAt  int64           `json:"updated_at"`
	AssetCount int             `json:"asset_count"`
	StepCount  int             `json:"step_count"`
	// 最近一步的状态摘要，列表页显示「出分镜·完成 / 出成片·执行中」。
	LastStepKind  string `json:"last_step_kind,omitempty"`
	LastStepLabel string `json:"last_step_label,omitempty"`
	LastStepStat  string `json:"last_step_status,omitempty"`
}

type ProjectAsset struct {
	ID        int64  `json:"id"`
	ProjectID int64  `json:"project_id"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Note      string `json:"note"`
	SortNo    int    `json:"sort_no"`
	CreatedAt int64  `json:"created_at"`
}

type ProjectStep struct {
	ID         int64  `json:"id"`
	ProjectID  int64  `json:"project_id"`
	TaskID     int64  `json:"task_id"`
	Kind       string `json:"kind"`
	KindLabel  string `json:"kind_label"`
	Prompt     string `json:"prompt"`
	Status     string `json:"status"`
	Result     string `json:"result"`
	Error      string `json:"error"`
	Note       string `json:"note"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
	FinishedAt int64  `json:"finished_at"`
}

var projectCols = `p.id, p.title, p.brief, p.status, p.opts, p.created_by, p.created_at, p.updated_at,
	(SELECT COUNT(1) FROM project_assets a WHERE a.project_id = p.id),
	(SELECT COUNT(1) FROM project_steps s WHERE s.project_id = p.id),
	IFNULL((SELECT s.kind FROM project_steps s WHERE s.project_id = p.id ORDER BY s.id DESC LIMIT 1),''),
	IFNULL((SELECT s.status FROM project_steps s WHERE s.project_id = p.id ORDER BY s.id DESC LIMIT 1),'')`

func scanProject(row interface{ Scan(...any) error }) (Project, error) {
	var p Project
	var opts string
	err := row.Scan(&p.ID, &p.Title, &p.Brief, &p.Status, &opts, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt,
		&p.AssetCount, &p.StepCount, &p.LastStepKind, &p.LastStepStat)
	if err != nil {
		return p, err
	}
	if opts == "" {
		opts = "{}"
	}
	p.Opts = json.RawMessage(opts)
	p.LastStepLabel = StepLabel(p.LastStepKind)
	return p, nil
}

// CreateProject 立项。title 必填；opts 可空。
func (s *Store) CreateProject(p *Project) error {
	if strings.TrimSpace(p.Title) == "" {
		return errors.New("store: 项目标题不能为空")
	}
	if p.Status == "" {
		p.Status = "open"
	}
	if !ValidProjectStatus(p.Status) {
		return errors.New("store: 未知项目状态")
	}
	opts := string(p.Opts)
	if opts == "" || opts == "null" {
		opts = "{}"
	}
	now := s.Now().Unix()
	res, err := s.exec(`INSERT INTO projects(title, brief, status, opts, created_by, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?)`, strings.TrimSpace(p.Title), p.Brief, p.Status, opts, p.CreatedBy, now, now)
	if err != nil {
		return fmt.Errorf("store: 立项: %w", err)
	}
	p.ID, _ = res.LastInsertId()
	p.CreatedAt, p.UpdatedAt = now, now
	return nil
}

func (s *Store) GetProject(id int64) (Project, error) {
	row := s.db.QueryRow("SELECT "+projectCols+" FROM projects p WHERE p.id = ?", id)
	p, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// ListProjects 项目列表：进行中优先、新在前。status 空=全部（archived 只在显式指定时出现）。
func (s *Store) ListProjects(status string, limit int) ([]Project, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := "SELECT " + projectCols + " FROM projects p"
	var args []any
	if status != "" && status != "all" {
		q += " WHERE p.status = ?"
		args = append(args, status)
	} else if status == "" {
		q += " WHERE p.status != 'archived'"
	}
	q += " ORDER BY (p.status='open') DESC, p.id DESC LIMIT ?"
	rows, err := s.db.Query(q, append(args, limit)...)
	if err != nil {
		return nil, fmt.Errorf("store: 列项目: %w", err)
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SaveProject 编辑项目（标题/提示词/状态/参数）。只动非 nil 字段。
func (s *Store) SaveProject(id int64, title, brief, status *string, opts *json.RawMessage) (Project, error) {
	p, err := s.GetProject(id)
	if err != nil {
		return p, err
	}
	if title != nil && strings.TrimSpace(*title) != "" {
		p.Title = strings.TrimSpace(*title)
	}
	if brief != nil {
		p.Brief = *brief
	}
	if status != nil && *status != "" {
		if !ValidProjectStatus(*status) {
			return p, errors.New("store: 未知项目状态")
		}
		p.Status = *status
	}
	if opts != nil && len(*opts) > 0 {
		p.Opts = *opts
	}
	now := s.Now().Unix()
	optsStr := string(p.Opts)
	if optsStr == "" {
		optsStr = "{}"
	}
	_, err = s.exec(`UPDATE projects SET title=?, brief=?, status=?, opts=?, updated_at=? WHERE id=?`,
		p.Title, p.Brief, p.Status, optsStr, now, id)
	if err != nil {
		return p, err
	}
	p.UpdatedAt = now
	return p, nil
}

// DeleteProject 删项目（素材/步骤台账连带删；已生成的文件由存储清理兜底）。
// 有未终结的项目任务时拒删，防止 worker 跑在飞的项目上。
func (s *Store) DeleteProject(id int64) error {
	var busy int
	err := s.db.QueryRow(`SELECT COUNT(1) FROM tasks WHERE project_id=? AND status IN ('pending','running')`, id).Scan(&busy)
	if err != nil {
		return fmt.Errorf("store: 查项目任务: %w", err)
	}
	if busy > 0 {
		return errors.New("store: 该项目还有未跑完的任务，先 skip 任务再删")
	}
	now := s.Now().Unix()
	return s.tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM project_assets WHERE project_id=?", id); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM project_steps WHERE project_id=?", id); err != nil {
			return err
		}
		res, err := tx.Exec("DELETE FROM projects WHERE id=?", id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		_ = now
		return nil
	})
}

// ---- 素材 ----

// AddProjectAsset 挂素材。path 必须是本站 /uploads/ 下的文件（先走上传接口拿路径）。
func (s *Store) AddProjectAsset(a *ProjectAsset) error {
	if !strings.HasPrefix(a.Path, "/uploads/") {
		return errors.New("store: 素材路径必须是 /uploads/ 下的站内文件")
	}
	switch a.Kind {
	case "image", "file", "charref":
	default:
		a.Kind = "image"
	}
	now := s.Now().Unix()
	if a.SortNo == 0 {
		var mx int
		_ = s.db.QueryRow("SELECT IFNULL(MAX(sort_no),0) FROM project_assets WHERE project_id=?", a.ProjectID).Scan(&mx)
		a.SortNo = mx + 1
	}
	res, err := s.exec(`INSERT INTO project_assets(project_id, path, kind, note, sort_no, created_at)
		VALUES (?,?,?,?,?,?)`, a.ProjectID, a.Path, a.Kind, a.Note, a.SortNo, now)
	if err != nil {
		return fmt.Errorf("store: 挂素材: %w", err)
	}
	a.ID, _ = res.LastInsertId()
	a.CreatedAt = now
	return nil
}

func (s *Store) ListProjectAssets(projectID int64) ([]ProjectAsset, error) {
	rows, err := s.db.Query(`SELECT id, project_id, path, kind, note, sort_no, created_at
		FROM project_assets WHERE project_id=? ORDER BY sort_no ASC, id ASC`, projectID)
	if err != nil {
		return nil, fmt.Errorf("store: 列素材: %w", err)
	}
	defer rows.Close()
	var out []ProjectAsset
	for rows.Next() {
		var a ProjectAsset
		if err := rows.Scan(&a.ID, &a.ProjectID, &a.Path, &a.Kind, &a.Note, &a.SortNo, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) DeleteProjectAsset(projectID, assetID int64) error {
	res, err := s.exec("DELETE FROM project_assets WHERE id=? AND project_id=?", assetID, projectID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- 步骤 ----

// CreateProjectStep 记一步（先落 step 行，再由调用方入队任务并 SetProjectStepTask 回填 task_id）。
func (s *Store) CreateProjectStep(st *ProjectStep) error {
	if !ValidStepKind(st.Kind) {
		return fmt.Errorf("store: 未知步骤类型 %q", st.Kind)
	}
	now := s.Now().Unix()
	res, err := s.exec(`INSERT INTO project_steps(project_id, task_id, kind, prompt, status, created_by, created_at, updated_at)
		VALUES (?,?,?,?,'pending',?,?,?)`, st.ProjectID, st.TaskID, st.Kind, st.Prompt, st.CreatedBy, now, now)
	if err != nil {
		return fmt.Errorf("store: 记步骤: %w", err)
	}
	st.ID, _ = res.LastInsertId()
	st.Status = "pending"
	st.CreatedAt, st.UpdatedAt = now, now
	st.KindLabel = StepLabel(st.Kind)
	return nil
}

func (s *Store) SetProjectStepTask(stepID, taskID int64) error {
	now := s.Now().Unix()
	_, err := s.exec("UPDATE project_steps SET task_id=?, updated_at=? WHERE id=?", taskID, now, stepID)
	return err
}

// SkipProjectStepTask 把步骤当前挂着的未终结任务先撤下（重排前清位，避免
// uq_task_open(type,review_id) 撞新排的同号任务）。
func (s *Store) SkipProjectStepTask(stepID int64) error {
	now := s.Now().Unix()
	_, err := s.exec(`UPDATE tasks SET status='skipped', error='重排替换', finished_at=?, updated_at=?
		WHERE id = (SELECT task_id FROM project_steps WHERE id=?) AND status IN ('pending','running','failed')`,
		now, now, stepID)
	return err
}

// ReopenProjectStep 重排（如配额顺延重入队）后把步骤拨回 pending 并挂上新 task。
// 已终结的 done 不重开（产物已出）；skipped/failed 才重开。
func (s *Store) ReopenProjectStep(stepID, taskID int64) error {
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE project_steps SET status='pending', task_id=?, error='', finished_at=0, updated_at=?
		WHERE id=? AND status IN ('pending','skipped','failed','running')`, taskID, now, stepID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

var stepCols = `id, project_id, task_id, kind, prompt, status, result, error, note, created_by,
	created_at, updated_at, finished_at`

func scanStep(row interface{ Scan(...any) error }) (ProjectStep, error) {
	var st ProjectStep
	err := row.Scan(&st.ID, &st.ProjectID, &st.TaskID, &st.Kind, &st.Prompt, &st.Status, &st.Result,
		&st.Error, &st.Note, &st.CreatedBy, &st.CreatedAt, &st.UpdatedAt, &st.FinishedAt)
	if err != nil {
		return st, err
	}
	st.KindLabel = StepLabel(st.Kind)
	return st, nil
}

func (s *Store) GetProjectStep(id int64) (ProjectStep, error) {
	row := s.db.QueryRow("SELECT "+stepCols+" FROM project_steps WHERE id=?", id)
	st, err := scanStep(row)
	if errors.Is(err, sql.ErrNoRows) {
		return st, ErrNotFound
	}
	return st, err
}

// ListProjectSteps 项目时间线（新在前）。
func (s *Store) ListProjectSteps(projectID int64) ([]ProjectStep, error) {
	rows, err := s.db.Query("SELECT "+stepCols+" FROM project_steps WHERE project_id=? ORDER BY id DESC", projectID)
	if err != nil {
		return nil, fmt.Errorf("store: 列步骤: %w", err)
	}
	defer rows.Close()
	var out []ProjectStep
	for rows.Next() {
		st, err := scanStep(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// FinishProjectStep worker 回填步骤结果。只接受终结态；同时刷新项目 updated_at。
func (s *Store) FinishProjectStep(id int64, status, result, errMsg, note string) error {
	if status != "done" && status != "failed" && status != "skipped" {
		return errors.New("store: 非法终结状态")
	}
	var pid int64
	if err := s.db.QueryRow("SELECT project_id FROM project_steps WHERE id=?", id).Scan(&pid); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE project_steps SET status=?, result=?, error=?, note=CASE WHEN ?='' THEN note ELSE ? END,
		finished_at=?, updated_at=? WHERE id=? AND status IN ('pending','running')`,
		status, result, errMsg, note, note, now, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, _ = s.exec("UPDATE projects SET updated_at=? WHERE id=?", now, pid)
	return nil
}

// SaveProjectStepResult 辣条妹改分镜：放行成片前把手改的 storyboard JSON 写回 step.result。
// 只允许改已完成（或失败留痕）的 storyboard 步骤。
func (s *Store) SaveProjectStepResult(id int64, result string) error {
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE project_steps SET result=?, updated_at=?
		WHERE id=? AND kind='storyboard' AND status IN ('done','failed')`, result, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// EnqueueProjectStep 入队一个项目步骤任务，返回 task id。
// 与 EnqueueTask 不同：不去重（同项目多步/重跑是常态），并落 tasks.project_id。
// review_id 存 -step_id：既避开 uq_task_open(type,review_id) 对同类型多任务的误拦，
// 又永远不会误关联真实点评（负 id 无 review，LEFT JOIN 自然落空）。
func (s *Store) EnqueueProjectStep(projectID, stepID int64, payload string, runAfter int64) (int64, error) {
	now := s.Now().Unix()
	res, err := s.exec(`INSERT INTO tasks(type, review_id, project_id, status, payload, run_after, created_at, updated_at)
		VALUES (?,?,?, 'pending',?,?,?,?)`, TaskProjectStep, -stepID, projectID, payload, runAfter, now, now)
	if err != nil {
		return 0, fmt.Errorf("store: 入队项目步骤: %w", err)
	}
	return res.LastInsertId()
}
