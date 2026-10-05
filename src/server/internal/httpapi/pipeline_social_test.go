package httpapi_test

// v9 社媒人审闸门测试：管理端发任务 → worker 产待审文案 → 不放行就发不出去；
// 放行才入队发布；驳回连带撤任务；worker 侧入队发布必须带已放行 item。

import (
	"net/http"
	"testing"
)

func TestSocialMissionReviewGate(t *testing.T) {
	h := newHarness(t, false)
	h.cfg.PipelineToken = "pt-social"
	h.login(t, "owner-social")
	// 关闭自动分发开关，只验手动 mission 链路，免得任务数受默认开关干扰。
	if err := h.st.SaveSettings(map[string]string{
		"pipeline_video": "0", "pipeline_gzh": "0", "pipeline_wxpush": "0",
		"pipeline_douyin": "0", "pipeline_xiaohongshu": "0", "pipeline_zhihu": "0", "pipeline_weibo": "0",
	}); err != nil {
		t.Fatalf("预设开关: %v", err)
	}
	rid := firstReviewID(t, h)
	if _, b := h.call(t, http.MethodPost, pathf("/api/admin/reviews/%d/status", rid), `{"status":"published"}`); b["ok"] != true {
		t.Fatalf("发布内容失败: %v", b)
	}

	// 1) 管理端发任务（mission）：选两平台。
	code, b := h.call(t, http.MethodPost, "/api/admin/missions",
		`{"review_id":`+itoa(rid)+`,"platforms":["xiaohongshu","weibo"],"note":"多放点图"}`)
	if code != 200 || b["ok"] != true {
		t.Fatalf("发任务失败: %d %v", code, b)
	}
	if dataOf(b)["added"] != true {
		t.Fatalf("mission 应入队: %v", b)
	}
	// 同内容重复发：未终结任务去重。
	_, b = h.call(t, http.MethodPost, "/api/admin/missions",
		`{"review_id":`+itoa(rid)+`,"platforms":["xiaohongshu"]}`)
	if dataOf(b)["added"] != false {
		t.Fatalf("重复 mission 应去重: %v", b)
	}

	// 2) worker 想跳过人审直接入队发布 → 必须 403。
	if code, _ = pipeCall(t, h, "pt-social", http.MethodPost, "/api/pipeline/tasks",
		`{"type":"xiaohongshu","review_id":`+itoa(rid)+`}`); code != http.StatusForbidden {
		t.Fatalf("无 item 入队发布应 403，实得 %d", code)
	}

	// 3) worker 产待审文案：即使自称 approved 也会被强制 pending。
	_, b = pipeCall(t, h, "pt-social", http.MethodPost, "/api/pipeline/social-items",
		`{"gen_task_id":1,"review_id":`+itoa(rid)+`,"platform":"xiaohongshu","status":"approved",`+
			`"title":"儿川上新","body":"面汤鲜掉眉毛","tags":["杭州美食"],"images":["/uploads/a.jpg"]}`)
	item := dataOf(b)
	iid, _ := item["id"].(float64)
	if iid == 0 || item["status"] != "pending" {
		t.Fatalf("worker 产文应落 pending: %v", b)
	}

	// 4) 管理端能看到、能改稿。
	_, b = h.call(t, http.MethodGet, "/api/admin/social-items?status=pending", "")
	d := dataOf(b)
	if items, _ := d["items"].([]any); len(items) != 1 {
		t.Fatalf("待审列表应为 1: %v", b)
	}
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/social-items/%d/save", int64(iid)),
		`{"title":"改过的标题","body":"改过的正文","tags":["杭州","探店"]}`); code != 200 {
		t.Fatalf("改稿应 200，实得 %d", code)
	}

	// 5) 放行 → 自动入队发布任务（带 item_id）。
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/social-items/%d/approve", int64(iid)), `{}`); code != 200 {
		t.Fatalf("放行失败: %d", code)
	}
	_, b = h.call(t, http.MethodGet, "/api/admin/tasks?status=pending&type=xiaohongshu", "")
	tasks, _ := dataOf(b)["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("放行后应有 1 条发布任务: %v", b)
	}
	pubTaskID := int64(tasks[0].(map[string]any)["id"].(float64))
	payload, _ := tasks[0].(map[string]any)["payload"].(map[string]any)
	if payload == nil || payload["item_id"] == nil {
		t.Fatalf("发布任务 payload 应带 item_id: %v", tasks[0])
	}
	// worker 带着已放行 item 入队：通道打开（去重 added=false 也算通过 403 检查）。
	if code, _ = pipeCall(t, h, "pt-social", http.MethodPost, "/api/pipeline/tasks",
		`{"type":"xiaohongshu","review_id":`+itoa(rid)+`,"payload":{"item_id":`+itoa(int64(iid))+`}}`); code != 200 {
		t.Fatalf("带已放行 item 入队应 200，实得 %d", code)
	}
	// worker 回读 item（发布前校验用）。
	_, b = pipeCall(t, h, "pt-social", http.MethodGet, pathf("/api/pipeline/social-items/%d", int64(iid)), "")
	if dataOf(b)["status"] != "approved" || dataOf(b)["title"] != "改过的标题" {
		t.Fatalf("回读 item 不对: %v", b)
	}

	// 6) worker 只能回填 published/failed，回填后 item 变已发布。
	if code, _ = pipeCall(t, h, "pt-social", http.MethodPost,
		pathf("/api/pipeline/social-items/%d/result", int64(iid)),
		`{"status":"published","result":"/uploads/social/xiaohongshu/r1.md"}`); code != 200 {
		t.Fatalf("回填发布结果失败: %d", code)
	}
	_, b = h.call(t, http.MethodGet, "/api/admin/social-items?status=published", "")
	if items, _ := dataOf(b)["items"].([]any); len(items) != 1 {
		t.Fatalf("已发布列表应为 1: %v", b)
	}

	// 6.5) 链式发布：同平台再产一条并放行——发布槽被占，入队被去重挡住；
	//      等旧任务终结后，服务端应自动补排它的发布任务，滞留稿不丢发。
	_, b = pipeCall(t, h, "pt-social", http.MethodPost, "/api/pipeline/social-items",
		`{"gen_task_id":3,"review_id":`+itoa(rid)+`,"platform":"xiaohongshu","title":"第二稿","body":"追加一篇"}`)
	iid2 := dataOf(b)["id"].(float64)
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/social-items/%d/approve", int64(iid2)), `{}`); code != 200 {
		t.Fatalf("第二条放行失败: %d", code)
	}
	_, b = h.call(t, http.MethodGet, "/api/admin/tasks?status=pending&type=xiaohongshu", "")
	if tasks2, _ := dataOf(b)["tasks"].([]any); len(tasks2) != 1 {
		t.Fatalf("槽位未释放前应仍只有 1 条发布任务: %v", b)
	}
	// worker 宣告旧发布任务终结 → 服务端链式补排第二条。
	if code, _ = pipeCall(t, h, "pt-social", http.MethodPost,
		pathf("/api/pipeline/tasks/%d/finish", pubTaskID), `{"status":"done"}`); code != 200 {
		t.Fatalf("任务终结失败: %d", code)
	}
	_, b = h.call(t, http.MethodGet, "/api/admin/tasks?status=pending&type=xiaohongshu", "")
	tasks3, _ := dataOf(b)["tasks"].([]any)
	if len(tasks3) != 1 {
		t.Fatalf("终结后应链式补排第二条: %v", b)
	}
	p3, _ := tasks3[0].(map[string]any)["payload"].(map[string]any)
	if p3["item_id"] != iid2 {
		t.Fatalf("链式任务应指向第二条: %v", tasks3[0])
	}

	// 7) 驳回链路：weibo 的文案 → pending → 驳回；驳回后不放行就永远没有发布任务。
	_, b = pipeCall(t, h, "pt-social", http.MethodPost, "/api/pipeline/social-items",
		`{"gen_task_id":2,"review_id":`+itoa(rid)+`,"platform":"weibo","title":"微博短款","body":"三十字真话"}`)
	wid := dataOf(b)["id"].(float64)
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/social-items/%d/reject", int64(wid)),
		`{"note":"口吻不对，重写"}`); code != 200 {
		t.Fatalf("驳回失败: %d", code)
	}
	_, b = pipeCall(t, h, "pt-social", http.MethodGet, pathf("/api/pipeline/social-items/%d", int64(wid)), "")
	if dataOf(b)["status"] != "rejected" || dataOf(b)["note"] != "口吻不对，重写" {
		t.Fatalf("驳回后 item 状态不对: %v", b)
	}
	// 未放行的 weibo 不允许 worker 入队发布。
	if code, _ = pipeCall(t, h, "pt-social", http.MethodPost, "/api/pipeline/tasks",
		`{"type":"weibo","review_id":`+itoa(rid)+`,"payload":{"item_id":`+itoa(int64(wid))+`}}`); code != http.StatusForbidden {
		t.Fatalf("未放行 item 入队应 403，实得 %d", code)
	}
	// 已发布的内容再驳回 → 400。
	if code, _ = h.call(t, http.MethodPost, pathf("/api/admin/social-items/%d/reject", int64(iid)), `{}`); code != 400 {
		t.Fatalf("已发布再驳回应 400，实得 %d", code)
	}
}

func itoa(v int64) string {
	// 小工具：避免每个用例里 fmt.Sprintf 满天飞。
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
