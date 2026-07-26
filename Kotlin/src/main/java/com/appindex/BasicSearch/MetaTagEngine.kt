package com.appindex.BasicSearch

import com.appindex.model.AppInfo

/**
 * 元标签引擎 — 软件分类 + 模糊匹配字典
 *
 * 核心功能：
 * 1. 对所有已安装软件进行 MECE 分类
 * 2. 每个分类维护一个模糊匹配字典（中英文关键词）
 * 3. 用户输入概括词（如"通讯"、"message"、"消息"）可索引对应分类下的所有应用
 *
 * 这是软件搜索的核心功能之一
 */
object MetaTagEngine {

    /**
     * 轻量中英文小字典
     *
     * 用途：
     * - 作为正式元标签分类之前的辅助识别层
     * - 用更短的英文词根/中文词根做快速联想
     * - 降低只输入半个英文单词或短中文词时的漏召
     */
    private val SMALL_DICTIONARY = mapOf(
        "chat" to listOf("消息", "聊天", "通讯", "contact", "im", "talk"),
        "mail" to listOf("邮件", "邮箱", "信件", "inbox", "send", "attach"),
        "video" to listOf("视频", "短视频", "长视频", "clip", "reel", "movie", "film"),
        "music" to listOf("音乐", "听歌", "song", "audio", "sound", "playlist"),
        "read" to listOf("阅读", "书", "book", "novel", "article"),
        "pay" to listOf("支付", "钱包", "转账", "bank", "money", "wallet"),
        "local" to listOf("本地", "附近", "周边", "生活", "service", "nearby"),
        "translate" to listOf("翻译", "词典", "字典", "dictionary", "language"),
        "scan" to listOf("扫描", "识别", "ocr", "document", "photo"),
        "map" to listOf("地图", "导航", "路线", "travel", "route"),
        "note" to listOf("笔记", "备忘", "memo", "todo", "record"),
        "cloud" to listOf("云盘", "网盘", "存储", "drive", "backup"),
        "search" to listOf("搜索", "浏览器", "网页", "browser", "web")
    )

