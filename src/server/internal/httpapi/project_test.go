package httpapi_test

// v13 项目制内容生产测试：立项/挂素材/跑步骤/worker 读项目与回填/手改分镜，
// 以及铁律回归——项目步骤任务不污染 uq_task_open 去重、worker 没有放行通道。

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestProjectLifecycle(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner-proj")
	h.cfg.PipelineToken = "pt-proj"

	// 1) 立项 + 首批素材
	code, body := h.call(t, http.MethodPost, "/api/admin/projects",
		`{"title":"测试·西湖夜宵","brief":"带观众夜游吴山夜市，辣条妹出镜","images":["/uploads/2026/01/a.jpg","http://evil.example.com/x.png"]}`)
	if code != 200 {
		t.Fatalf("立项失败 %v", body)
	}
	proj := dataOf(body)
	pid := int64(proj["id"].(float64))
	if pid == 0 || proj["asset_count"] != float64(1) {
		t.Fatalf("应只收下合法 /uploads/ 素材: %v", body)
	}

	// 2) 工作区加素材
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/assets", pid),
		`{"path":"/uploads/2026/01/c.jpg","kind":"charref","note":"三视图"}`)
	if d := dataOf(body); d["id"] == nil {
		t.Fatalf("加素材失败: %v", body)
	}

	// 3) 没分镜就想出成片 → 拒
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"video"}`); code != http.StatusBadRequest {
		t.Fatalf("无分镜出成片应 400，实得 %d", code)
	}

	// 4) 出分镜：落 step + 入队 project_step（review_id=-step_id 不吃 uq_task_open 去重）
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"storyboard","prompt":"加一个锅铲开场"}`)
	d := dataOf(body)
	stepID := int64(d["step_id"].(float64))
	taskID := int64(d["task_id"].(float64))
	if stepID == 0 || taskID == 0 {
		t.Fatalf("出分镜入队失败: %v", body)
	}
	// 同项目连开两步也不该被去重挡（旧 EnqueueTask 会）
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"storyboard","prompt":"再来一版"}`)
	if dataOf(body)["step_id"] == nil {
		t.Fatalf("第二步应可入队: %v", body)
	}

	// 5) worker 侧：领到任务、读项目全貌（含主角定妆参考）、回填分镜
	_, tbody := pipeCall(t, h, "pt-proj", http.MethodGet, "/api/pipeline/poll?limit=10", "")
	tasks, _ := dataOf(tbody)["tasks"].([]any)
	if len(tasks) < 2 {
		t.Fatalf("worker 应能领到两条 project_step，实得 %d（%v）", len(tasks), tbody)
	}
	var tk map[string]any
	for _, x := range tasks {
		if m, _ := x.(map[string]any); m["type"] == "project_step" {
			tk = m
			break
		}
	}
	if tk == nil {
		t.Fatalf("队列里没有 project_step: %v", tasks)
	}
	_, pbody := pipeCall(t, h, "pt-proj", http.MethodGet, pathf("/api/pipeline/projects/%d", pid), "")
	pd := dataOf(pbody)
	if pd["project"] == nil || pd["assets"] == nil {
		t.Fatalf("worker 读项目缺字段: %v", pbody)
	}
	if refs, _ := pd["char_refs"].([]any); len(refs) != 2 {
		t.Fatalf("应下发两张主角定妆参考，实得 %v", pd["char_refs"])
	}

	sb := `{"scenes":[{"kicker":"开场","title":"夜宵开逛","dur":5,"vo":"开逛","hh":true,"ref":"three"}],"caption":"测试文案","hashtags":["辣条妹的御膳房"]}`
	code, body = pipeCall(t, h, "pt-proj", http.MethodPost, pathf("/api/pipeline/project-steps/%d/finish", stepID),
		`{"status":"done","result":`+mustJSON(t, sb)+`,"note":"分镜已出"}`)
	if code == 0 || dataOf(body)["status"] != "done" {
		t.Fatalf("worker 回填步骤失败: %v", body)
	}

	// 6) 辣条妹手改分镜 → 用这版出成片（校验通过即可，渲染在 worker 端）
	edited := `{"scenes":[{"kicker":"开场","title":"夜宵开逛（改）","dur":5,"vo":"开逛","hh":false}],"caption":"改后文案"}`
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/project-steps/%d/save", stepID),
		`{"result":`+mustJSON(t, edited)+`}`)
	if dataOf(body)["saved"] != true {
		t.Fatalf("手改分镜应成功: %v", body)
	}
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/project-steps/%d/save", stepID), `{"result":"{坏JSON"}`); code != http.StatusBadRequest {
		t.Fatalf("坏 JSON 分镜应 400，实得 %d", code)
	}
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"video"}`); code != http.StatusOK {
		t.Fatalf("有分镜后出成片应可入队，实得 %d", code)
	}

	// 渲染引擎：非法值拒；合法值透传进 payload（worker 据此分流 hyperframes/openmontage）。
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"video","renderer":"nonsense"}`); code != http.StatusBadRequest {
		t.Fatalf("未知渲染引擎应 400，实得 %d", code)
	}
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"video","renderer":"openmontage"}`)
	if dataOf(body)["step_id"] == nil {
		t.Fatalf("openmontage 引擎应可入队: %v", body)
	}

	// 7) 重跑一步：新 step 挂新 task，历史保留
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/project-steps/%d/retry", stepID), ``)
	d = dataOf(body)
	if int64(d["step_id"].(float64)) == stepID {
		t.Fatalf("retry 应开新 step: %v", body)
	}

	// 8) 项目详情时间线齐全
	_, body = h.call(t, http.MethodGet, pathf("/api/admin/projects/%d", pid), ``)
	d = dataOf(body)
	if steps, _ := d["steps"].([]any); len(steps) < 5 {
		t.Fatalf("时间线步骤数不对: %v", body)
	}
	if assets, _ := d["assets"].([]any); len(assets) != 2 {
		t.Fatalf("素材数不对: %v", body)
	}

	// 9) 有未终结任务时删项目被拒；worker 无放行通道（回归）
	if code, _ = h.call(t, http.MethodDelete, pathf("/api/admin/projects/%d", pid), ``); code != http.StatusBadRequest {
		t.Fatalf("有在飞任务删项目应 400，实得 %d", code)
	}
}

