package main

import (
	"errors"
	"fmt"

	"latiaomei/internal/store"
)

// seedTag 是新标签的声明。
// slug 必须显式给出：中文名过 sanitizeSlug 会变空，靠自动生成会得到一串随机码，
// 那样后台里改口味就得猜 slug 了。
type seedTag struct {
	Slug   string
	Name   string
	Kind   string
	SortNo int
}

// 口味（kind=taste）和场景（kind=scene）分开排 sort_no，前端筛选面板按这个顺序出。
var seedTags = []seedTag{
	{"mala", "麻辣", "taste", 10},
	{"xianxian", "咸鲜", "taste", 20},
	{"tian", "甜口", "taste", 30},
	{"suanla", "酸辣", "taste", 40},
	{"guoqi", "锅气", "taste", 50},
	{"qingdan", "清淡", "taste", 60},
	{"yirenshi", "一人食", "scene", 10},
	{"shenye", "深夜食堂", "scene", 20},
	{"bendiren", "本地人带路", "scene", 30},
	{"yuemi", "多约几个人", "scene", 40},
	{"dateka", "游客打卡", "scene", 50},
	{"daibao", "打包带走", "scene", 60},
}

// seedShop 把店铺和它的 slug 放在一起：点评靠 slug 挂店，不用记住自增 id。
type seedShop struct {
	Slug string
	Shop store.Shop
}

var seedShops = []seedShop{
	{
		Slug: "laohangbang-mian",
		Shop: store.Shop{
			Name: "老杭帮面馆", City: "杭州", District: "拱墅",
			Address: "拱墅区小河直街 12 号", Cuisine: "杭帮面", AvgPrice: 32,
			Hours: "06:30-14:00（卖完就收）",
			Cover: "/img/seed/dish-noodles.jpg",
			Note:  "老板娘自己下面，鳝丝现爆。过了 13 点基本就没了，别抱着运气来。",
		},
	},
	{
		Slug: "xiangkou-pianerchuan",
		Shop: store.Shop{
			Name: "巷口片儿川", City: "杭州", District: "上城",
			Address: "上城区十五奎巷 3 号", Cuisine: "杭帮面", AvgPrice: 22,
			Hours: "07:00-13:30",
			Cover: "/img/seed/dish-noodles.jpg",
			Note:  "开了二十多年的街边铺子，就四个锅，中午排队站到巷口。",
		},
	},
	{
		Slug: "gongchenqiao-youduner",
		Shop: store.Shop{
			Name: "拱宸桥油墩儿", City: "杭州", District: "拱墅",
			Address: "拱墅区桥弄街 28 号", Cuisine: "杭州小吃", AvgPrice: 15,
			Hours: "15:00-19:30",
			Cover: "/img/seed/dish-dessert.jpg",
			Note:  "下午才出摊，一锅一锅炸，赶不上就明天。",
		},
	},
	{
		Slug: "xihu-sifangcai",
		Shop: store.Shop{
			Name: "西湖边私房菜", City: "杭州", District: "西湖",
			Address: "西湖区北山街 76 号", Cuisine: "杭帮菜", AvgPrice: 168,
			Hours: "11:00-14:00 / 17:00-21:00",
			Cover: "/img/seed/dish-plated.jpg",
			Note:  "只有八张桌，得提前一天订。菜是好菜，价格是真的不客气。",
		},
	},
	{
		Slug: "lade-tiao",
		Shop: store.Shop{
			Name: "辣得跳小馆", City: "杭州", District: "滨江",
			Address: "滨江区江南大道 1188 号", Cuisine: "川湘菜", AvgPrice: 96,
			Hours: "11:00-22:00",
			Cover: "/img/seed/dish-plated.jpg",
			Note:  "点评里唯一一家我劝你别去的，具体看避雷榜。",
		},
	},
}

// seedReview 一条演示点评：菜 + 判定 + 该挂的店和标签。
type seedReview struct {
	ShopSlug string
	Tastes   []string
	AgoDays  int // 发布于几天前
	Review   store.Review
}