    /**
     * 元标签分类定义 + 模糊匹配字典
     * 每个分类对应一组中英文概括词
     */
    private val META_FUZZY_DICT = mapOf(
        // ── 通讯社交 ──
        "即时通讯" to listOf("message", "消息", "通知", "聊天", "通讯", "chat", "im", "instant", "messenger", "私信", "发消息", "联系", "通信", "短信", "talk", "conversation"),
        "社交网络" to listOf("social", "社交", "朋友圈", "动态", "分享", "network", "社区", "关注", "粉丝", "互动", "feed", "timeline", "帖子", "话题"),
        "邮件" to listOf("mail", "email", "邮件", "信件", "inbox", "收件箱", "发送", "附件", "smtp", "邮箱", "通信"),
        // ── 内容消费 ──
        "短视频" to listOf("video", "短视频", "刷视频", "tiktok", "reel", "clip", "直播", "小视频", "视频号", "抖音", "快手", "swipe"),
        "长视频" to listOf("movie", "电影", "剧", "追剧", "影视", "streaming", "番剧", "动漫", "视频", "点播", "影院", "film", "show", "series"),
        "音乐" to listOf("music", "音乐", "歌", "播放器", "song", "听歌", "playlist", "歌词", "电台", "audio", "sound", "旋律", "唱片"),
        "阅读" to listOf("read", "阅读", "书", "电子书", "book", "kindle", "小说", "文学", "读书", "书架", "书城", "阅读器"),
        "播客" to listOf("podcast", "播客", "电台", "音频", "听书", "广播", "有声", "fm", "pod", "episode"),
        "新闻资讯" to listOf("news", "新闻", "资讯", "头条", "热点", "时事", "报道", "journal", "press", "媒体", "信息", "快讯"),
        // ── 生活服务 ──
        "电商购物" to listOf("shop", "购物", "买", "商城", "电商", "store", "mall", "订单", "淘宝", "京东", "消费", "下单", "采购", "剁手"),
        "外卖餐饮" to listOf("food", "外卖", "吃", "餐饮", "订餐", "delivery", "饿", "美团", "点餐", "美食", "饭店", "送餐", "takeout"),
        "出行交通" to listOf("travel", "出行", "打车", "地图", "导航", "transport", "taxi", "滴滴", "航班", "机票", "交通", "路线", "导航仪"),
        "本地生活" to listOf("local", "本地", "生活", "服务", "附近", "周边", "同城", "便民"),
        "支付金融" to listOf("pay", "支付", "银行", "理财", "金融", "wallet", "转账", "余额", "信用卡", "贷款", "投资", "money", "finance"),
        "房产家居" to listOf("home", "房产", "租房", "买房", "家居", "装修", "house", "rent", "property", "物业", "智能", "家电"),
        "健康医疗" to listOf("health", "健康", "医疗", "医生", "挂号", "medicine", "运动", "健身", "体检", "药", "医院", "keep"),
        // ── 效率工具 ──
        "办公协作" to listOf("work", "办公", "协作", "会议", "团队", "office", "team", "远程", "协同", "文档", "project", "项目管理"),
        "笔记备忘" to listOf("note", "笔记", "备忘", "记录", "memo", "日记", "摘录", "知识库", "笔记本", "便签", "待办"),
        "日历日程" to listOf("calendar", "日历", "日程", "提醒", "schedule", "计划", "时间", "闹钟", "alarm", "event", "待办"),
        "云存储" to listOf("cloud", "云盘", "网盘", "存储", "drive", "sync", "备份", "空间", "文件", "drop", "上传", "下载"),
        "翻译" to listOf("translate", "翻译", "词典", "字典", "dictionary", "语言", "双语", "口译", "笔译", "词"),
        "扫描识别" to listOf("scan", "扫描", "识别", "ocr", "拍照", "文档", "名片", "提取", "文字识别"),
        // ── 系统设备 ──
        "浏览器" to listOf("browser", "浏览器", "网页", "搜索", "internet", "web", "surf", "网址", "http", "chrome", "上网"),
        "输入法" to listOf("keyboard", "输入法", "打字", "拼音", "手写", "voice", "语音", "输入", "typing", "ime"),
        "安全防护" to listOf("security", "安全", "防护", "密码", "杀毒", "vpn", "隐私", "保护", "antivirus", "加密"),
        "开发工具" to listOf("dev", "开发", "编程", "代码", "code", "git", "terminal", "debug", "ide", "程序", "软件", "工程"),
        "系统管理" to listOf("system", "系统", "设置", "管理", "清理", "优化", "安装", "卸载", "权限", "storage"),
        "游戏" to listOf("game", "游戏", "玩", "电竞", "手游", "steam", "rpg", "moba", "吃鸡", "王者", "开黑", "娱乐")
    )

