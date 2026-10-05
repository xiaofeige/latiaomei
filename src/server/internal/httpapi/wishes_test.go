package httpapi_test

// v8 许愿池测试：匿名/带身份收愿、字段校验、后台分析、状态流转、
// 一键翻牌转指令、删除。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestWishFlow(t *testing.T) {
	h := newHarness(t, false)

	// 太短被拒
	code, _ := h.call(t, http.MethodPost, "/api/mp/wish", `{"content":"好吃"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("短内容应 400，实得 %d", code)
	}

	// 匿名可许愿
	code, body := h.call(t, http.MethodPost, "/api/mp/wish",
		`{"content":"想让辣条妹去踩西湖边新开的那家网红烤肉店","contact":"wx:latiaofan"}`)
	if code != http.StatusOK {
		t.Fatalf("许愿应 200，实得 %d %v", code, body)
	}
	wish := dataOf(body)["wish"].(map[string]any)
	wid := wish["id"].(float64)
	if wish["channel"] != "anon" {
		t.Fatalf("匿名许愿 channel 应为 anon: %v", wish)
	}
	// 我的愿望（未登录）应 401
	if code, _ := h.call(t, http.MethodGet, "/api/mp/wish/mine", ""); code != http.StatusUnauthorized {
		t.Fatalf("无令牌查我的愿望应 401，实得 %d", code)
	}

	h.login(t, "owner-wish")
	// 后台列表 + 分析
	code, body = h.call(t, http.MethodGet, "/api/admin/wishes?status=new", "")
	if code != http.StatusOK {
		t.Fatalf("后台许愿列表应 200，实得 %d %v", code, body)
	}
	d := dataOf(body)
	if got := len(d["wishes"].([]any)); got != 1 {
		t.Fatalf("new 状态应有 1 条，实得 %d", got)
	}
	stats := d["stats"].(map[string]any)
	if stats["total"] != float64(1) || stats["new"] != float64(1) {
		t.Fatalf("分析计数不对: %v", stats)
	}

	// 状态流转 + 批复
	code, body = h.call(t, http.MethodPost, fmt.Sprintf("/api/admin/wishes/%d/status", int64(wid)), `{"status":"read","note":"记下了"}`)
	if code != http.StatusOK {
		t.Fatalf("状态流转应 200: %d %v", code, body)
	}
	_, body = h.call(t, http.MethodGet, "/api/admin/wishes?status=read", "")
	w := dataOf(body)["wishes"].([]any)[0].(map[string]any)
	if w["note"] != "记下了" {
		t.Fatalf("批复没存上: %v", w)
	}

	// 翻牌转指令：愿望变 topic 指令并自动 picked
	_, body = h.call(t, http.MethodPost, fmt.Sprintf("/api/admin/wishes/%d/directive", int64(wid)), `{}`)
	if body["ok"] != true {
		t.Fatalf("转指令失败: %v", body)
	}
	_, body = h.call(t, http.MethodGet, "/api/admin/directives?status=open", "")
	dl, _ := dataOf(body)["directives"].([]any)
	if len(dl) != 1 {
		t.Fatalf("应有 1 条指令，实得 %d (%v)", len(dl), body)
	}
	dir := dl[0].(map[string]any)
	if dir["kind"] != "topic" {
		t.Fatalf("指令 kind 应为 topic: %v", dir)
	}
	_, body = h.call(t, http.MethodGet, "/api/admin/wishes?status=picked", "")
	if got := len(dataOf(body)["wishes"].([]any)); got != 1 {
		t.Fatalf("翻牌后 picked 应 1 条，实得 %d", got)
	}

	// 删除
	code, _ = h.call(t, http.MethodDelete, fmt.Sprintf("/api/admin/wishes/%d", int64(wid)), "")
	if code != http.StatusOK {
		t.Fatalf("删除应 200，实得 %d", code)
	}
	if code, _ := h.call(t, http.MethodDelete, fmt.Sprintf("/api/admin/wishes/%d", int64(wid)), ""); code != http.StatusNotFound {
		t.Fatalf("再删应 404，实得 %d", code)
	}
}

// v10 呼声墙测试：匿名上墙、马甲不泄漏身份、喊一声可撤销、被拒的下墙。
func TestWishWall(t *testing.T) {
	h := newHarness(t, false)
	h.cfg.MPAppID, h.cfg.MPSecret = "wxMPAPPID", "mp-secret"

	// 粉丝登录（MP 小令牌）
	code, body := h.call(t, http.MethodPost, "/api/mp/wx/login", `{"code":"code:fan-wall-1","nickname":"饭搭子甲"}`)
	if code != http.StatusOK {
		t.Fatalf("MP 登录应 200: %d %v", code, body)
	}
	fanTok := dataOf(body)["token"].(string)

	mk := func(content string) int64 {
		h.token = fanTok
		code, body := h.call(t, http.MethodPost, "/api/mp/wish", `{"content":"`+content+`"}`)
		if code != http.StatusOK {
			t.Fatalf("许愿应 200: %d %v", code, body)
		}
		return int64(dataOf(body)["wish"].(map[string]any)["id"].(float64))
	}
	id1 := mk("想去灵隐寺旁边的素面，真的好吃吗")
	id2 := mk("未来科技城那家新开的烤肉替我踩踩")

	// 匿名读墙：两条，字段不得出现 openid/contact；马甲稳定且不是匿名文案
	h.token = ""
	code, body = h.call(t, http.MethodGet, "/api/mp/wish/wall?sort=new", "")
	if code != http.StatusOK {
		t.Fatalf("读墙应 200: %d %v", code, body)
	}
	d := dataOf(body)
	list, _ := d["wishes"].([]any)
	if len(list) != 2 || d["total"].(float64) != 2 {
		t.Fatalf("墙应有 2 条: %v", body)
	}
	raw, _ := json.Marshal(list)
	if strings.Contains(string(raw), "openid") || strings.Contains(string(raw), "fan-wall-1") {
		t.Fatalf("墙泄漏了身份字段: %s", raw)
	}
	w1 := list[0].(map[string]any)
	if w1["nick"] == "" || w1["nick"] == "没留名的吃货" {
		t.Fatalf("登录许愿应有马甲: %v", w1)
	}
	if w1["mine"] != false {
		t.Fatalf("匿名看客 mine 应为 false: %v", w1)
	}

	// 本人看墙：mine 标出来
	h.token = fanTok
	_, body = h.call(t, http.MethodGet, "/api/mp/wish/wall?sort=new", "")
	list = dataOf(body)["wishes"].([]any)
	if list[0].(map[string]any)["mine"] != true {
		t.Fatalf("本人看墙 mine 应为 true: %v", list[0])
	}

	// 喊一声（奇数次=赞上，再点=撤销）
	code, body = h.call(t, http.MethodPost, "/api/mp/wish/like", fmt.Sprintf(`{"id":%d}`, id1))
	if code != http.StatusOK || body["data"] == nil {
		t.Fatalf("点赞应 200: %d %v", code, body)
	}
	ld := dataOf(body)
	if ld["liked"] != true || ld["likes"].(float64) != 1 {
		t.Fatalf("点赞结果不对: %v", ld)
	}
	_, body = h.call(t, http.MethodPost, "/api/mp/wish/like", fmt.Sprintf(`{"id":%d}`, id1))
	ld = dataOf(body)
	if ld["liked"] != false || ld["likes"].(float64) != 0 {
		t.Fatalf("再点应撤销: %v", ld)
	}
	// id2 点满 3 下（奇数次=赞上），hot 排序应它在前
	for i := 0; i < 3; i++ {
		h.call(t, http.MethodPost, "/api/mp/wish/like", fmt.Sprintf(`{"id":%d}`, id2))
	}
	code, body = h.call(t, http.MethodGet, "/api/mp/wish/wall?sort=hot", "")
	list = dataOf(body)["wishes"].([]any)
	if int64(list[0].(map[string]any)["id"].(float64)) != id2 {
		t.Fatalf("hot 排序应呼声最高的在前: %v", list)
	}
	if list[0].(map[string]any)["liked"] != true {
		t.Fatalf("fan 自己点过赞应标 liked: %v", list[0])
	}

	// 辣条妹标「暂不做」→ 下墙，点赞入口 404
	h.login(t, "owner-wish2")
	code, _ = h.call(t, http.MethodPost, fmt.Sprintf("/api/admin/wishes/%d/status", id2), `{"status":"rejected"}`)
	if code != http.StatusOK {
		t.Fatalf("标暂不做应 200: %d", code)
	}
	_, body = h.call(t, http.MethodGet, "/api/mp/wish/wall", "")
	list = dataOf(body)["wishes"].([]any)
	if len(list) != 1 || int64(list[0].(map[string]any)["id"].(float64)) != id1 {
		t.Fatalf("下墙后应只剩 1 条: %v", list)
	}
	h.token = fanTok
	code, _ = h.call(t, http.MethodPost, "/api/mp/wish/like", fmt.Sprintf(`{"id":%d}`, id2))
	if code != http.StatusNotFound {
		t.Fatalf("给下墙愿望点赞应 404: %d", code)
	}
}
