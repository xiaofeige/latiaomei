package store

// 内容主题（reviews.kind）：同一条目表里跑两个栏目，接口按 kind 切流。
//
//	tandian    —— 探店：出去踩店写的点评（默认值，v1 老数据迁移后全是它）
//	yushanfang —— 御膳房：辣条妹自己灶台上复刻的菜谱
//
// 新增主题只动这一个文件 + 前台路由表，别在 SQL 里写死字面量。
const (
	KindTandian    = "tandian"
	KindYushanfang = "yushanfang"
)

// ValidKind 校验内容主题。未知值一律拒，落到白名单默认 tandian。
func ValidKind(code string) bool {
	switch code {
	case KindTandian, KindYushanfang:
		return true
	}
	return false
}

// KindLabel 把主题码翻译成前端显示字。
func KindLabel(code string) string {
	switch code {
	case KindYushanfang:
		return "御膳房"
	case KindTandian:
		return "探店"
	}
	return code
}