    /**
     * 应用名 → 分类列表 的映射
     * 通过模糊匹配应用名和包名来分类
     */
    private val APP_CATEGORY_RULES = mapOf(
        // ── 即时通讯 ──
        "微信" to "即时通讯", "QQ" to "即时通讯", "钉钉" to "即时通讯",
        "Telegram" to "即时通讯", "WhatsApp" to "即时通讯", "Messenger" to "即时通讯",
        "Line" to "即时通讯", "飞书" to "即时通讯", "企业微信" to "即时通讯",
        "Signal" to "即时通讯", "Discord" to "即时通讯",
        // ── 社交网络 ──
        "微博" to "社交网络", "小红书" to "社交网络", "Instagram" to "社交网络",
        "Twitter" to "社交网络", "Facebook" to "社交网络", "LinkedIn" to "社交网络",
        "知乎" to "社交网络", "贴吧" to "社交网络", "豆瓣" to "社交网络",
        // ── 邮件 ──
        "Gmail" to "邮件", "Outlook" to "邮件", "QQ邮箱" to "邮件",
        "网易邮箱" to "邮件", "Spark" to "邮件",
        // ── 短视频 ──
        "抖音" to "短视频", "快手" to "短视频", "TikTok" to "短视频",
        // ── 长视频 ──
        "哔哩哔哩" to "长视频", "腾讯视频" to "长视频", "爱奇艺" to "长视频",
        "优酷" to "长视频", "YouTube" to "长视频", "Netflix" to "长视频",
        "芒果TV" to "长视频", "西瓜视频" to "长视频",
        // ── 音乐 ──
        "网易云音乐" to "音乐", "QQ音乐" to "音乐", "酷狗音乐" to "音乐",
        "酷我音乐" to "音乐", "Spotify" to "音乐", "Apple Music" to "音乐",
        // ── 阅读 ──
        "微信读书" to "阅读", "Kindle" to "阅读", "豆瓣阅读" to "阅读",
        "多看阅读" to "阅读", "掌阅" to "阅读",
        // ── 播客 ──
        "小宇宙" to "播客", "喜马拉雅" to "播客", "蜻蜓FM" to "播客",
        "荔枝FM" to "播客",
        // ── 新闻资讯 ──
        "今日头条" to "新闻资讯", "腾讯新闻" to "新闻资讯", "澎湃新闻" to "新闻资讯",
        // ── 电商购物 ──
        "淘宝" to "电商购物", "京东" to "电商购物", "拼多多" to "电商购物",
        "得物" to "电商购物", "闲鱼" to "电商购物", "唯品会" to "电商购物",
        "Amazon" to "电商购物",
        // ── 外卖餐饮 ──
        "美团" to "外卖餐饮", "饿了么" to "外卖餐饮", "大众点评" to "外卖餐饮",
        // ── 出行交通 ──
        "滴滴出行" to "出行交通", "高德地图" to "出行交通", "百度地图" to "出行交通",
        "Google Maps" to "出行交通", "携程" to "出行交通", "飞猪" to "出行交通",
        // ── 支付金融 ──
        "支付宝" to "支付金融", "云闪付" to "支付金融",
        // ── 办公协作 ──
        "WPS" to "办公协作", "Microsoft Teams" to "办公协作", "Slack" to "办公协作",
        "Notion" to "办公协作", "腾讯文档" to "办公协作", "石墨文档" to "办公协作",
        // ── 笔记备忘 ──
        "印象笔记" to "笔记备忘", "有道云笔记" to "笔记备忘", "备忘录" to "笔记备忘",
        "Bear" to "笔记备忘", "Obsidian" to "笔记备忘",
        // ── 云存储 ──
        "百度网盘" to "云存储", "阿里云盘" to "云存储", "iCloud" to "云存储",
        "Google Drive" to "云存储", "OneDrive" to "云存储", "Dropbox" to "云存储",
        // ── 翻译 ──
        "Google翻译" to "翻译", "百度翻译" to "翻译", "有道词典" to "翻译", "DeepL" to "翻译",
        // ── 浏览器 ──
        "夸克" to "浏览器", "Chrome" to "浏览器", "Safari" to "浏览器",
        "Firefox" to "浏览器", "Edge" to "浏览器", "Opera" to "浏览器", "Via" to "浏览器",
        // ── 输入法 ──
        "搜狗输入法" to "输入法", "百度输入法" to "输入法", "Gboard" to "输入法",
        "SwiftKey" to "输入法",
        // ── 开发工具 ──
        "VS Code" to "开发工具", "Terminal" to "开发工具", "Git" to "开发工具",
        "Postman" to "开发工具", "Figma" to "开发工具",
        // ── 系统管理 ──
        "设置" to "系统管理", "文件管理" to "系统管理", "App Store" to "系统管理",
        // ── 游戏 ──
        "王者荣耀" to "游戏", "和平精英" to "游戏", "原神" to "游戏",
        "崩坏星穹铁道" to "游戏", "Steam" to "游戏", "Epic" to "游戏",
        // ── 智能家居 ──
        "米家" to "房产家居", "HomeKit" to "房产家居",
        // ── 健康 ──
        "Keep" to "健康医疗", "平安好医生" to "健康医疗",
        // ── 物流 ──
        "菜鸟" to "本地生活",
        // ── 书影音 ──
        "豆瓣" to "社交网络"
    )

