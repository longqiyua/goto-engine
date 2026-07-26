package com.appindex.Personalization

/**
 * 键盘输入布局 / Keyboard Input Layout
 *
 * QWERTY_26: 26 键标准 QWERTY 键盘 — 邻位误触基于 QWERTY 物理布局
 *            Standard 26-key QWERTY keyboard — mistap tolerance based on physical layout.
 *            适用：全键盘、九宫格之外的多数输入法
 *            For: full keyboard and most IMEs other than 9-key.
 *
 * T9_9:      9 键 T9 / 九宫格键盘 — 邻位误触基于电话九键布局
 *            9-key T9 / phone keypad — mistap tolerance based on telephone keypad.
 *            适用：九宫格输入法（搜狗九宫 / 百度九宫 / iOS 九宫 等）
 *            For: 9-key IMEs (Sogou 9-key / Baidu 9-key / iOS 9-key, etc.)
 *            在此模式下，用户输入可能是数字（943 → 微信），
 *            引擎会自动把应用名转成 T9 数字序列再匹配。
 *            In this mode, user input may be digits (943 → weixin), and the engine
 *            will automatically convert app names to T9 digit sequences for matching.
 */
enum class KeyboardLayout(val key: String) {
    QWERTY_26("qwerty_26"),
    T9_9("t9_9");

    companion object {
        /** 从持久化字符串还原 / Restore from persisted string. */
        fun fromKey(key: String?): KeyboardLayout =
            values().firstOrNull { it.key == key } ?: QWERTY_26

        /**
         * 26 键默认顺序 / Default ordering for 26-key.
         * The order determines which keyboard layout is the first suggestion
         * when the user's app language matches the given BCP-47 language tag.
         */
        fun defaultForLanguage(appLanguage: String): KeyboardLayout = when {
            // 中文 / 中文 + 英文 / 繁体中文 → 26 键优先
            appLanguage.startsWith("zh") -> QWERTY_26
            // 其它语言默认也是 26 键
            else -> QWERTY_26
        }
    }
}

/**
 * 输入语言检测结果 / Detected Input Language
 *
 * 用于根据用户输入自动路由到最合适的索引树：
 * Used to route the user's input to the most appropriate index tree:
 *
 * ENGLISH:     纯英文 → 走英文索引树（label 中的英文部分 + 英文包名）
 *              Pure English → use the English index tree
 *
 * CHINESE:     包含汉字 / 纯拼音 / 纯首字母 → 走中文 + 拼音索引树
 *              Contains CJK / pure pinyin / pure initials → use CJK + pinyin index
 *
 * NUMERIC_T9:  纯数字（且启用 T9 模式时）→ 走 T9 索引树
 *              Pure digits (when T9 is enabled) → use T9 index tree
 *
 * MIXED:       混合（英文 + 数字 / 中英混合）→ 多树并行
 *              Mixed (EN + digits / CJK + EN) → multi-tree parallel
 */
enum class InputLanguage {
    ENGLISH,
    CHINESE,
    NUMERIC_T9,
    MIXED;

    companion object {
        /**
         * 检测输入语言 / Detect input language.
         * @param query 用户输入 / user input (already lowercased)
         * @param t9Enabled 是否启用 T9 模式 / whether T9 mode is enabled
         */
        fun detect(query: String, t9Enabled: Boolean): InputLanguage {
            if (query.isEmpty()) return CHINESE
            var hasLetter = false
            var hasDigit = false
            var hasCjk = false
            for (character in query) {
                when {
                    character in 'a'..'z' -> hasLetter = true
                    character in '0'..'9' -> hasDigit = true
                    character.code in 0x4E00..0x9FFF -> hasCjk = true
                }
            }
            return when {
                hasDigit && !hasLetter && !hasCjk && t9Enabled -> NUMERIC_T9
                hasDigit && !hasLetter && !hasCjk && !t9Enabled -> ENGLISH
                hasCjk -> if (hasLetter || hasDigit) MIXED else CHINESE
                hasLetter && !hasDigit -> ENGLISH
                hasLetter && hasDigit -> MIXED
                else -> CHINESE
            }
        }
    }
}
