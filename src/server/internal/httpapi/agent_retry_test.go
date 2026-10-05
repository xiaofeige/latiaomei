package httpapi

// agentLLMFormatRetry：回包不合输出协议时只重试一次，重试对话里必须带上
// 坏回包当反例 + 严令纠正；通道本身出错不重试；两次都不合协议则报错走兜底。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"latiaomei/internal/config"
)

// llmStub 起一个 OpenAI 兼容假端点，按脚本顺序回 content；请求原样记下。
func llmStub(t *testing.T, contents []string) (*httptest.Server, *sync.Mutex, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	var got []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		mu.Lock()
		got = append(got, m)
		i := n
		n++
		mu.Unlock()
		content := contents[0]
		if i < len(contents) {
			content = contents[i]
		}
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":`+quoteJSON(content)+`}}]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &mu, &got
}

func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func retryServer(t *testing.T, url string) *Server {
	t.Helper()
	base := strings.TrimPrefix(url, "http://")
	host := "http://" + base
	return &Server{cfg: &config.Config{LLMBase: host, LLMKey: "k", LLMModel: "stub"}}
}

const goodReply = `{"thinking":"想想","blocks":[{"type":"text","md":"落胃"}],"chips":["还有啥"]}`

func TestAgentLLMFormatRetrySucceeds(t *testing.T) {
	srv, mu, got := llmStub(t, []string{"[ask 你住哪片] [shops 上城夜宵推荐]", goodReply})
	s := retryServer(t, srv.URL)
	chat := []map[string]string{{"role": "system", "content": "sys"}, {"role": "user", "content": "附近吃啥"}}
	ans, err := s.agentLLMFormatRetry(context.Background(), chat, false, testPool(), nil)
	if err != nil {
		t.Fatalf("重试后应成功: %v", err)
	}
	if ans.Engine != "llm" || len(ans.Blocks) != 1 {
		t.Fatalf("回包不对: %+v", ans)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 2 {
		t.Fatalf("应恰好两次请求，实得 %d", len(*got))
	}
	msgs, _ := json.Marshal((*got)[1]["messages"])
	mj := string(msgs)
	if !strings.Contains(mj, "[ask 你住哪片]") || !strings.Contains(mj, "你上一条没有按") {
		t.Fatalf("重试请求应带坏回包反例与纠正指令: %s", trimRunes(mj, 300))
	}
}

func TestAgentLLMFormatRetryNoParseTwice(t *testing.T) {
	// 只允许两次请求：第二次仍坏就直接报错，不许无限重试。
	srv, mu, got := llmStub(t, []string{"坏", "更坏"})
	s := retryServer(t, srv.URL)
	chat := []map[string]string{{"role": "user", "content": "x"}}
	if _, err := s.agentLLMFormatRetry(context.Background(), chat, false, testPool(), nil); err == nil {
		t.Fatal("应报错")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 2 {
		t.Fatalf("应恰好两次请求，实得 %d", len(*got))
	}
}

func TestAgentLLMFormatRetryFirstGoodNoSecond(t *testing.T) {
	srv, mu, got := llmStub(t, []string{goodReply, "不该被用到"})
	s := retryServer(t, srv.URL)
	chat := []map[string]string{{"role": "user", "content": "x"}}
	if _, err := s.agentLLMFormatRetry(context.Background(), chat, false, testPool(), nil); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 1 {
		t.Fatalf("首包合规不该重试，实得 %d 次", len(*got))
	}
}
