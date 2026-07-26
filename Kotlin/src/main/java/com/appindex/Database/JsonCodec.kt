package com.appindex.Database

import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON 工具
 *
 * 由于索引数据中有大量 List/Set/Map 字段，表中以 JSON 字符串存储。
 * 提供 List、Set、Map 与 JSON 字符串之间的安全转换。
 */
object JsonCodec {

    /* ─────── List<String> ─────── */

    fun listToJson(list: List<String>?): String {
        if (list.isNullOrEmpty()) return "[]"
        val arr = JSONArray()
        list.forEach { arr.put(it) }
        return arr.toString()
    }

    fun jsonToList(json: String?): List<String> {
        if (json.isNullOrBlank() || json == "[]") return emptyList()
        return try {
            val arr = JSONArray(json)
            val list = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) {
                list.add(arr.optString(i))
            }
            list
        } catch (e: Exception) {
            emptyList()
        }
    }

    /* ─────── Set<Char>（存储为 List<String>，每个元素为字符字符串） ─────── */

    fun charSetToJson(set: Set<Char>?): String {
        if (set.isNullOrEmpty()) return "[]"
        val arr = JSONArray()
        set.forEach { arr.put(it.toString()) }
        return arr.toString()
    }

    fun jsonToCharSet(json: String?): Set<Char> {
        if (json.isNullOrBlank() || json == "[]") return emptySet()
        return try {
            val arr = JSONArray(json)
            val set = HashSet<Char>(arr.length())
            for (i in 0 until arr.length()) {
                val s = arr.optString(i)
                if (s.isNotEmpty()) set.add(s[0])
            }
            set
        } catch (e: Exception) {
            emptySet()
        }
    }

    /* ─────── Map<String, Int>（关键词点击映射） ─────── */

    fun mapToJson(map: Map<String, Int>?): String {
        if (map.isNullOrEmpty()) return "{}"
        val obj = JSONObject()
        map.forEach { (k, v) -> obj.put(k, v) }
        return obj.toString()
    }

    fun jsonToMap(json: String?): Map<String, Int> {
        if (json.isNullOrBlank() || json == "{}") return emptyMap()
        return try {
            val obj = JSONObject(json)
            val map = LinkedHashMap<String, Int>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                map[k] = obj.optInt(k)
            }
            map
        } catch (e: Exception) {
            emptyMap()
        }
    }

    /* ─────── Map<Enum, Int>（时段分布） ─────── */

    inline fun <reified E : Enum<E>> enumMapToJson(map: Map<E, Int>?): String {
        if (map.isNullOrEmpty()) return "{}"
        val obj = JSONObject()
        map.forEach { (k, v) -> obj.put(k.name, v) }
        return obj.toString()
    }

    inline fun <reified E : Enum<E>> jsonToEnumMap(json: String?): Map<E, Int> {
        if (json.isNullOrBlank() || json == "{}") return emptyMap()
        return try {
            val obj = JSONObject(json)
            val map = LinkedHashMap<E, Int>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                runCatching { enumValueOf<E>(k) }.getOrNull()?.let {
                    map[it] = obj.optInt(k)
                }
            }
            map
        } catch (e: Exception) {
            emptyMap()
        }
    }
}
