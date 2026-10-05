package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ============================================================
// v6 流水线：任务队列 / 指令 / 三端用户身份
// 设计原则：人（辣条妹）只在两处出现——审内容、下指令；其余全靠 worker。
// ============================================================

// 任务类型常量。新增渠道在这里加，enqueue 开关在 settings 里控制。
const (
	TaskVideo  = "video"  // hyperframes 渲染抖音视频并发布
	TaskGzh    = "gzh"    // 公众号同步发文
	TaskWxPush = "wxpush" // 小程序订阅消息推送
	TaskDraft  = "draft"  // AI 产草稿（不挂具体点评，review_id=0）
	// v7 社媒自动分发（worker 按 tools/pipeline/publishers.json 的凭证走浏览器自动化）。
	// v9 收紧：这三类任务只能由「待审文案放行」入队，自动开关只产 social_gen 草稿。
	TaskDouyin = "douyin"      // 图文/视频直发抖音
	TaskXhs    = "xiaohongshu" // 图文直发小红书
	TaskZhihu  = "zhihu"       // 长文直发知乎
	TaskWeibo  = "weibo"       // 短图文直发微博
	// v9：管理小程序「发任务」的入口。只产文案进 social_items 等审核，
	// 绝不直接发布——发布任务只能由人工放行入队。
	TaskSocialGen = "social_gen" // AI 产四平台待审文案
	// v10：视频工坊。管理员自由描述（图文素材+语音转写后的结构化提示词）→
	// worker 产成片并落 social_items 等人工审核放行；同样没有绕审通道。
	TaskVideoMission = "video_mission" // AI 按自定义提示词产视频+待审稿
	// v13 项目制：一条 step（出分镜/出成片/出文案）对应一次入队，
	// payload 带 project_id/step_id/kind；历史 video_mission 任务照旧可跑。
	TaskProjectStep = "project_step" // 项目步骤（storyboard|video|copy）
)

// ValidTaskType 校验任务类型。
func ValidTaskType(t string) bool {
	switch t {
	case TaskVideo, TaskGzh, TaskWxPush, TaskDraft, TaskSocialGen, TaskVideoMission, TaskProjectStep,
		TaskDouyin, TaskXhs, TaskZhihu, TaskWeibo:
		return true
	}
	return false
}

// TaskLabel 给人看的任务名（管理小程序展示用）。
func TaskLabel(t string) string {
	switch t {
	case TaskVideo:
		return "抖音视频"
	case TaskGzh:
		return "公众号文章"
	case TaskWxPush:
		return "订阅推送"
	case TaskDraft:
		return "AI 草稿"
	case TaskDouyin:
		return "发布·抖音"
	case TaskXhs:
		return "发布·小红书"
	case TaskZhihu:
		return "发布·知乎"
	case TaskWeibo:
		return "发布·微博"
	case TaskSocialGen:
		return "AI·四平台文案"
	case TaskVideoMission:
		return "AI·做视频"
	case TaskProjectStep:
		return "AI·项目步骤"
	}
	return t
}

// SocialPlatforms 受控的四平台白名单；发布类任务 type 直接用平台名。
var SocialPlatforms = []string{TaskDouyin, TaskXhs, TaskZhihu, TaskWeibo}

// ValidSocialPlatform 校验发布平台。
func ValidSocialPlatform(p string) bool {
	switch p {
	case TaskDouyin, TaskXhs, TaskZhihu, TaskWeibo:
		return true
	}
	return false
}

// Task 一条流水线任务。
type Task struct {
	ID         int64           `json:"id"`
	Type       string          `json:"type"`
	TypeLabel  string          `json:"type_label"`
	ReviewID   int64           `json:"review_id"`
	ProjectID  int64           `json:"project_id"`            // v13：项目步骤任务所属项目，0=非项目任务
	ReviewDish string          `json:"review_dish,omitempty"` // 关联内容菜名，列表页直显
	Status     string          `json:"status"`
	Payload    json.RawMessage `json:"payload"`
	Result     string          `json:"result"`
	Error      string          `json:"error"`
	Attempts   int             `json:"attempts"`
	RunAfter   int64           `json:"run_after"`
	CreatedAt  int64           `json:"created_at"`
	UpdatedAt  int64           `json:"updated_at"`
	StartedAt  int64           `json:"started_at"`
	FinishedAt int64           `json:"finished_at"`
}

