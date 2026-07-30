package com.appindex.BasicSearch

import com.appindex.model.AppInfo
import com.appindex.model.MatchType
import com.appindex.model.SearchResult

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                    元标签树 Meta Tag Tree — 软件核心特色                         ║
 * ║                                                                              ║
 * ║  核心思想：                                                                     ║
 * ║    与传统精确索引（首字母 / 拼音 / 字符序列）不同，元标签树是                    ║
 * ║    「按标签聚类的语义索引」。它把"含义相近但写法不同"的查询词                    ║
 * ║    绑定到同一个分类，再把分类下所有 App 一次性召回。                            ║
 * ║                                                                              ║
 * ║  三个核心步骤：                                                                 ║
 * ║    ① 预分类 — 安装时按 MECE 规则把所有 App 归到分类（邮件/社交/视频/...）        ║
 * ║    ② 语义匹配 — 用户输入"邮箱 / email / mail"等同义簇时，                      ║
 * ║                 全部命中「邮件」分类，触发元标签树                              ║
 * ║    ③ 优先级召回 — 分类内 App 按「分类优先级 + 同义强度 + 使用频率」加权排序    ║
 * ║                                                                              ║
 * ║  举例：                                                                        ║
 * ║    输入 "邮箱"  → 命中「邮件」分类 → 返回 Gmail / Outlook / QQ邮箱 / 网易邮箱  ║
 * ║    输入 "email" → 同上                                                          ║
 * ║    输入 "mail"  → 同上                                                          ║
 * ║    输入 "inbox" → 同上                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
class MetaTagIndex {

    // ─── 同义词簇（语义扩展层）──────────────────────────────────────────
    //    同簇内的任意词都能触发同一个分类
    //    Synonym clusters: any word inside one cluster triggers the same category
    private val SYNONYM_CLUSTERS: List<SynonymCluster> = listOf(
        SynonymCluster("邮件", "邮件", "邮箱", "mail", "email", "inbox", "信件", "收件箱", "smtp", "gmail", "outlook", "网易邮箱", "QQ邮箱", "发邮件", "收邮件"),
        SynonymCluster("即时通讯", "即时通讯", "消息", "通讯", "聊天", "chat", "im", "instant", "messenger", "私信", "发消息", "短信", "talk", "conversation", "微信", "QQ", "钉钉"),
        SynonymCluster("社交网络", "社交网络", "social", "社交", "朋友圈", "动态", "分享", "network", "社区", "关注", "粉丝", "互动", "feed", "timeline", "帖子", "话题", "微博", "小红书", "知乎", "豆瓣"),
        SynonymCluster("短视频", "短视频", "video", "刷视频", "tiktok", "reel", "clip", "小视频", "视频号", "抖音", "快手", "swipe", "直播"),
        SynonymCluster("长视频", "长视频", "movie", "电影", "剧", "追剧", "影视", "streaming", "番剧", "动漫", "视频", "点播", "影院", "film", "show", "series", "B站", "b站", "哔哩", "爱奇艺", "优酷"),
        SynonymCluster("音乐", "音乐", "music", "歌", "播放器", "song", "听歌", "playlist", "歌词", "电台", "audio", "sound", "旋律", "唱片", "QQ音乐", "网易云", "酷狗", "Spotify"),
        SynonymCluster("阅读", "阅读", "read", "书", "电子书", "book", "kindle", "小说", "文学", "读书", "书架", "书城", "阅读器", "读书"),
        SynonymCluster("播客", "播客", "podcast", "电台", "音频", "听书", "广播", "有声", "fm", "pod", "episode", "小宇宙", "喜马拉雅", "蜻蜓"),
        SynonymCluster("新闻资讯", "新闻资讯", "news", "新闻", "资讯", "头条", "热点", "时事", "报道", "journal", "press", "媒体", "信息", "快讯", "今日头条"),
        SynonymCluster("电商购物", "电商购物", "shop", "购物", "买", "商城", "电商", "store", "mall", "订单", "淘宝", "京东", "消费", "下单", "采购", "剁手", "拼多多", "闲鱼"),
        SynonymCluster("外卖餐饮", "外卖餐饮", "food", "外卖", "吃", "餐饮", "订餐", "delivery", "饿", "美团", "点餐", "美食", "饭店", "送餐", "takeout", "饿了么"),
        SynonymCluster("出行交通", "出行交通", "travel", "出行", "打车", "地图", "导航", "transport", "taxi", "滴滴", "航班", "机票", "交通", "路线", "导航仪", "高德", "百度地图"),
        SynonymCluster("本地生活", "本地生活", "local", "本地", "生活", "服务", "附近", "周边", "同城", "便民"),
        SynonymCluster("支付金融", "支付金融", "pay", "支付", "银行", "理财", "金融", "wallet", "转账", "余额", "信用卡", "贷款", "投资", "money", "finance", "支付宝", "云闪付"),
        SynonymCluster("房产家居", "房产家居", "home", "房产", "租房", "买房", "家居", "装修", "house", "rent", "property", "物业", "智能", "家电", "米家"),
        SynonymCluster("健康医疗", "健康医疗", "health", "健康", "医疗", "医生", "挂号", "medicine", "运动", "健身", "体检", "药", "医院", "keep"),
        SynonymCluster("办公协作", "办公协作", "work", "办公", "协作", "会议", "团队", "office", "team", "远程", "协同", "文档", "project", "项目管理", "WPS", "飞书", "腾讯会议", "钉钉"),
        SynonymCluster("笔记备忘", "笔记备忘", "note", "笔记", "备忘", "记录", "memo", "日记", "摘录", "知识库", "笔记本", "便签", "待办"),
        SynonymCluster("日历日程", "日历日程", "calendar", "日历", "日程", "提醒", "schedule", "计划", "时间", "闹钟", "alarm", "event", "待办"),
        SynonymCluster("云存储", "云存储", "cloud", "云盘", "网盘", "存储", "drive", "sync", "备份", "空间", "文件", "drop", "上传", "下载", "百度网盘", "阿里云盘"),
        SynonymCluster("翻译", "翻译", "translate", "词典", "字典", "dictionary", "语言", "双语", "口译", "笔译", "词"),
        SynonymCluster("扫描识别", "扫描识别", "scan", "扫描", "识别", "ocr", "拍照", "文档", "名片", "提取", "文字识别"),
        SynonymCluster("浏览器", "浏览器", "browser", "网页", "搜索", "internet", "web", "surf", "网址", "http", "chrome", "上网", "夸克"),
        SynonymCluster("输入法", "输入法", "keyboard", "打字", "拼音", "手写", "voice", "语音", "输入", "typing", "ime", "搜狗", "Gboard"),
        SynonymCluster("安全防护", "安全防护", "security", "安全", "防护", "密码", "杀毒", "vpn", "隐私", "保护", "antivirus", "加密"),
        SynonymCluster("开发工具", "开发工具", "dev", "开发", "编程", "代码", "code", "git", "terminal", "debug", "ide", "程序", "软件", "工程", "vscode", "androidstudio"),
        SynonymCluster("系统管理", "系统管理", "system", "系统", "设置", "管理", "清理", "优化", "安装", "卸载", "权限", "storage"),
        SynonymCluster("游戏", "游戏", "game", "玩", "电竞", "手游", "steam", "rpg", "moba", "吃鸡", "王者", "开黑", "娱乐", "王者荣耀", "原神", "和平精英")
    )

