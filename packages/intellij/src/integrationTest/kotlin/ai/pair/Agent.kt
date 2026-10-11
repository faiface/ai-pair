package ai.pair

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** An agent connected the way a harness connects: MCP over the launcher's stdio, started in the project folder. */
class Agent(launcher: String, cwd: File, home: File) : AutoCloseable {
    private val process = ProcessBuilder(launcher).directory(cwd)
        .redirectError(ProcessBuilder.Redirect.INHERIT)
        .apply { environment()["AI_PAIR_HOME"] = home.path }
        .start()
    private val input = process.outputStream.bufferedWriter(Charsets.UTF_8)
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
    private val ids = AtomicInteger()

    init {
        thread(name = "agent", isDaemon = true) {
            process.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { line ->
                val m = JsonParser.parseString(line).asJsonObject
                // Requests and notifications from the relay have a method; only answers are ours.
                if (!m.has("method")) pending.remove(m["id"].asInt)?.complete(m)
            }
            pending.values.forEach { it.completeExceptionally(IllegalStateException("The relay exited")) }
        }
        request("initialize", """{"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "integration", "version": "0"}}""").get(30, TimeUnit.SECONDS)
        send(JsonObject().apply { addProperty("jsonrpc", "2.0"); addProperty("method", "notifications/initialized") })
    }

    fun tools(): List<String> =
        request("tools/list", "{}").get(30, TimeUnit.SECONDS)["tools"].asJsonArray.map { it.asJsonObject["name"].asString }

    /** Calls a tool, and answers with its report's text, as the agent reads it. */
    fun call(name: String, args: String = "{}"): CompletableFuture<String> =
        request("tools/call", JsonObject().apply { addProperty("name", name); add("arguments", JsonParser.parseString(args)) }.toString())
            .thenApply { result ->
                val text = result["content"].asJsonArray.first().asJsonObject["text"].asString
                check(result["isError"]?.asBoolean != true) { "$name: $text" }
                text
            }

    /** `step` with these actions, a JSON array. */
    fun step(actions: String = "[]") = call("step", JsonObject().apply { add("actions", JsonParser.parseString(actions)) }.toString())

    private fun request(method: String, params: String): CompletableFuture<JsonObject> {
        val id = ids.incrementAndGet()
        val answer = CompletableFuture<JsonObject>()
        pending[id] = answer
        send(JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", id)
            addProperty("method", method)
            add("params", JsonParser.parseString(params))
        })
        return answer.thenApply { m ->
            m["error"]?.let { error("$method: $it") }
            m["result"].asJsonObject
        }
    }

    @Synchronized
    private fun send(message: JsonElement) {
        input.write("$message\n")
        input.flush()
    }

    /** The launcher is a script that starts Node, so the relay is its child. */
    override fun close() {
        input.close()
        if (!process.waitFor(5, TimeUnit.SECONDS)) {
            process.descendants().forEach { it.destroy() }
            process.destroy()
        }
    }
}