// EnqueueTask 入队一个任务；同 type+review 已有未终结任务时返回 (false,nil) 静默去重。
// reviewID=0（如 draft）不受唯一约束限制，由调用方自行控制节奏。
func (s *Store) EnqueueTask(taskType string, reviewID int64, payload any, runAfter int64) (bool, error) {
	if !ValidTaskType(taskType) {
		return false, fmt.Errorf("store: 未知任务类型 %q", taskType)
	}
	pj := "{}"
	if payload != nil {
		b, err := json.Marshal(payload)
		if err == nil {
			pj = string(b)
		}
	}
	now := s.Now().Unix()
	res, err := s.exec(`INSERT INTO tasks(type, review_id, status, payload, run_after, created_at, updated_at)
		SELECT ?,?, 'pending',?,?,?,?
		WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE type=? AND review_id=? AND status IN ('pending','running'))`,
		taskType, reviewID, pj, runAfter, now, now, taskType, reviewID)
	if err != nil {
		// 部分 SQLite 版本不认 UNIQUE INDEX 里的 WHERE 的兼容问题兜底：撞约束也视为去重。
		if strings.Contains(err.Error(), "UNIQUE") {
			return false, nil
		}
		return false, fmt.Errorf("store: 入队 %s: %w", taskType, err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// EnqueueForReview 内容发布后按开关自动入队分发任务。返回实际入队数。
// v9 起四平台开关不再直接入队发布任务（那是跳过人审的后门），
// 而是入队一个 social_gen：AI 产平台化文案进待审列表，放行才会真发布。
func (s *Store) EnqueueForReview(reviewID int64) int {
	if s.Setting("pipeline_enabled") != "1" {
		return 0
	}
	added := 0
	for _, t := range []string{TaskVideo, TaskGzh, TaskWxPush} {
		key := map[string]string{
			TaskVideo: "pipeline_video", TaskGzh: "pipeline_gzh", TaskWxPush: "pipeline_wxpush",
		}[t]
		if s.Setting(key) != "1" {
			continue
		}
		ok, err := s.EnqueueTask(t, reviewID, nil, 0)
		if err != nil {
			continue
		}
		if ok {
			added++
		}
	}
	var plats []string
	for _, t := range SocialPlatforms {
		if s.Setting("pipeline_"+t) == "1" {
			plats = append(plats, t)
		}
	}
	if len(plats) > 0 {
		if ok, err := s.EnqueueTask(TaskSocialGen, reviewID, map[string]any{
			"review_id": reviewID, "platforms": plats, "auto": true,
		}, 0); err == nil && ok {
			added++
		}
	}
	return added
}

var taskCols = `t.id, t.type, t.review_id, IFNULL(t.project_id,0), t.status, t.payload, t.result, t.error, t.attempts,
	t.run_after, t.created_at, t.updated_at, t.started_at, t.finished_at, IFNULL(r.dish,'')`

func scanTask(row interface{ Scan(...any) error }) (Task, error) {
	var t Task
	var pj string
	err := row.Scan(&t.ID, &t.Type, &t.ReviewID, &t.ProjectID, &t.Status, &pj, &t.Result, &t.Error, &t.Attempts,
		&t.RunAfter, &t.CreatedAt, &t.UpdatedAt, &t.StartedAt, &t.FinishedAt, &t.ReviewDish)
	if err != nil {
		return t, err
	}
	t.TypeLabel = TaskLabel(t.Type)
	if pj == "" {
		pj = "{}"
	}
	t.Payload = json.RawMessage(pj)
	return t, nil
}

// ListTasks 按状态/类型列任务（新→旧）。status 空=全部；limit 默认 50。
func (s *Store) ListTasks(status, taskType string, limit int) ([]Task, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var where []string
	var args []any
	if status != "" && status != "all" {
		where = append(where, "t.status = ?")
		args = append(args, status)
	}
	if taskType != "" && taskType != "all" {
		where = append(where, "t.type = ?")
		args = append(args, taskType)
	}
	q := "SELECT " + taskCols + " FROM tasks t LEFT JOIN reviews r ON r.id = t.review_id" +
		joinWhere(where) + " ORDER BY t.id DESC LIMIT ?"
	rows, err := s.db.Query(q, append(args, limit)...)
	if err != nil {
		return nil, fmt.Errorf("store: 列任务: %w", err)
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// PollTasks 给 worker 领取：pending/failed(未到上限且过了退避时间) 的最老若干条。
// failed 自动重试由 maxAttempts 兜着；run_after 未到的跳过。
func (s *Store) PollTasks(now int64, maxAttempts, limit int) ([]Task, error) {
	if limit <= 0 || limit > 20 {
		limit = 5
	}
	rows, err := s.db.Query("SELECT "+taskCols+` FROM tasks t LEFT JOIN reviews r ON r.id = t.review_id
		WHERE (t.status = 'pending' OR (t.status = 'failed' AND t.attempts < ?)) AND t.run_after <= ?
		ORDER BY t.id ASC LIMIT ?`, maxAttempts, now, limit)
	if err != nil {
		return nil, fmt.Errorf("store: 领任务: %w", err)
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, task)
	}
	return out, rows.Err()
}

// GetTask 按 id 读单条任务（链式发布时在 finish 回调里回看自己是什么类型）。
func (s *Store) GetTask(id int64) (Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+" FROM tasks t LEFT JOIN reviews r ON r.id = t.review_id WHERE t.id = ?", id)
	return scanTask(row)
}

// ClaimTask 把任务置为 running；只有 pending/failed 能被领取，防两个 worker 抢同一条。
func (s *Store) ClaimTask(id int64) error {
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE tasks SET status='running', attempts=attempts+1, started_at=?, updated_at=?
		WHERE id=? AND status IN ('pending','failed')`, now, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errors.New("store: 任务已被领取或不处于可执行状态")
	}
	return nil
}

// FinishTask 回填结果。status 只接受 done/failed/skipped；failed 自动退避 10 分钟。
func (s *Store) FinishTask(id int64, status, result, errMsg string) error {
	if status != "done" && status != "failed" && status != "skipped" {
		return errors.New("store: 非法终结状态")
	}
	now := s.Now().Unix()
	runAfter := int64(0)
	if status == "failed" {
		runAfter = now + 600 // 失败退避，避免 worker 空转刷平台接口
	}
	st := status
	_, err := s.exec(`UPDATE tasks SET status=
		CASE WHEN ?='failed' AND attempts >= 5 THEN 'failed' ELSE ? END,
		result=?, error=?, run_after=CASE WHEN ?='failed' THEN ? ELSE 0 END,
		finished_at=?, updated_at=? WHERE id=?`,
		st, st, result, errMsg, st, runAfter, now, now, id)
	return err
}

// RetryTask 后台手动把任务拨回 pending（清退避时间），立即让 worker 重试。
func (s *Store) RetryTask(id int64) error {
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE tasks SET status='pending', error='', run_after=0, updated_at=? WHERE id=?`, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SkipTask 后台放弃一条任务。
func (s *Store) SkipTask(id int64) error {
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE tasks SET status='skipped', finished_at=?, updated_at=? WHERE id=? AND status IN ('pending','failed','running')`, now, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// TaskSummary 各状态计数（管理端「指挥中心」卡片）。
func (s *Store) TaskSummary() (map[string]int64, error) {
	rows, err := s.db.Query("SELECT status, COUNT(1) FROM tasks GROUP BY status")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{"pending": 0, "running": 0, "done": 0, "failed": 0, "skipped": 0}
	for rows.Next() {
		var k string
		var v int64
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ============================================================
// 指令 directives
// ============================================================

// Directive 辣条妹的一条指令。
type Directive struct {
	ID         int64  `json:"id"`
	Date       string `json:"date"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Brief      string `json:"brief"`
	Status     string `json:"status"`
	ResultNote string `json:"result_note"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
}

// ValidDirectiveKind 指令类型白名单。promo 为直播商单预留，前期不启用也有接口。
func ValidDirectiveKind(k string) bool {
	switch k {
	case "topic", "style", "promo", "block":
		return true
	}
	return false
}

// AddDirective 新建指令。
func (s *Store) AddDirective(d *Directive) error {
	if strings.TrimSpace(d.Title) == "" {
		return errors.New("store: 指令标题不能为空")
	}
	if d.Kind == "" {
		d.Kind = "topic"
	}
	if !ValidDirectiveKind(d.Kind) {
		return errors.New("store: 未知指令类型")
	}
	if d.Date != "" {
		if _, err := fmt.Sscanf(d.Date, "%d-%d-%d", new(int), new(int), new(int)); err != nil {
			return errors.New("store: date 需为 YYYY-MM-DD")
		}
	}
	now := s.Now().Unix()
	_, err := s.exec(`INSERT INTO directives(date, kind, title, brief, status, created_by, created_at, updated_at)
		VALUES (?,?,?,?, 'open', ?, ?, ?)`, d.Date, d.Kind, strings.TrimSpace(d.Title), d.Brief, d.CreatedBy, now, now)
	return err
}

// ListDirectives 指令列表：open 优先、新在前。
func (s *Store) ListDirectives(status string, limit int) ([]Directive, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT id, date, kind, title, brief, status, result_note, created_by, created_at, updated_at
		FROM directives`
	var args []any
	if status != "" && status != "all" {
		q += " WHERE status = ?"
		args = append(args, status)
	}
	q += " ORDER BY (status='open') DESC, id DESC LIMIT ?"
	rows, err := s.db.Query(q, append(args, limit)...)
	if err != nil {
		return nil, fmt.Errorf("store: 列指令: %w", err)
	}
	defer rows.Close()
	var out []Directive
	for rows.Next() {
		var d Directive
		if err := rows.Scan(&d.ID, &d.Date, &d.Kind, &d.Title, &d.Brief, &d.Status,
			&d.ResultNote, &d.CreatedBy, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SetDirectiveStatus 指令状态流转：open → done / cancelled，带执行回填说明。
func (s *Store) SetDirectiveStatus(id int64, status, note string) error {
	if status != "open" && status != "done" && status != "cancelled" {
		return errors.New("store: 非法指令状态")
	}
	now := s.Now().Unix()
	res, err := s.exec("UPDATE directives SET status=?, result_note=CASE WHEN ?='' THEN result_note ELSE ? END, updated_at=? WHERE id=?",
		status, note, note, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteDirective 删指令。
func (s *Store) DeleteDirective(id int64) error {
	res, err := s.exec("DELETE FROM directives WHERE id=?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ============================================================
// 三端用户身份 mp_ids
// ============================================================

// MPChannel 校验渠道。
func ValidMPChannel(c string) bool {
	switch c {
	case "wxmini", "dymini", "gzh":
		return true
	}
	return false
}

// UpsertMPID 登录时 upsert openid；回来一次加一次登录。
func (s *Store) UpsertMPID(channel, openid, unionid, nickname string) error {
	if !ValidMPChannel(channel) || openid == "" {
		return errors.New("store: mp id 参数非法")
	}
	now := s.Now().Unix()
	return s.tx(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO mp_ids(channel, openid, unionid, nickname, created_at, updated_at)
			VALUES (?,?,?,?,?,?)
			ON CONFLICT(channel, openid) DO UPDATE SET
				unionid = CASE WHEN excluded.unionid != '' THEN excluded.unionid ELSE unionid END,
				nickname = CASE WHEN excluded.nickname != '' THEN excluded.nickname ELSE nickname END,
				updated_at = excluded.updated_at`,
			channel, openid, unionid, nickname, now, now)
		return err
	})
}

// GrantQuota 用户点了一次"订阅"，发送配额 +1（封顶 10，防止数据异常时爆量群发）。
func (s *Store) GrantQuota(channel, openid string) error {
	now := s.Now().Unix()
	_, err := s.exec(`INSERT INTO mp_ids(channel, openid, quota, quota_total, created_at, updated_at)
		VALUES (?,? ,1,1,?,?)
		ON CONFLICT(channel, openid) DO UPDATE SET
			quota = MIN(quota + 1, 10),
			quota_total = quota_total + 1,
			updated_at = excluded.updated_at`, channel, openid, now, now)
	return err
}

// Subscriber 可触达用户。
type Subscriber struct {
	OpenID string `json:"openid"`
	Quota  int    `json:"quota"`
}

// ListSubscribers 取有配额的订阅用户（worker 推送前领取）。
func (s *Store) ListSubscribers(channel string, limit int) ([]Subscriber, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.Query("SELECT openid, quota FROM mp_ids WHERE channel=? AND quota > 0 ORDER BY id ASC LIMIT ?", channel, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Subscriber
	for rows.Next() {
		var v Subscriber
		if err := rows.Scan(&v.OpenID, &v.Quota); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ConsumeQuota 发送完成后核销一次配额（失败也核销：微信侧一次授权只能发一条，
// 43101 未订阅这类错误重试也不会成功，扣掉免得卡着名单）。
func (s *Store) ConsumeQuota(channel, openid string) error {
	now := s.Now().Unix()
	_, err := s.exec(`UPDATE mp_ids SET quota = MAX(quota - 1, 0), updated_at=? WHERE channel=? AND openid=?`,
		now, channel, openid)
	return err
}

// MPStats 各渠道关注数与剩余可发配额（管理端展示"能触达多少人"）。
func (s *Store) MPStats() ([]map[string]any, error) {
	rows, err := s.db.Query(`SELECT channel, COUNT(1), IFNULL(SUM(quota),0) FROM mp_ids GROUP BY channel`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var c string
		var n, q int64
		if err := rows.Scan(&c, &n, &q); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"channel": c, "users": n, "quota": q})
	}
	return out, rows.Err()
}

// ============================================================
// v9 社媒待审内容 social_items
// 流水线唯一入口是「发任务」，唯一出口是「人工放行」。
// ============================================================

// SocialItem 一条按平台风格产好的待审文案。
type SocialItem struct {
	ID            int64           `json:"id"`
	GenTaskID     int64           `json:"gen_task_id"`
	ReviewID      int64           `json:"review_id"`
	ReviewDish    string          `json:"review_dish,omitempty"` // 列表页直显菜名
	Platform      string          `json:"platform"`
	PlatformLabel string          `json:"platform_label"`
	Title         string          `json:"title"`
	Body          string          `json:"body"`
	Tags          json.RawMessage `json:"tags"`
	Images        json.RawMessage `json:"images"`
	Video         string          `json:"video"`
	Status        string          `json:"status"`
	Note          string          `json:"note"`
	Result        string          `json:"result"`
	ReviewedBy    string          `json:"reviewed_by"`
	ReviewedAt    int64           `json:"reviewed_at"`
	PublishedAt   int64           `json:"published_at"`
	CreatedAt     int64           `json:"created_at"`
	UpdatedAt     int64           `json:"updated_at"`
}

// SocialStatusLabel 给人看的审核状态名。
func SocialStatusLabel(st string) string {
	switch st {
	case "pending":
		return "待审"
	case "approved":
		return "已放行"
	case "rejected":
		return "已驳回"
	case "published":
		return "已发布"
	case "failed":
		return "发布失败"
	}
	return st
}

var socialCols = `i.id, i.gen_task_id, i.review_id, i.platform, i.title, i.body, i.tags, i.images,
	i.video, i.status, i.note, i.result, i.reviewed_by, i.reviewed_at, i.published_at,
	i.created_at, i.updated_at, IFNULL(r.dish,'')`

func scanSocialItem(row interface{ Scan(...any) error }) (SocialItem, error) {
	var it SocialItem
	var tags, images string
	err := row.Scan(&it.ID, &it.GenTaskID, &it.ReviewID, &it.Platform, &it.Title, &it.Body,
		&tags, &images, &it.Video, &it.Status, &it.Note, &it.Result, &it.ReviewedBy,
		&it.ReviewedAt, &it.PublishedAt, &it.CreatedAt, &it.UpdatedAt, &it.ReviewDish)
	if err != nil {
		return it, err
	}
	if tags == "" {
		tags = "[]"
	}
	if images == "" {
		images = "[]"
	}
	it.Tags = json.RawMessage(tags)
	it.Images = json.RawMessage(images)
	it.PlatformLabel = TaskLabel(it.Platform)
	return it, nil
}

// CreateSocialItem worker 产文案后落一条待审。服务端强制 status=pending——
// 机器永远没有"直接放行"的口子。重复产同一 (gen_task,platform) 时覆盖旧稿（重跑幂等）。
func (s *Store) CreateSocialItem(it *SocialItem) error {
	if !ValidSocialPlatform(it.Platform) {
		return fmt.Errorf("store: 未知发布平台 %q", it.Platform)
	}
	if strings.TrimSpace(it.Body) == "" {
		return errors.New("store: 文案正文不能为空")
	}
	tags := string(it.Tags)
	if tags == "" || tags == "null" {
		tags = "[]"
	}
	images := string(it.Images)
	if images == "" || images == "null" {
		images = "[]"
	}
	now := s.Now().Unix()
	res, err := s.exec(`INSERT INTO social_items(gen_task_id, review_id, platform, title, body, tags, images,
		video, status, note, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)
		ON CONFLICT(gen_task_id, platform) WHERE gen_task_id > 0 DO UPDATE SET
			title=excluded.title, body=excluded.body, tags=excluded.tags, images=excluded.images,
			video=excluded.video, note=excluded.note, status='pending', updated_at=excluded.updated_at`,
		it.GenTaskID, it.ReviewID, it.Platform, it.Title, it.Body, tags, images, it.Video,
		it.Note, now, now)
	if err != nil {
		return fmt.Errorf("store: 落待审文案: %w", err)
	}
	it.ID, _ = res.LastInsertId()
	it.Status = "pending"
	it.CreatedAt = now
	it.UpdatedAt = now
	return nil
}

// GetSocialItem 按 id 读一条。
func (s *Store) GetSocialItem(id int64) (SocialItem, error) {
	row := s.db.QueryRow("SELECT "+socialCols+` FROM social_items i LEFT JOIN reviews r ON r.id = i.review_id WHERE i.id = ?`, id)
	it, err := scanSocialItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return it, ErrNotFound
	}
	return it, err
}

// ListSocialItems 审核列表：新在前；status 空=全部。
func (s *Store) ListSocialItems(status, platform string, limit int) ([]SocialItem, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var where []string
	var args []any
	if status != "" && status != "all" {
		where = append(where, "i.status = ?")
		args = append(args, status)
	}
	if platform != "" && platform != "all" {
		where = append(where, "i.platform = ?")
		args = append(args, platform)
	}
	q := "SELECT " + socialCols + " FROM social_items i LEFT JOIN reviews r ON r.id = i.review_id" +
		joinWhere(where) + " ORDER BY (i.status='pending') DESC, i.id DESC LIMIT ?"
	rows, err := s.db.Query(q, append(args, limit)...)
	if err != nil {
		return nil, fmt.Errorf("store: 列待审文案: %w", err)
	}
	defer rows.Close()
	var out []SocialItem
	for rows.Next() {
		it, err := scanSocialItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// SaveSocialDraft 辣条妹改稿（放行前任意时刻可改；已发布/已驳回不许动）。
func (s *Store) SaveSocialDraft(id int64, title, body string, tags json.RawMessage) error {
	now := s.Now().Unix()
	tj := "[]"
	if len(tags) > 0 && string(tags) != "null" {
		tj = string(tags)
	}
	res, err := s.exec(`UPDATE social_items SET title=?, body=?, tags=?, updated_at=?
		WHERE id=? AND status IN ('pending','approved')`, title, body, tj, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ApproveSocialItem 人审放行：置 approved 并入队对应平台的发布任务（payload 带 item_id，
// worker 发布前回读最新稿——放行后再改也生效，直到任务被领取执行）。
func (s *Store) ApproveSocialItem(id int64, reviewer string) error {
	it, err := s.GetSocialItem(id)
	if err != nil {
		return err
	}
	if it.Status == "published" {
		return errors.New("store: 已发布的内容不用再审")
	}
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE social_items SET status='approved', reviewed_by=?, reviewed_at=?, updated_at=?
		WHERE id=? AND status IN ('pending','approved','rejected','failed')`, reviewer, now, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	// 入队真发布。去重命中（同 review 已有未终结任务）不算失败：那条任务会来处理。
	if _, err := s.EnqueueTask(it.Platform, it.ReviewID, map[string]any{"item_id": it.ID}, 0); err != nil {
		return fmt.Errorf("store: 放行后入队发布: %w", err)
	}
	return nil
}

// RejectSocialItem 驳回。note 给 AI/人看原因；已入队的发布任务连带 skip，防止发旧稿。
func (s *Store) RejectSocialItem(id int64, reviewer, note string) error {
	it, err := s.GetSocialItem(id)
	if err != nil {
		return err
	}
	if it.Status == "published" {
		return errors.New("store: 已发布的内容收不回，驳回无意义")
	}
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE social_items SET status='rejected', note=?, reviewed_by=?, reviewed_at=?, updated_at=?
		WHERE id=? AND status IN ('pending','approved','failed')`, note, reviewer, now, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if it.Status == "approved" {
		// 放行了又反悔：把还没跑完的发布任务撤下来（正在跑的极小概率窗口由 worker 回读状态兜底）。
		_, _ = s.exec(`UPDATE tasks SET status='skipped', error='内容被驳回', finished_at=?, updated_at=?
			WHERE type=? AND review_id=? AND status IN ('pending','running')`, now, now, it.Platform, it.ReviewID)
	}
	return nil
}

// SetSocialItemResult worker 回填发布进展：published（附 result）或 failed（附原因）。
func (s *Store) SetSocialItemResult(id int64, status, result, note string) error {
	if status != "published" && status != "failed" {
		return errors.New("store: 只能回填 published/failed")
	}
	now := s.Now().Unix()
	pub := int64(0)
	if status == "published" {
		pub = now
	}
	res, err := s.exec(`UPDATE social_items SET status=?, result=?, note=?, published_at=?, updated_at=?
		WHERE id=? AND status IN ('pending','approved','failed')`, status, result, note, pub, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// NextApprovedItem 同内容同平台里最早的一条已放行稿（发布完一条后链式排下一条）。
func (s *Store) NextApprovedItem(reviewID int64, platform string) (SocialItem, error) {
	row := s.db.QueryRow("SELECT "+socialCols+` FROM social_items i LEFT JOIN reviews r ON r.id = i.review_id
		WHERE i.review_id = ? AND i.platform = ? AND i.status = 'approved' ORDER BY i.id ASC LIMIT 1`, reviewID, platform)
	return scanSocialItem(row)
}

// SocialItemSummary 审核角标用：各状态计数。
func (s *Store) SocialItemSummary() (map[string]int64, error) {
	rows, err := s.db.Query("SELECT status, COUNT(1) FROM social_items GROUP BY status")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{"pending": 0, "approved": 0, "rejected": 0, "published": 0, "failed": 0}
	for rows.Next() {
		var k string
		var v int64
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