    /**
     * 包名关键词 → 分类 的映射（用于模糊匹配未在名称规则中的app）
     */
    private val PACKAGE_CATEGORY_HINTS = mapOf(
        "tencent.mm" to "即时通讯", "tencent.mobileqq" to "即时通讯",
        "alibaba.android.rimet" to "办公协作", "feishu" to "办公协作",
        "ss.android.ugc.aweme" to "短视频", "smile.gifmaker" to "短视频",
        "taobao" to "电商购物", "jingdong" to "电商购物",
        "sankuai.meituan" to "外卖餐饮", "ele" to "外卖餐饮",
        "eg.android.AlipayGphone" to "支付金融",
        "netease.cloudmusic" to "音乐", "tencent.qqmusic" to "音乐",
        "danmaku.bili" to "长视频", "tencent.qqlive" to "长视频",
        "qiyi.video" to "长视频",
        "xingin.xhs" to "社交网络", "sina.weibo" to "社交网络",
        "zhihu.android" to "社交网络",
        "baidu.searchbox" to "浏览器", "quark.browser" to "浏览器",
        "autonavi.minimap" to "出行交通", "sdu.didi" to "出行交通",
        "wps.moffice" to "办公协作",
        "coolapk.market" to "社交网络",
        "douban.frodo" to "社交网络",
        "xiaomi.smarthome" to "房产家居",
        "cainiao" to "本地生活",
        "taobao.trip" to "出行交通",
        "xunmeng.pinduoduo" to "电商购物",
        "shizhuang.duapp" to "电商购物",
        "taobao.idlefish" to "电商购物",
        "ss.android.article.news" to "新闻资讯"
    )

    /** 关键词 → 分类列表 反向索引 */
    private val keywordToCategories = mutableMapOf<String, MutableList<String>>()

    /** 应用名 → 分类列表 映射（运行时构建） */
    private val appCategories = mutableMapOf<String, MutableList<String>>()

    /** 是否已初始化 */
    private var initialized = false

    init {
        buildKeywordIndex()
    }

    /**
     * 构建关键词反向索引
     */
    private fun buildKeywordIndex() {
        keywordToCategories.clear()
        for ((category, keywords) in META_FUZZY_DICT) {
            for (kw in keywords) {
                val kl = kw.lowercase()
                keywordToCategories.getOrPut(kl) { mutableListOf() }.apply {
                    if (!contains(category)) add(category)
                }
            }
        }
        for ((root, words) in SMALL_DICTIONARY) {
            for (w in words) {
                val wl = w.lowercase()
                keywordToCategories.getOrPut(wl) { mutableListOf() }.apply {
                    if (!contains(inferCategoryFromRoot(root))) add(inferCategoryFromRoot(root))
                }
            }
        }
    }

    /**
     * 为应用列表构建分类映射
     */
    fun buildAppCategories(apps: List<AppInfo>) {
        appCategories.clear()
        for (app in apps) {
            val categories = classifyApp(app)
            if (categories.isNotEmpty()) {
                appCategories[app.label] = categories.toMutableList()
            }
        }
        initialized = true
    }

    /**
     * 对单个应用进行分类
     */
    fun classifyApp(app: AppInfo): List<String> {
        val categories = mutableSetOf<String>()

        // 1. 通过应用名精确匹配
        APP_CATEGORY_RULES[app.label]?.let { categories.add(it) }

        // 2. 通过包名模糊匹配
        for ((pkgHint, cat) in PACKAGE_CATEGORY_HINTS) {
            if (app.packageName.contains(pkgHint, ignoreCase = true)) {
                categories.add(cat)
            }
        }

        // 3. 通过应用名中的关键词匹配分类
        val labelLower = app.label.lowercase()
        for ((category, keywords) in META_FUZZY_DICT) {
            for (kw in keywords) {
                if (kw.length >= 2 && labelLower.contains(kw.lowercase())) {
                    categories.add(category)
                    break
                }
            }
        }

        return categories.toList()
    }

    /**
     * 获取应用所属的分类
     */
    fun getCategoriesForApp(appLabel: String): List<String> {
        return appCategories[appLabel] ?: emptyList()
    }

