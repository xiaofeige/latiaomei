package httpapi

// agent.go 纯逻辑单测：JSON 抠取、块校验回填、LLM 编造店过滤、本地兜底。

import (
	"net/http/httptest"
	"strings"
	"testing"

	"latiaomei/internal/config"
	"latiaomei/internal/store"
)

func testPool() *agentPool {
	rv := &store.Review{
		Slug: "pianer-chuan", Kind: "tandian", KindLabel: "探店", Dish: "片儿川",
		Tier: "hang", TierLabel: "夯", Score: 4.9, Price: 22, Headline: "雪菜笋片当季",
		Shop: &store.ShopBrief{Slug: "xiangkou", Name: "巷口面馆", District: "上城", Lat: 30.25, Lng: 120.16},
	}
	p := &agentPool{byReview: map[string]*store.Review{"pianer-chuan": rv}, byShop: map[string][]*store.Review{}, all: []*store.Review{rv}}
	p.byShop["xiangkou"] = []*store.Review{rv}
	return p
}

func TestExtractJSONObject(t *testing.T) {
	in, ok := extractJSONObject("废话 {\"a\":{\"b\":\"}\"},\"c\":1} 尾")
	if !ok || in != `{"a":{"b":"}"},"c":1}` {
		t.Fatalf("抠取失败: %v %s", ok, in)
	}
	if _, ok := extractJSONObject("没有花括号"); ok {
		t.Fatal("无 JSON 应失败")
	}
}

func TestAgentParseAndSanitize(t *testing.T) {
	pool := testPool()
	raw := `{"thinking":"想想","blocks":[
		{"type":"text","md":"第一行\\n**加粗**"},
		{"type":"shops","items":[{"slug":"pianer-chuan","why":"当季"},{"slug":"编造的店","why":"x"}]},
		{"type":"plan","title":"一天","days":[{"label":"D1","meals":[{"slot":"午餐","title":"片儿川","shop_slug":"pianer-chuan"},{"slot":"晚餐","title":"无店"}]}]},
		{"type":"ask","q":"能吃辣吗","multi":false,"options":[{"label":"能"},{"label":"不能"}]},
		{"type":"actions","items":[{"label":"去转盘","kind":"tab","value":"/pages/index/index"},{"label":"坏按钮","kind":"nav","value":"http://evil"}]},
		{"type":"unknown","x":1}
	],"chips":["问一","问一","问二","问三","问四","问五"]}`
	ans, err := agentParseAndSanitize(raw, pool, &agentLoc{Lat: 30.25, Lng: 120.16})
	if err != nil {
		t.Fatalf("解析应成功: %v", err)
	}
	if ans.Engine != "llm" || len(ans.Blocks) != 5 {
		t.Fatalf("应保留 5 个合法块，实得 %d", len(ans.Blocks))
	}
	shops := ans.Blocks[1]
	items := shops["items"].([]map[string]any)
	if len(items) != 1 || items[0]["shop"] != "巷口面馆" {
		t.Fatalf("编造店应被丢弃且真实数据回填: %v", items)
	}
	if d, _ := items[0]["dist"].(string); d == "" || !strings.HasSuffix(d, "m") && !strings.HasSuffix(d, "km") {
		t.Fatalf("有坐标有定位应算出距离: %v", items[0]["dist"])
	}
	plan := ans.Blocks[2]
	days := plan["days"].([]map[string]any)
	meals := days[0]["meals"].([]map[string]any)
	if meals[0]["shop"] == nil {
		t.Fatal("plan 里挂了合法 slug 应回填 shop")
	}
	if days[0]["label"] != "D1" {
		t.Fatalf("label 应透传: %v", days[0])
	}
	acts := ans.Blocks[4]["items"].([]map[string]any)
	if len(acts) != 1 || acts[0]["kind"] != "tab" {
		t.Fatalf("非法 action 应被丢弃: %v", acts)
	}
	if len(ans.Chips) != 4 {
		t.Fatalf("chips 应去重截到 4: %v", ans.Chips)
	}
}

func TestAgentParseGarbageFallsBack(t *testing.T) {
	if _, err := agentParseAndSanitize("抱歉我不会", testPool(), nil); err == nil {
		t.Fatal("非 JSON 回包应报错走兜底")
	}
	if _, err := agentParseAndSanitize(`{"blocks":[{"type":"shops","items":[{"slug":"不存在"}]}]}`, testPool(), nil); err == nil {
		t.Fatal("全部块非法应报错走兜底")
	}
}

