package httpapi

import (
	"strings"
	"testing"
)

func TestParsePatrolVerdictBasic(t *testing.T) {
	// 模拟模型爱干的活：包围栏 + 前后说废话。解析要抠出中间 JSON。
	fence := "```"
	body := `{"shop":"胖哥鱼头王","known":true,"level":"foggy","score":6.2,"confidence":0.55,` +
		`"judge":"吹得凶，咸度翻车多","advice":"鱼头必点但让后厨少放盐",` +
		`"summary":"小红书上最近全是发光滤镜笔记，但点评里近期差评集中在齁咸和服务慢。",` +
		`"signals":[{"k":"评论分布","v":"好评集中在带图笔记，差评聚在口味与服务","good":-1},` +
		`{"k":"刷单检测","v":"小红书文案同质化高，疑似集中投放","good":-1},` +
		`{"k":"差评聚焦点","v":"齁咸、高峰等位40分钟起","good":-1}],` +
		`"platforms":[{"name":"大众点评","v":"3.9分口碑两极","good":0},` +
		`{"name":"高德","v":"扫街榜未见","good":0}],` +
		`"dishes":["鱼头泡饭"],"sources":["小红书","大众点评","高德"]}`
	raw := "好的，判决如下：\n" + fence + "json\n" + body + "\n" + fence + "\n后两句废话"

	a, err := parsePatrolVerdict(raw, "胖哥鱼头王", "杭州")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if a.ShopName != "胖哥鱼头王" || a.Level != "foggy" {
		t.Fatalf("店名/等级不对: %+v", a)
	}
	if a.Score < 6.1 || a.Score > 6.3 {
		t.Fatalf("分数钳位异常: %v", a.Score)
	}
	if len(a.Signals) != 3 || len(a.Platforms) != 2 {
		t.Fatalf("信号/平台条数不对: %d %d", len(a.Signals), len(a.Platforms))
	}
	if a.Dishes[0] != "鱼头泡饭" {
		t.Fatalf("dishes 不对: %v", a.Dishes)
	}
}

func TestParsePatrolVerdictUnknownDemoted(t *testing.T) {
	// known=false 的高分判决必须被按回 unknown，把握度钳 0.2。
	raw := `{"shop":"某某小馆","known":false,"level":"solid","score":9.1,"confidence":0.9,` +
		`"judge":"没搜到啥","signals":[{"k":"评论分布","v":"没见过可靠信息","good":0},` +
		`{"k":"刷单检测","v":"没数据","good":0}]}`
	a, err := parsePatrolVerdict(raw, "某某小馆", "杭州")
	if err != nil {
		t.Fatal(err)
	}
	if a.Level != "unknown" || a.Confidence > 0.2 {
		t.Fatalf("known=false 未降级: level=%s conf=%v", a.Level, a.Confidence)
	}
}

func TestParsePatrolVerdictFewSignals(t *testing.T) {
	// 证据不足两条的「有把握判决」不可信 → unknown。
	raw := `{"shop":"甲店","known":true,"level":"solid","score":8.8,"confidence":0.9,` +
		`"judge":"就是好","signals":[{"k":"评论分布","v":"好评多","good":1}]}`
	a, err := parsePatrolVerdict(raw, "甲店", "杭州")
	if err != nil {
		t.Fatal(err)
	}
	if a.Level != "unknown" {
		t.Fatalf("信号不足应降级，got %s", a.Level)
	}
}

func TestParsePatrolVerdictScoreClamp(t *testing.T) {
	raw := `{"shop":"乙店","known":true,"level":"solid","score":23,"confidence":9,` +
		`"judge":"好","signals":[{"k":"a","v":"b","good":1},{"k":"c","v":"d","good":1}]}`
	a, err := parsePatrolVerdict(raw, "乙店", "杭州")
	if err != nil {
		t.Fatal(err)
	}
	if a.Score > 10 || a.Confidence > 1 {
		t.Fatalf("未钳位: score=%v conf=%v", a.Score, a.Confidence)
	}
}

func TestParsePatrolVerdictGarbage(t *testing.T) {
	if _, err := parsePatrolVerdict("这家店挺好的，推荐去。", "随便", "杭州"); err == nil {
		t.Fatal("无 JSON 应报错")
	}
	if _, err := parsePatrolVerdict("这里有个{但没闭合", "随便", "杭州"); err == nil {
		t.Fatal("残缺 JSON 应报错")
	}
}

func TestParsePatrolVerdictNameAnchored(t *testing.T) {
	// 模型编了个店名：判例必须仍挂在巡逻目标上，且留痕可查。
	raw := `{"shop":"不存在饭店","known":true,"level":"solid","score":8.0,` +
		`"judge":"不错","signals":[{"k":"a","v":"b","good":1},{"k":"c","v":"d","good":1}]}`
	a, err := parsePatrolVerdict(raw, "默默小馆", "杭州")
	if err != nil {
		t.Fatal(err)
	}
	if a.ShopName != "默默小馆" {
		t.Fatalf("店名被模型带跑: %s", a.ShopName)
	}
	if !strings.Contains(a.Judge, "AI回名") {
		t.Fatalf("应留回名不一致痕: %s", a.Judge)
	}
}

func TestPatrolUserPromptHasEvidence(t *testing.T) {
	p := patrolUserPrompt("老干店", "杭州", "- 高德到店：高德评分4.6\n")
	if !strings.Contains(p, "老干店") || !strings.Contains(p, "高德评分4.6") {
		t.Fatalf("prompt 缺要素: %s", p)
	}
}

func TestAmapRatingNum(t *testing.T) {
	if amapRatingNum("4.5") != 4.5 || amapRatingNum("") != 0 || amapRatingNum("abc") != 0 {
		t.Fatal("评分解析不对")
	}
}