var seedReviews = []seedReview{
	{
		ShopSlug: "laohangbang-mian", Tastes: []string{"xianxian", "guoqi", "bendiren"}, AgoDays: 2,
		Review: store.Review{
			Slug: "xiabao-shanmian", Dish: "虾爆鳝面", Tier: "dingji", Score: 4.8, Spicy: 2, Price: 42,
			Headline: "鳝丝是现爆的，这一口全杭州只剩这家有。",
			Body:     "点了 9 次，8 次都是为了这碗面。鳝丝下锅爆到边缘微卷，油香是滚的，不是回锅的；虾仁给得不算多，但每一只都是当天的脆弹。面本身偏硬一点，泡到第三口刚好。\n\n这碗要等，现爆的东西快不了，去的时候心态放松点。老板炒完一锅才接下一单，队伍不动的时候不是插队，是在等锅。",
			OrderTip: "一定要“拌开再吃”，加一份油渣 5 块，香到隔壁桌会问。想要宽的就在点单时说“宽面”，不说默认细面。",
			Revisit:  9, RankNo: 1, Featured: true,
			Cover:  "/img/seed/dish-noodles.jpg",
			Images: []string{"/img/seed/dish-noodles.jpg", "/img/seed/dish-plated.jpg"},
		},
	},
	{
		ShopSlug: "laohangbang-mian", Tastes: []string{"xianxian", "yirenshi"}, AgoDays: 9,
		Review: store.Review{
			Slug: "zhugan-mian", Dish: "猪肝面", Tier: "hang", Score: 4.5, Spicy: 1, Price: 26,
			Headline: "猪肝嫩到不像猪肝，26 块是这一带最实在的一碗。",
			Body:     "猪肝是滑的，没有一丝粉感，说明火候和上浆都做对了。汤底比虾爆鳝那碗轻，适合早上第一顿。\n\n缺点也说清楚：这碗凉得快，端上来三分钟内动筷子最好吃。",
			OrderTip: "让老板“少汤多面”，汤少了味道更集中；配一小碟辣油，加半勺就够。",
			Revisit:  6, RankNo: 3,
			Cover:  "/img/seed/dish-noodles.jpg",
			Images: []string{"/img/seed/dish-noodles.jpg"},
		},
	},
	{
		ShopSlug: "xiangkou-pianerchuan", Tastes: []string{"xianxian", "guoqi", "bendiren"}, AgoDays: 16,
		Review: store.Review{
			Slug: "pianerchuan", Dish: "片儿川", Tier: "hang", Score: 4.3, Spicy: 1, Price: 22,
			Headline: "雪菜和笋片是当季的，这一碗骗不了杭州人的舌头。",
			Body:     "片儿川的功力全在配料新不新鲜，这家的雪菜是自己腌的，笋片是当天的，汤面上一层淡淡的油花但一点不腻。\n\n环境是真的将就：四张小桌，人多要拼桌。想吃环境别来，想吃味道就来。",
			OrderTip: "加个荷包蛋别划破，最后泡汤里吃蛋黄；冬天点“重汤”，加两块钱值。",
			Revisit:  11, RankNo: 2,
			Cover:  "/img/seed/dish-noodles.jpg",
			Images: []string{"/img/seed/dish-noodles.jpg", "/img/seed/dish-dessert.jpg"},
		},
	},
	{
		ShopSlug: "xihu-sifangcai", Tastes: []string{"tian", "yuemi"}, AgoDays: 23,
		Review: store.Review{
			Slug: "dongporou", Dish: "东坡肉", Tier: "dingji", Score: 4.6, Spicy: 0, Price: 68,
			Headline: "肥的那一半才是主角，入口就化，一点都不腻。",
			Body:     "一块一方，皮、肥、瘦三层分明。筷子夹起来会颤，入口先是甜，然后才是酱油的咸，最后一点黄酒味收尾。\n\n68 一份不便宜，但这是这一桌里我认为唯一值这个价的菜。",
			OrderTip: "要一碟米饭，把汁拌进去；别急着吃配的青菜，先吃原味。",
			Revisit:  3, RankNo: 4,
			Cover:  "/img/seed/dish-plated.jpg",
			Images: []string{"/img/seed/dish-plated.jpg"},
		},
	},
	{
		ShopSlug: "gongchenqiao-youduner", Tastes: []string{"guoqi", "daibao", "dateka"}, AgoDays: 30,
		Review: store.Review{
			Slug: "youduner", Dish: "油墩儿", Tier: "npc", Score: 3.4, Spicy: 0, Price: 6,
			Headline: "外壳够脆，但萝卜丝太湿，咬两口就塌了。",
			Body:     "刚出锅的确实香，油温也对。问题在萝卜丝没挤干水，里面是软的、温的，脆壳和馅儿两个世界。\n\n6 块钱买个路过的小吃不算亏，专门来一趟就算了——旁边那家面馆是正事。",
			OrderTip: "一定要“刚出锅的那一锅”，站着等 3 分钟比拿走凉的强；撒辣椒粉，别撒糖。",
			Revisit:  2,
			Cover:    "/img/seed/dish-dessert.jpg",
			Images:   []string{"/img/seed/dish-dessert.jpg"},
		},
	},
	{
		ShopSlug: "xihu-sifangcai", Tastes: []string{"qingdan", "tian", "yuemi"}, AgoDays: 38,
		Review: store.Review{
			Slug: "longjing-xiaren", Dish: "龙井虾仁", Tier: "renshang", Score: 3.6, Spicy: 0, Price: 88,
			Headline: "虾仁是好的，茶味是想象出来的。",
			Body:     "虾仁个头中等，浆上得薄，这点值得夸。但所谓龙井味基本闻不到，只在最后一点回甘里若有若无。\n\n88 一份，这个价位我期待的是“吃完会想再来”，实际是“吃完没什么可说”。",
			OrderTip: "这道别和重味的菜同点，先吃它，不然完全吃不出茶味。",
			Revisit:  1,
			Cover:    "/img/seed/dish-plated.jpg",
			Images:   []string{"/img/seed/dish-plated.jpg"},
		},
	},
	{
		ShopSlug: "lade-tiao", Tastes: []string{"mala", "suanla"}, AgoDays: 45,
		Review: store.Review{
			Slug: "shuizhuyu", Dish: "水煮鱼", Tier: "la", Score: 1.8, Spicy: 5, Price: 88,
			Headline: "辣是辣在表面的，鱼是腥的，油是陈的。",
			Body:     "端上来一大盆，红油漂亮，但那层油是回锅油的味儿，吃两口嗓子就开始不舒服。鱼肉片得厚，里面没断生，腥味压不住。\n\n这一顿我没吃完就结账走了。88 不贵，但钱是我的，我也心疼。",
			OrderTip: "没有隐藏吃法，只有隐藏后悔。真在这条街上，往前走 200 米有家杭帮面。",
			Revisit:  0,
			Cover:    "/img/seed/dish-plated.jpg",
			Images:   []string{"/img/seed/dish-plated.jpg"},
		},
	},
	{
		ShopSlug: "lade-tiao", Tastes: []string{"mala"}, AgoDays: 52,
		Review: store.Review{
			Slug: "ganguo-niuwa", Dish: "干锅牛蛙", Tier: "la", Score: 2.0, Spicy: 4, Price: 78,
			Headline: "牛蛙是足够多了，可惜全是面糊和盐。",
			Body:     "量给得实在，这是唯一能夸的。裹粉厚，炸得干，肉的水分全没了；调味只有咸和辣，没有香。\n\n同行的朋友吃了两筷子就放下，最后我们打包带走，到家也没再打开。",
			OrderTip: "别点。要点就点微辣，能少几勺辣椒面，至少不糊嘴。",
			Revisit:  0,
			Cover:    "/img/seed/dish-plated.jpg",
			Images:   []string{"/img/seed/dish-plated.jpg"},
		},
	},
}