    /**
     * 模糊匹配：输入查询，返回匹配的分类及其分数
     *
     * 支持的匹配方式：
     * 1. 精确匹配关键词
     * 2. 前缀匹配关键词
     * 3. 包含匹配关键词
     * 4. 分类名本身匹配
     * 5. 拼音首字母匹配分类名
     */
    fun matchMetaCategory(query: String): List<CategoryMatch> {
        val ql = query.trim().lowercase()
        if (ql.isEmpty()) return emptyList()

        val results = mutableListOf<CategoryMatch>()

        // 1. 精确匹配关键词
        keywordToCategories[ql]?.forEach { cat ->
            results.add(CategoryMatch(cat, 100, "exact_keyword"))
        }

        // 1.5 轻量词根字典辅助匹配：适合中英文短词、半截输入、近义缩写
        for ((root, words) in SMALL_DICTIONARY) {
            val category = inferCategoryFromRoot(root)
            for (word in words) {
                val wl = word.lowercase()
                when {
                    wl == ql -> {
                        val existing = results.find { it.category == category }
                        if (existing != null) existing.score = maxOf(existing.score, 94)
                        else results.add(CategoryMatch(category, 94, "small_dict_exact"))
                    }
                    wl.startsWith(ql) || ql.startsWith(wl) -> {
                        val existing = results.find { it.category == category }
                        if (existing != null) existing.score = maxOf(existing.score, 82)
                        else results.add(CategoryMatch(category, 82, "small_dict_prefix"))
                    }
                    wl.contains(ql) || ql.contains(wl) -> {
                        val existing = results.find { it.category == category }
                        if (existing != null) existing.score = maxOf(existing.score, 66)
                        else results.add(CategoryMatch(category, 66, "small_dict_contains"))
                    }
                }
            }
        }

        // 2. 前缀/包含匹配关键词
        for ((kw, cats) in keywordToCategories) {
            when {
                kw.startsWith(ql) && kw != ql -> {
                    for (cat in cats) {
                        val existing = results.find { it.category == cat }
                        if (existing != null) existing.score = maxOf(existing.score, 90)
                        else results.add(CategoryMatch(cat, 90, "prefix_keyword"))
                    }
                }
                kw.contains(ql) && !kw.startsWith(ql) -> {
                    for (cat in cats) {
                        val existing = results.find { it.category == cat }
                        if (existing != null) existing.score = maxOf(existing.score, 70)
                        else results.add(CategoryMatch(cat, 70, "contains_keyword"))
                    }
                }
            }
        }

        // 3. 分类名本身匹配
        for (cat in META_FUZZY_DICT.keys) {
            when {
                cat == ql -> {
                    val existing = results.find { it.category == cat }
                    if (existing != null) existing.score = maxOf(existing.score, 95)
                    else results.add(CategoryMatch(cat, 95, "exact_category"))
                }
                cat.contains(ql) -> {
                    val existing = results.find { it.category == cat }
                    if (existing != null) existing.score = maxOf(existing.score, 75)
                    else results.add(CategoryMatch(cat, 75, "contains_category"))
                }
            }
        }

        // 4. 拼音首字母匹配分类名
        for (cat in META_FUZZY_DICT.keys) {
            val catPinyin = PinyinConverter.toInitials(cat).lowercase()
            when {
                catPinyin == ql -> {
                    val existing = results.find { it.category == cat }
                    if (existing != null) existing.score = maxOf(existing.score, 85)
                    else results.add(CategoryMatch(cat, 85, "pinyin_abbr_category"))
                }
                catPinyin.startsWith(ql) -> {
                    val existing = results.find { it.category == cat }
                    if (existing != null) existing.score = maxOf(existing.score, 80)
                    else results.add(CategoryMatch(cat, 80, "pinyin_prefix_category"))
                }
            }
        }

        // 去重并排序
        return results.distinctBy { it.category }.sortedByDescending { it.score }
    }

    private fun inferCategoryFromRoot(root: String): String {
        return when (root) {
            "chat" -> "即时通讯"
            "mail" -> "邮件"
            "video" -> "长视频"
            "music" -> "音乐"
            "read" -> "阅读"
            "pay" -> "支付金融"
            "local" -> "本地生活"
            "translate" -> "翻译"
            "scan" -> "扫描识别"
            "map" -> "出行交通"
            "note" -> "笔记备忘"
            "cloud" -> "云存储"
            "search" -> "浏览器"
            else -> root
        }
    }

    /**
     * 搜索匹配分类下的所有应用
     * @return 匹配的应用列表及其分数
     */
    fun searchByCategory(query: String, apps: List<AppInfo>): List<Pair<AppInfo, Int>> {
        val matchedCategories = matchMetaCategory(query)
        if (matchedCategories.isEmpty()) return emptyList()

        val result = mutableListOf<Pair<AppInfo, Int>>()
        for (app in apps) {
            val appCats = appCategories[app.label] ?: continue
            for (mc in matchedCategories) {
                if (appCats.contains(mc.category)) {
                    result.add(app to mc.score)
                    break
                }
            }
        }
        return result
    }

    /**
     * 分类匹配结果
     */
    data class CategoryMatch(
        val category: String,
        var score: Int,
        val matchType: String
    )
}