    // 词 → 簇映射（O(1) 查找）
    private val wordToCluster: Map<String, SynonymCluster> = run {
        val m = HashMap<String, SynonymCluster>()
        for (cluster in SYNONYM_CLUSTERS) {
            for (w in cluster.words) {
                m.putIfAbsent(w.lowercase(), cluster)
            }
        }
        m
    }

    // 分类 → App 集合（标签聚类索引：核心数据结构）
    private val categoryToApps: MutableMap<String, MutableList<AppInfo>> = HashMap()
    private val categoryToAppCount: MutableMap<String, Int> = HashMap()

    // 分类名（用于按分类名本身匹配）
    private val categoryNames: Set<String> get() = SYNONYM_CLUSTERS.map { it.canonical }.toSet()

    // 标签簇优先级（数值越大优先级越高）
    private val categoryPriority: Map<String, Int> = mapOf(
        "邮件" to 95, "即时通讯" to 90, "社交网络" to 88, "短视频" to 85,
        "长视频" to 80, "音乐" to 78, "阅读" to 72, "播客" to 60,
        "新闻资讯" to 75, "电商购物" to 92, "外卖餐饮" to 82, "出行交通" to 86,
        "本地生活" to 65, "支付金融" to 96, "房产家居" to 55, "健康医疗" to 58,
        "办公协作" to 70, "笔记备忘" to 60, "日历日程" to 55, "云存储" to 65,
        "翻译" to 50, "扫描识别" to 45, "浏览器" to 70, "输入法" to 50,
        "安全防护" to 55, "开发工具" to 50, "系统管理" to 50, "游戏" to 75
    )