// 御膳房：辣条妹自己灶台上的复刻菜谱。kind=yushanfang，不挂店（shop_id=0），
// price 记的是单人份成本，revisit 记的是她做过的次数——探店那套"回头次数"的黑话
// 在这边一样用：做过 11 次的菜不用多说，只做过的 1 次就是它不值得你试。
var seedYu = []seedReview{
	{
		Tastes: []string{"mala", "guoqi", "yirenshi"}, AgoDays: 1,
		Review: store.Review{
			Kind: "yushanfang", Slug: "latiao-banmian", Dish: "辣条拌面", Tier: "hang", Score: 4.9, Spicy: 3, Price: 7,
			Headline: "我的名字来源，全网站就这一碗是我亲手做的。",
			Body:     "辣条不是零食，是调料——这是我从小吃到大的结论。粗辣条剪成段，小火在油里煸到边缘起小泡，甜味先出来，香味后出来；下煮硬的细面，一勺面汤，半勺生抽，翻两下就收火。\n\n关键是那一步“煸”：辣条直接拌面是小孩的吃法，煸过才是饭。煸到锅里冒青烟就晚了，宁可小火多等半分钟。",
			OrderTip: "家里没有粗辣条就用卫龙大面筋剪开；怕腻的起锅前淋几滴醋，味道立刻立起来。",
			Revisit: 40, Cover: "/img/seed/dish-noodles.jpg",
			Images: []string{"/img/seed/dish-noodles.jpg"},
		},
	},
	{
		Tastes: []string{"mala", "xianxian", "dateka"}, AgoDays: 4,
		Review: store.Review{
			Kind: "yushanfang", Slug: "zijiaban-dandanmian", Dish: "自家版担担面", Tier: "dingji", Score: 4.7, Spicy: 2, Price: 12,
			Headline: "为了一碗在 Chengdu 吃过的味道，我照着记忆试了十一次。",
			Body:     "肉臊要炒到吐油、粒粒分立，芽菜切碎先干锅焙过；调料碗底是红油、花椒面、一点点糖和半勺醋。最难的其实是面：外面用的是细碱面，家里买不到就用鲜切面，煮到九分立刻捞，拌的过程就是最后的收汁。\n\n第十一次才和记忆里那家对上：差别不在辣，在醋要比你想的多放半勺。",
			OrderTip: "没有芽菜可用碎米芽菜罐头，或干脆不放；花椒面一定现碾，超市那种罐装的差一整档。",
			Revisit: 11, Cover: "/img/seed/dish-noodles.jpg",
			Images: []string{"/img/seed/dish-noodles.jpg", "/img/seed/dish-plated.jpg"},
		},
	},
	{
		Tastes: []string{"qingdan", "shenye", "yirenshi"}, AgoDays: 8,
		Review: store.Review{
			Kind: "yushanfang", Slug: "congyou-banmian", Dish: "葱油拌面", Tier: "hang", Score: 4.5, Spicy: 0, Price: 6,
			Headline: "深夜十点以后最快的安慰，成本六块，等待十分钟。",
			Body:     "小葱切段冷油下锅，小火养着它从生到焦，全程不能大火——葱焦的那一瞬间你要在锅边看着。生抽老抽糖 2:1:半勺调成碗底，葱煸到深金偏黑才关火，热葱油泼进碗底，面拌匀。\n\n这碗没有任何技术含量，唯一的成本是你得站在灶边看着那锅油，别刷手机。",
			OrderTip: "葱油一次多炼点，剩的拌馄饨、拌黄瓜都是降维打击。面用细面，粗面挂不住油。",
			Revisit: 26, Cover: "/img/seed/dish-noodles.jpg",
			Images: []string{"/img/seed/dish-noodles.jpg"},
		},
	},
	{
		Tastes: []string{"tian", "shenye"}, AgoDays: 12,
		Review: store.Review{
			Kind: "yushanfang", Slug: "shouzuobingfen", Dish: "手搓冰粉", Tier: "dingji", Score: 4.8, Spicy: 0, Price: 8,
			Headline: "夏天我在厨房搓断过两根手指头的冰粉，比外面卖的贵，也比外面卖的真。",
			Body:     "冰籽装进纱布袋，在凉白开里搓——水温不能超过 30 度，搓到籽全部脱出、水变得黏手为止。点浆用的是石灰水，一次只能加半勺，边加边搅：加过了发苦，加不够不成冻。\n\n配料随你，但红糖一定要熬出小泡再放凉，直接冲化的红糖水是糖水，不是冰粉。",
			OrderTip: "嫌搓籽麻烦可以买现成冰粉籽粉，但石灰水点浆这步省不得——那是手搓党和工业货的分界线。",
			Revisit: 15, Cover: "/img/seed/dish-dessert.jpg",
			Images: []string{"/img/seed/dish-dessert.jpg"},
		},
	},
	{
		Tastes: []string{"xianxian", "yuemi"}, AgoDays: 17,
		Review: store.Review{
			Kind: "yushanfang", Slug: "fanqie-niunan-bao", Dish: "番茄牛腩煲", Tier: "dingji", Score: 4.6, Spicy: 0, Price: 34,
			Headline: "三个小时的耐心，值回票价，虽然这张票是我自己买的。",
			Body:     "牛腩冷水下锅焯净，番茄分两次下：第一次全程炒成酱，第二次起锅前二十分钟下大块。炒糖色可以省，用一勺番茄膏代替，颜色一样红。加水一定加热的，冷水会让肉瞬间收紧。\n\n砂锅小火两小时半，最后半小时开盖收。酸甜的层次就在那两次番茄的时差里。",
			OrderTip: "一次做两人份起，回锅的第二天更好吃。牛腩换牛肋条更香，就是得再去掉一层肥。",
			Revisit: 8, Cover: "/img/seed/dish-plated.jpg",
			Images: []string{"/img/seed/dish-plated.jpg"},
		},
	},
	{
		Tastes: []string{"guoqi", "yuemi"}, AgoDays: 22,
		Review: store.Review{
			Kind: "yushanfang", Slug: "ganguo-huacai", Dish: "干锅花菜", Tier: "hang", Score: 4.4, Spicy: 2, Price: 11,
			Headline: "在避雷那家干锅店吃过一次，我回家自己复刻，成本 11 块，甩它三条街。",
			Body:     "花菜掰小朵洗净，一定要沥到表面全干，干锅煸到边缘焦黄先盛出——饭店那股焦香是煸出来的，不是炸出来的。五花肉煸出油，干辣椒蒜片花椒下锅，花菜回锅，锅边淋一圈生抽，全程大火不超过 90 秒。",
			OrderTip: "家里灶火小就分批煸，别一锅倒：花菜出水的那一刻，这道菜就废了。",
			Revisit: 9, Cover: "/img/seed/dish-plated.jpg",
			Images: []string{"/img/seed/dish-plated.jpg"},
		},
	},
	{
		Tastes: []string{"tian", "qingdan", "dateka"}, AgoDays: 28,
		Review: store.Review{
			Kind: "yushanfang", Slug: "laocao-xiaotangyuan", Dish: "醪糟小汤圆", Tier: "renshang", Score: 3.6, Spicy: 0, Price: 5,
			Headline: "我复刻不出的唯一一道：奶奶的醪糟。这碗我只给自己打及格。",
			Body:     "糯米泡一夜，蒸透拌酒曲，中间挖个酒窝，冬天捂棉被夏天放阳台，二十天出酒。做的时候别煮开——醪糟一起锅见大泡，酸味就全出来了，离火前放小汤圆和枸杞。\n\n我按步骤做对了每一次，但奶奶的坛子里有我在外面买不到的东西。所以这道我标 6 分：好吃，但你们大概率做不出我想要的那个味。",
			OrderTip: "嫌酿麻烦就买超市醪糟，选酒粒分明、汁不发酸的；煮的时候只加热不煮沸，这条值半颗星。",
			Revisit: 14, Cover: "/img/seed/dish-dessert.jpg",
			Images: []string{"/img/seed/dish-dessert.jpg"},
		},
	},
}

