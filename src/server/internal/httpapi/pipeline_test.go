package httpapi_test

// v6 流水线测试：发布自动入队、worker 任务生命周期、token 鉴权、
// AI 草稿强制 draft、指令闭环、粉丝登录与订阅配额核销。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ---- 帮助函数 ----

func pipeCall(t *testing.T, h *harness, token, method, path, body string) (int, map[string]any) {
	t.Helper()
	saved := h.token
	h.token = token
	defer func() { h.token = saved }()
	return h.call(t, method, path, body)
}

// pathf 拼带 id 的路径。
func pathf(format string, id int64) string {
	return fmt.Sprintf(format, id)
}

// firstReviewID 走后台流程建一条草稿，返回 id。
func firstReviewID(t *testing.T, h *harness) int64 {
	t.Helper()
	_, body := h.call(t, http.MethodPost, "/api/admin/reviews",
		`{"dish":"测试·片儿川","kind":"tandian","tier":"hang","score":4.8,"body":"面汤鲜"}`)
	d, _ := body["data"].(map[string]any)
	id, _ := d["id"].(float64)
	if id == 0 {
		t.Fatalf("建草稿失败: %v", body)
	}
	return int64(id)
}

// ---- 用例 ----

func TestPublishAutoEnqueuesTasks(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner-pipe")
	// 锁定入队通道为原三条：默认设置里小红书/知乎/微博开关会随版本拨开，不影响本用例要验的机制。
	if err := h.st.SaveSettings(map[string]string{
		"pipeline_xiaohongshu": "0", "pipeline_zhihu": "0", "pipeline_weibo": "0",
	}); err != nil {
		t.Fatalf("预设开关: %v", err)
	}
	id := firstReviewID(t, h)

	_, body := h.call(t, http.MethodPost, pathf("/api/admin/reviews/%d/status", id), `{"status":"published"}`)
	d := dataOf(body)
	if d["tasks_enqueued"] != float64(3) { // video + gzh + wxpush
		t.Fatalf("发布应入队 3 个任务，实得 %v（body=%v）", d["tasks_enqueued"], body)
	}
	// 重复发布：未终结任务去重，不再重复入队
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/reviews/%d/status", id), `{"status":"published"}`)
	if dataOf(body)["tasks_enqueued"] != float64(0) {
		t.Fatalf("重复发布不应重复入队: %v", body)
	}
	_, body = h.call(t, http.MethodGet, "/api/admin/tasks?status=pending", "")
	ds, _ := body["data"].(map[string]any)
	tasks, _ := ds["tasks"].([]any)
	if len(tasks) != 3 {
		t.Fatalf("pending 任务应为 3，实得 %d", len(tasks))
	}
	sum, _ := ds["summary"].(map[string]any)
	if sum["pending"] != float64(3) {
		t.Fatalf("summary.pending 应为 3，实得 %v", sum["pending"])
	}
}

func TestPipelineAuthMatrix(t *testing.T) {
	h := newHarness(t, false)
	// 未配置 token：通道关闭
	code, _ := pipeCall(t, h, "", http.MethodGet, "/api/pipeline/poll", "")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("无 token 配置应 503，实得 %d", code)
	}
	h.cfg.PipelineToken = "pt-test-0123456789"
	code, _ = pipeCall(t, h, "wrong-token", http.MethodGet, "/api/pipeline/poll", "")
	if code != http.StatusUnauthorized {
		t.Fatalf("错 token 应 401，实得 %d", code)
	}
	code, body := pipeCall(t, h, "pt-test-0123456789", http.MethodGet, "/api/pipeline/poll", "")
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("正确 token 应 200: %d %v", code, body)
	}
}