    // 同义强度（在簇内识别到完全一致词时使用）
    private val STRENGTH_EXACT = 100          // 完全相等的同义词
    private val STRENGTH_PREFIX = 80          // 同义词前缀
    private val STRENGTH_CONTAINS = 65        // 同义词包含
    private val STRENGTH_CATEGORY_NAME = 95   // 分类名直接匹配
    private val STRENGTH_PINYIN_INITIAL = 50 // 拼音首字母匹配分类

    // LRU 缓存
    private val searchCache: LinkedHashMap<String, List<MetaTagResult>> = LinkedHashMap(64, 0.75f, true)
    private val maxCacheSize = 32

    /**
     * 构建标签聚类索引（应用列表变化时调用）
     * Build the tag-clustered index. Call this whenever the app list changes.
     *
     * @param apps 当前设备已安装的所有应用
     * @param engine 共享的 [MetaTagEngine]（提供 MECE 分类规则）
     */
    fun build(apps: List<AppInfo>, engine: MetaTagEngine) {
        categoryToApps.clear()
        categoryToAppCount.clear()

        // 第一步：给所有 app 分类（用 MetaTagEngine.classifyApp）
        engine.buildAppCategories(apps)
        for (app in apps) {
            val cats = engine.classifyApp(app)
            for (cat in cats) {
                // 命中「簇」的规范名
                val canonical = clusterOf(cat) ?: cat
                categoryToApps.getOrPut(canonical) { mutableListOf() }.add(app)
            }
        }
        for ((cat, list) in categoryToApps) {
            categoryToAppCount[cat] = list.size
        }
        searchCache.clear()
    }

    private fun clusterOf(category: String): String? {
        // category 是「即时通讯」等中文 → 在 SYNONYM_CLUSTERS 中找对应规范名
        val lc = category.lowercase()
        val direct = wordToCluster[lc] ?: wordToCluster[category] ?: return null
        return direct.canonical
    }

    // ─── 公共 API ───────────────────────────────────────────────────

    /**
     * 元标签树搜索
     * @param query 用户输入
     * @param limit 返回数量上限
     * @return 元标签搜索结果（含分类、同义强度、匹配分）
     */
    fun search(query: String, limit: Int = 30): List<MetaTagResult> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()

        synchronized(searchCache) { searchCache[q] }?.let { return it }

        // ① 第一步：在同义词簇中精确/前缀/包含匹配（语义扩展的核心）
        val matchedCategories = matchCategories(q)
        if (matchedCategories.isEmpty()) {
            synchronized(searchCache) {
                searchCache[q] = emptyList()
                if (searchCache.size > maxCacheSize) searchCache.remove(searchCache.keys.first())
            }
            return emptyList()
        }

        // ② 第二步：召回所有命中分类下的 App
        val results = mutableListOf<MetaTagResult>()
        val seen = HashSet<String>()
        for (cm in matchedCategories) {
            val apps = categoryToApps[cm.category] ?: continue
            for (app in apps) {
                if (seen.add(app.packageName)) {
                    results.add(
                        MetaTagResult(
                            app = app,
                            category = cm.category,
                            matchedTag = cm.matchedWord,
                            strength = cm.strength,
                            priority = categoryPriority[cm.category] ?: 50,
                            score = computeFinalScore(cm.strength, categoryPriority[cm.category] ?: 50),
                            matchType = MatchType.META_TAG
                        )
                    )
                }
            }
        }

        // ③ 第三步：按「强度 + 优先级」降序；同分按应用名稳定排序
        val sorted = results.sortedWith(
            compareByDescending<MetaTagResult> { it.score }
                .thenBy { it.app.label }
        )
        val final = if (sorted.size > limit) sorted.subList(0, limit) else sorted