func TestPipeEnqueueProjectStepReopen(t *testing.T) {
	h := newHarness(t, false)
	h.login(t, "owner-proj2")
	h.cfg.PipelineToken = "pt-proj2"
	_, body := h.call(t, http.MethodPost, "/api/admin/projects", `{"title":"配额顺延","brief":"b"}`)
	pid := int64(dataOf(body)["id"].(float64))
	_, body = h.call(t, http.MethodPost, pathf("/api/admin/projects/%d/steps", pid), `{"kind":"storyboard"}`)
	d := dataOf(body)
	stepID := int64(d["step_id"].(float64))

	// 模拟 worker 配额顺延：先标 step skipped，再经 /api/pipeline/tasks 重排
	pipeCall(t, h, "pt-proj2", http.MethodPost, pathf("/api/pipeline/project-steps/%d/finish", stepID),
		`{"status":"skipped","error":"quota"}`)
	payload, _ := json.Marshal(map[string]any{"project_id": pid, "step_id": stepID, "kind": "storyboard"})
	code, body := pipeCall(t, h, "pt-proj2", http.MethodPost, "/api/pipeline/tasks",
		`{"type":"project_step","review_id":0,"run_after":0,"payload":`+string(payload)+`}`)
	if code != http.StatusOK {
		t.Fatalf("重排应成功: %d %v", code, body)
	}
	_, body = h.call(t, http.MethodGet, pathf("/api/admin/projects/%d", pid), ``)
	for _, x := range dataOf(body)["steps"].([]any) {
		st := x.(map[string]any)
		if int64(st["id"].(float64)) == stepID && st["status"] != "pending" {
			t.Fatalf("重排后步骤应回到 pending: %v", st)
		}
	}
	// 缺 project_id/step_id 的重排请求要拒
	code, _ = pipeCall(t, h, "pt-proj2", http.MethodPost, "/api/pipeline/tasks",
		`{"type":"project_step","review_id":0,"payload":{"kind":"storyboard"}}`)
	if code != http.StatusBadRequest {
		t.Fatalf("裸 project_step 重排应 400，实得 %d", code)
	}
}

// mustJSON 把字符串编码成 JSON 字面量（塞进请求体当字符串字段值）。
func mustJSON(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