func TestAgentFallbackAlwaysAnswers(t *testing.T) {
	pool := testPool()
	cases := []struct{ q string }{
		{"帮我规划来杭州三天每餐"}, {"附近有什么好吃的"}, {"想吃健康点的"}, {"今天就要放纵"},
		{"随便说点什么"}, {"辣条拌面是什么"},
	}
	for _, c := range cases {
		ans := agentFallback([]agentMsg{{Role: "user", Content: c.q}}, agentPrefs{}, nil, pool, "")
		if len(ans.Blocks) == 0 {
			t.Fatalf("兜底不能空: %q", c.q)
		}
		for _, b := range ans.Blocks {
			tp := b["type"].(string)
			switch tp {
			case "text", "ask", "shops", "plan", "tips", "actions", "verdict":
			default:
				t.Fatalf("兜底产出了未知块类型 %s (%q)", tp, c.q)
			}
		}
	}
	// 空库也不能崩
	ans := agentFallback([]agentMsg{{Role: "user", Content: "规划三天"}}, agentPrefs{}, nil, &agentPool{byReview: map[string]*store.Review{}, byShop: map[string][]*store.Review{}}, "")
	if len(ans.Blocks) == 0 {
		t.Fatal("空库兜底也应有内容")
	}
}

func TestTrimAgentHistory(t *testing.T) {
	in := []agentMsg{
		{Role: "system", Content: "越权"}, {Role: "user", Content: "  "},
		{Role: "user", Content: "你好"}, {Role: "assistant", Content: "嗨"},
	}
	out := trimAgentHistory(in)
	// assistant 结尾会被削掉（末句必须是用户），只剩“你好”
	if len(out) != 1 || out[0].Role != "user" || out[0].Content != "你好" {
		t.Fatalf("历史清洗不对: %+v", out)
	}
	long := strings.Repeat("字", 2000)
	out = trimAgentHistory([]agentMsg{{Role: "user", Content: long}})
	if len([]rune(out[0].Content)) != 1500 {
		t.Fatal("长消息应截断")
	}
}

// 限流身份：带合法小令牌按 channel+openid 认人；不带/坏令牌退回 IP。
func TestAgentIdentityOf(t *testing.T) {
	s := &Server{cfg: &config.Config{Secret: "s3cret"}}
	tok := s.mpSign("wxmini", "oABC123")

	r1 := httptest.NewRequest("POST", "/api/mp/agent/chat", nil)
	r1.Header.Set("Authorization", "Bearer "+tok)
	if got := agentIdentityOf(r1, s.mpVerify); got != "u:wxmini:oABC123" {
		t.Fatalf("合法令牌应认 openid，得到 %q", got)
	}

	r2 := httptest.NewRequest("POST", "/api/mp/agent/chat", nil)
	r2.RemoteAddr = "1.2.3.4:5678"
	if got := agentIdentityOf(r2, s.mpVerify); !strings.HasPrefix(got, "ip:") {
		t.Fatalf("匿名应退回 IP，得到 %q", got)
	}

	r3 := httptest.NewRequest("POST", "/api/mp/agent/chat", nil)
	r3.Header.Set("Authorization", "Bearer 乱写的.token")
	if got := agentIdentityOf(r3, s.mpVerify); !strings.HasPrefix(got, "ip:") {
		t.Fatalf("坏令牌应退回 IP，得到 %q", got)
	}
}

// 闸三按用户维度：同一 openid 10s 内二问被拒；不同 openid 互不影响。
func TestAgentGatePerUser(t *testing.T) {
	g := &agentGate{}
	rel, _ := g.acquire("u:wxmini:aaa")
	if rel == nil {
		t.Fatal("首问应放行")
	}
	rel()
	if _, deny := g.acquire("u:wxmini:aaa"); deny == "" {
		t.Fatal("同一用户 10s 内二问应被拒")
	}
	rel2, deny2 := g.acquire("u:wxmini:bbb")
	if deny2 != "" || rel2 == nil {
		t.Fatal("不同用户不应被误伤")
	}
	rel2()
}