        synchronized(searchCache) {
            searchCache[q] = final
            if (searchCache.size > maxCacheSize) searchCache.remove(searchCache.keys.first())
        }
        return final
    }

    /**
     * 把元标签结果转成标准 [SearchResult]
     */
    fun searchAsSearchResults(query: String, limit: Int = 30): List<SearchResult> {
        return search(query, limit).map { tr ->
            SearchResult(
                appInfo = tr.app,
                score = tr.score,
                matchType = MatchType.META_TAG
            )
        }
    }

    /**
     * 匹配查询对应的分类（按强度排序）
     */
    fun matchCategories(query: String): List<CategoryMatch> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return emptyList()

        val out = LinkedHashMap<String, CategoryMatch>()

        // 1. 在同义词簇内匹配（最核心的语义层）
        for ((word, cluster) in wordToCluster) {
            when {
                word == q -> {
                    addOrUpdate(out, cluster.canonical, q, STRENGTH_EXACT)
                }
                word.startsWith(q) -> {
                    addOrUpdate(out, cluster.canonical, q, STRENGTH_PREFIX)
                }
                word.contains(q) && q.length >= 2 -> {
                    addOrUpdate(out, cluster.canonical, q, STRENGTH_CONTAINS)
                }
            }
        }

        // 2. 分类名直接匹配
        for (cluster in SYNONYM_CLUSTERS) {
            val cn = cluster.canonical.lowercase()
            when {
                cn == q -> {
                    addOrUpdate(out, cluster.canonical, cluster.canonical, STRENGTH_CATEGORY_NAME)
                }
                cn.contains(q) && q.length >= 2 -> {
                    addOrUpdate(out, cluster.canonical, cluster.canonical, STRENGTH_CATEGORY_NAME - 5)
                }
            }
        }

        // 3. 拼音首字母匹配分类名（如 "yx" → 邮件 / yinyue → 音乐）
        if (q.length in 2..8 && q.all { it.isLetter() }) {
            for (cluster in SYNONYM_CLUSTERS) {
                val initials = PinyinConverter.toInitials(cluster.canonical).lowercase()
                if (initials == q) {
                    addOrUpdate(out, cluster.canonical, cluster.canonical, STRENGTH_PINYIN_INITIAL + 20)
                } else if (initials.startsWith(q)) {
                    addOrUpdate(out, cluster.canonical, cluster.canonical, STRENGTH_PINYIN_INITIAL + 10)
                }
            }
        }

        return out.values.sortedByDescending { it.strength }
    }

    private fun addOrUpdate(map: LinkedHashMap<String, CategoryMatch>, cat: String, word: String, strength: Int) {
        val existing = map[cat]
        if (existing == null) {
            map[cat] = CategoryMatch(cat, strength, word)
        } else if (strength > existing.strength) {
            existing.strength = strength
            existing.matchedWord = word
        }
    }

    private fun computeFinalScore(strength: Int, priority: Int): Int {
        // 最终分 = 强度 * 0.6 + 分类优先级 * 0.4 + 100 偏移，让分数在常规搜索之上
        return 100 + (strength * 0.6).toInt() + (priority * 0.4).toInt()
    }

    /**
     * 是否为分类查询（用于 UI 提示）
     */
    fun isCategoryQuery(query: String): Boolean {
        if (query.isBlank()) return false
        val ql = query.trim().lowercase()
        // 1) 同义词簇内
        if (wordToCluster.containsKey(ql)) return true
        // 2) 是分类名
        if (categoryNames.any { it.equals(ql, ignoreCase = true) }) return true
        // 3) 同义词前缀
        if (wordToCluster.keys.any { it.startsWith(ql) && ql.length >= 2 }) return true
        return false
    }

    /**
     * 获取分类下所有 App（UI 展示用）
     */
    fun getAppsByCategory(category: String): List<AppInfo> {
        val canonical = clusterOf(category) ?: category
        return categoryToApps[canonical] ?: emptyList()
    }

    /**
     * 获取分类列表（按优先级降序）
     */
    fun listCategories(): List<CategoryInfo> {
        return categoryToApps.keys.map { cat ->
            CategoryInfo(
                canonical = cat,
                appCount = categoryToAppCount[cat] ?: 0,
                priority = categoryPriority[cat] ?: 50
            )
        }.sortedWith(compareByDescending<CategoryInfo> { it.priority }.thenByDescending { it.appCount })
    }

    /**
     * 清除缓存
     */
    fun clearCache() {
        synchronized(searchCache) { searchCache.clear() }
    }

    // ─── 数据类 ───────────────────────────────────────────────────

    /**
     * 同义词簇（一组可互换触发的语义相关词）
     */
    private class SynonymCluster(
        val canonical: String,
        vararg val words: String
    )

    /**
     * 元标签搜索结果
     */
    data class MetaTagResult(
        val app: AppInfo,
        val category: String,
        val matchedTag: String,
        val strength: Int,
        val priority: Int,
        val score: Int,
        val matchType: MatchType
    )

    /**
     * 分类匹配（中间结果）
     */
    data class CategoryMatch(
        val category: String,
        var strength: Int,
        var matchedWord: String
    )

    /**
     * 分类信息（UI 展示用）
     */
    data class CategoryInfo(
        val canonical: String,
        val appCount: Int,
        val priority: Int
    )
}