func TestTaskLifecyclePollClaimFinish(t *testing.T) {
	h := newHarness(t, false)
	h.cfg.PipelineToken = "pt-lifecycle"
	h.login(t, "owner-life")
	if err := h.st.SaveSettings(map[string]string{
		"pipeline_xiaohongshu": "0", "pipeline_zhihu": "0", "pipeline_weibo": "0",
	}); err != nil {
		t.Fatalf("预设开关: %v", err)
	}
	id := firstReviewID(t, h)
	h.call(t, http.MethodPost, pathf("/api/admin/reviews/%d/status", id), `{"status":"published"}`)

	// poll 拿到 3 条
	_, body := pipeCall(t, h, "pt-lifecycle", http.MethodGet, "/api/pipeline/poll?limit=5", "")
	d := dataOf(body)
	tasks, _ := d["tasks"].([]any)
	if len(tasks) != 3 {
		t.Fatalf("poll 应得 3 条，实得 %d (%v)", len(tasks), d)
	}
	task := tasks[0].(map[string]any)
	tid := int64(task["id"].(float64))

	// claim → done
	code, _ := pipeCall(t, h, "pt-lifecycle", http.MethodPost, pathf("/api/pipeline/tasks/%d/claim", tid), "")
	if code != http.StatusOK {
		t.Fatalf("claim 失败 %d", code)
	}
	// 二次 claim 必须被拒（防双 worker）
	code, _ = pipeCall(t, h, "pt-lifecycle", http.MethodPost, pathf("/api/pipeline/tasks/%d/claim", tid), "")
	if code != http.StatusConflict {
		t.Fatalf("重复 claim 应 409，实得 %d", code)
	}
	code, _ = pipeCall(t, h, "pt-lifecycle", http.MethodPost, pathf("/api/pipeline/tasks/%d/finish", tid),
		`{"status":"done","result":"video.mp4"}`)
	if code != http.StatusOK {
		t.Fatalf("finish 失败 %d", code)
	}

	// 后台视角：1 done + 2 pending；辣条妹手动 retry done 任务 → 回 pending
	_, body = h.call(t, http.MethodGet, "/api/admin/tasks", "")
	ds := dataOf(body)
	sum := ds["summary"].(map[string]any)
	if sum["done"] != float64(1) || sum["pending"] != float64(2) {
		t.Fatalf("summary 应为 1 done / 2 pending，实得 %v", sum)
	}
	code, _ = h.call(t, http.MethodPost, pathf("/api/admin/tasks/%d/retry", tid), "")
	if code != http.StatusOK {
		t.Fatalf("admin retry 失败 %d", code)
	}
}

func TestAIDraftIsAlwaysDraft(t *testing.T) {
	h := newHarness(t, false)
	h.cfg.PipelineToken = "pt-draft"
	// AI 想直接发布？接口层强制 status=draft。
	code, body := pipeCall(t, h, "pt-draft", http.MethodPost, "/api/pipeline/reviews",
		`{"dish":"AI·酱鸭","kind":"tandian","tier":"dingji","score":4.2,"status":"published","body":"提案"}`)
	if code != http.StatusOK {
		t.Fatalf("建草稿失败 %d %v", code, body)
	}
	d := dataOf(body)
	if d["status"] != "draft" {
		t.Fatalf("AI 提交的内容必须是 draft，实得 %v", d["status"])
	}
	// 草稿不进公开列表（公开接口默认只看 published）
	_, pub := h.call(t, http.MethodGet, "/api/reviews?kind=tandian&q=酱鸭", "")
	var items []any
	if d := dataOf(pub); d != nil {
		items, _ = d["items"].([]any)
	} else {
		t.Fatalf("公开列表请求失败: %v", pub)
	}
	if len(items) != 0 {
		t.Fatalf("未审核草稿不应出现在公开列表: %d 条", len(items))
	}
}