// seedSettings 只覆盖 IP 和站点文案里跟"只做杭州美食"这套内容相关的几项。
// 其余默认值（page_size、track_enabled…）保持 store.DefaultSettings 不动。
var seedSettings = map[string]string{
	"site_title":   "辣条妹的御膳房",
	"site_tagline": "10年吃遍杭州 · 只恰真的",
	"ip_city":      "杭州",
	"ip_quote":     "来杭州 10 年，我只做好一件事——把杭州的美食一家一家吃透。",
	"footer_note":  "辣条妹的御膳房 · 10年老杭州外地人，只做杭州美食",
	"announcement": "新榜：杭州面王换人了，去看排行榜。",
}

// runSeed 灌一次演示数据。库里已经有内容就直接拒绝——seed 是给首次部署用的，
// 误跑一次会把演示数据混进正式站，比报错麻烦得多。
func runSeed(st *store.Store) error {
	before, err := st.Count()
	if err != nil {
		return fmt.Errorf("seed: 读现有数据: %w", err)
	}
	if before.Shops > 0 || before.Reviews > 0 || before.Drafts > 0 || before.Tastes > 0 {
		return fmt.Errorf("seed: 库里已有 %d 家店 / %d 条已发布 / %d 条草稿 / %d 个标签，拒绝重复灌数据（要重来就先删 data/latiaomei.db）",
			before.Shops, before.Reviews, before.Drafts, before.Tastes)
	}

	// 1) 标签
	for _, t := range seedTags {
		tag := store.Taste{Slug: t.Slug, Name: t.Name, Kind: t.Kind, SortNo: t.SortNo}
		if err := st.SaveTaste(&tag); err != nil {
			return fmt.Errorf("seed: 存标签 %s: %w", t.Name, err)
		}
	}

	// 2) 店铺
	shopIDs := make(map[string]int64, len(seedShops))
	for _, s := range seedShops {
		sh := s.Shop
		sh.Slug = s.Slug
		if err := st.SaveShop(&sh); err != nil {
			return fmt.Errorf("seed: 存店铺 %s: %w", sh.Name, err)
		}
		shopIDs[s.Slug] = sh.ID
	}

	// 3) 点评（探店 + 御膳房菜谱一起灌；菜谱不挂店，ShopSlug 留空）
	now := st.Now()
	for _, r := range append(append([]seedReview{}, seedReviews...), seedYu...) {
		var shopID int64
		if r.ShopSlug != "" {
			id, ok := shopIDs[r.ShopSlug]
			if !ok {
				return fmt.Errorf("seed: 点评 %s 指向了不存在的店铺 %s", r.Review.Slug, r.ShopSlug)
			}
			shopID = id
		}
		rv := r.Review
		rv.ShopID = shopID
		rv.Status = "published"
		rv.Wheel = true // 演示数据全部进转盘，跟新库 wheel 默认值一致
		rv.VisitDate = now.AddDate(0, 0, -(r.AgoDays + 1)).Format("2006-01-02")
		rv.PublishedAt = now.AddDate(0, 0, -r.AgoDays).Unix()
		if err := st.SaveReview(&rv, r.Tastes); err != nil {
			return fmt.Errorf("seed: 存点评 %s: %w", r.Review.Slug, err)
		}
	}

	// 4) 站点/IP 文案
	if err := st.SaveSettings(seedSettings); err != nil {
		return fmt.Errorf("seed: 存配置: %w", err)
	}
	st.InvalidateSettingsCache()

	after, err := st.Count()
	if err != nil {
		return fmt.Errorf("seed: 回读计数: %w", err)
	}
	if after.Reviews == 0 {
		return errors.New("seed: 数据没写进去，请检查数据库写权限")
	}
	fmt.Printf("seed 完成：%d 家店 / %d 条点评（探店 %d · 御膳房 %d）/ %d 个标签（夯 %d · 拉 %d）\n",
		after.Shops, after.Reviews, after.Tandian, after.Yushanfang, after.Tastes, after.Hang, after.La)
	return nil
}

// runSeedRecipes 只补御膳房菜谱，按 slug 查重、存在即跳过：
// 给已经上线、过了 seed 拒绝闸的老库一次性补数据用，可重复执行。
func runSeedRecipes(st *store.Store) (int, error) {
	now := st.Now()
	added := 0
	for _, r := range seedYu {
		_, err := st.GetReview(r.Review.Slug)
		if err == nil {
			continue // 已经有了，不覆盖站长改过的内容
		}
		if !errors.Is(err, store.ErrNotFound) {
			return added, fmt.Errorf("seed-recipes: 查 %s: %w", r.Review.Slug, err)
		}
		rv := r.Review
		rv.Status = "published"
		rv.Wheel = true
		rv.VisitDate = now.AddDate(0, 0, -(r.AgoDays + 1)).Format("2006-01-02")
		rv.PublishedAt = now.AddDate(0, 0, -r.AgoDays).Unix()
		if err := st.SaveReview(&rv, r.Tastes); err != nil {
			return added, fmt.Errorf("seed-recipes: 存 %s: %w", r.Review.Slug, err)
		}
		added++
	}
	return added, nil
}
