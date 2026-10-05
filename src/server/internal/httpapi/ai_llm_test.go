package httpapi

// buildLLMPayload：鉴店联网开关必须如实落到请求体。

import (
	"encoding/json"
	"testing"
)

func TestBuildLLMPayloadSearchFlag(t *testing.T) {
	for _, want := range []bool{true, false} {
		var m map[string]any
		if err := json.Unmarshal(buildLLMPayload("qwen", []any{}, 0.5, 100, want), &m); err != nil {
			t.Fatal(err)
		}
		if m["enable_search"] != want {
			t.Fatalf("enable_search 应为 %v，实得 %v", want, m["enable_search"])
		}
		if m["enable_thinking"] != false {
			t.Fatal("enable_thinking 必须关掉，不然非流式延迟爆炸")
		}
	}
}