func TestDirectiveRoundTrip(t *testing.T) {
	h := newHarness(t, false)
	h.cfg.PipelineToken = "pt-dir"
	h.login(t, "owner-dir")

	// 辣条妹下指令：周六做湖滨夜宵专题
	code, body := h.call(t, http.MethodPost, "/api/admin/directives",
		`{"kind":"topic","title":"湖滨夜宵专题","brief":"重点拍小龙虾","date":"2026-09-26"}`)
	if code != http.StatusOK {
		t.Fatalf("下指令失败 %d %v", code, body)
	}
	// worker 读到 open 指令
	_, body = pipeCall(t, h, "pt-dir", http.MethodGet, "/api/pipeline/directives", "")
	list := dataOf(body)["directives"].([]any)
	if len(list) != 1 {
		t.Fatalf("worker 应看到 1 条指令，实得 %d", len(list))
	}
	did := int64(list[0].(map[string]any)["id"].(float64))
	// worker 执行完回填
	code, _ = pipeCall(t, h, "pt-dir", http.MethodPost, pathf("/api/pipeline/directives/%d/done", did),
		`{"status":"done","note":"草稿已产出 2 条"}`)
	if code != http.StatusOK {
		t.Fatalf("指令回填失败 %d", code)
	}
	// 辣条妹视角：done + 备注可见
	_, body = h.call(t, http.MethodGet, "/api/admin/directives?status=done", "")
	list = dataOf(body)["directives"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["result_note"] != "草稿已产出 2 条" {
		t.Fatalf("指令闭环失败: %v", list)
	}
	// 非法 kind 被拒
	code, _ = h.call(t, http.MethodPost, "/api/admin/directives", `{"kind":"hack","title":"x"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("未知指令类型应 400，实得 %d", code)
	}
}

func TestFanLoginAndSubscribeQuota(t *testing.T) {
	h := newHarness(t, false)
	h.cfg.PipelineToken = "pt-fan"
	h.cfg.MPAppID, h.cfg.MPSecret = "wxMPAPPID", "mp-secret"

	// 粉丝静默登录（WXAPIBase 桩同时服务后台与用户端 appid）
	_, body := h.call(t, http.MethodPost, "/api/mp/wx/login", `{"code":"code:fan-001","nickname":"吃货甲"}`)
	if body["ok"] != true {
		t.Fatalf("粉丝登录失败: %v", body)
	}
	tok := dataOf(body)["token"].(string)

	// 点"允许"后记账：配额 +1
	code, body := pipeCall(t, h, tok, http.MethodPost, "/api/mp/subscribe", `{"template_id":"TPL-1"}`)
	if code != http.StatusOK {
		t.Fatalf("订阅记账失败 %d %v", code, body)
	}
	// worker 领取可触达名单
	_, body = pipeCall(t, h, "pt-fan", http.MethodGet, "/api/pipeline/subscribers?channel=wxmini", "")
	subs := dataOf(body)["subscribers"].([]any)
	if len(subs) != 1 || subs[0].(map[string]any)["openid"] != "fan-001" {
		t.Fatalf("名单不对: %v", subs)
	}
	// 发一条核销一次；核销完后名单为空
	_, body = pipeCall(t, h, "pt-fan", http.MethodPost, "/api/pipeline/subscribers/consume",
		`{"channel":"wxmini","openid":"fan-001"}`)
	if body["ok"] != true {
		t.Fatalf("核销失败: %v", body)
	}
	_, body = pipeCall(t, h, "pt-fan", http.MethodGet, "/api/pipeline/subscribers?channel=wxmini", "")
	if len(dataOf(body)["subscribers"].([]any)) != 0 {
		t.Fatalf("核销后不应再有配额: %v", body)
	}
	// 伪造令牌必须被拒
	code, _ = h.call(t, http.MethodPost, "/api/mp/subscribe", `{"template_id":"x"}`)
	if code != http.StatusUnauthorized {
		t.Fatalf("无令牌订阅应 401，实得 %d", code)
	}
	tamper := tok[:len(tok)-2] + "ab"
	code, _ = pipeCall(t, h, tamper, http.MethodPost, "/api/mp/subscribe", `{}`)
	if code != http.StatusUnauthorized {
		t.Fatalf("篡改令牌应 401，实得 %d", code)
	}
}

func TestDyFanLogin(t *testing.T) {
	h := newHarness(t, false)
	// 抖音 code2session 桩
	dyStub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/apps/v2/jscode2session" {
			http.NotFound(w, r)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		if body["code"] == "bad" {
			_, _ = w.Write([]byte(`{"err_no":1001,"err_tips":"invalid code"}`))
			return
		}
		_, _ = w.Write([]byte(`{"err_no":0,"err_tips":"success","data":{"openid":"dy-fan-9","session_key":"k"}}`))
	}))
	defer dyStub.Close()
	h.cfg.DYAppID, h.cfg.DYSecret, h.cfg.DYAPIBase = "ttTESTAPPID", "dy-secret", dyStub.URL

	_, body := h.call(t, http.MethodPost, "/api/mp/dy/login", `{"code":"any"}`)
	if body["ok"] != true {
		t.Fatalf("抖音登录失败: %v", body)
	}
	tok := dataOf(body)["token"].(string)
	// 抖音端不支持订阅推送（渠道校验）
	code, _ := pipeCall(t, h, tok, http.MethodPost, "/api/mp/subscribe", `{}`)
	if code != http.StatusBadRequest {
		t.Fatalf("dymini 订阅应 400，实得 %d", code)
	}
	// 坏 code 被拒
	_, bad := h.call(t, http.MethodPost, "/api/mp/dy/login", `{"code":"bad"}`)
	if bad["ok"] == true {
		t.Fatalf("坏 code 应失败: %v", bad)
	}
}
