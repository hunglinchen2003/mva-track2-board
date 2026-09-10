"""Poll the Track 2 discussion board and reply with local Ollama gpt-oss:20b."""

from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
LOCAL_CONFIG_PATH = Path(__file__).resolve().parent / "local_config.json"
CONTEXT_PATH = Path(__file__).resolve().parent / "track2_context.txt"
POLL_SECONDS = 8
TZ = timezone(timedelta(hours=8))

ssl_ctx = ssl.create_default_context()


def load_config() -> dict:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if LOCAL_CONFIG_PATH.exists():
        cfg.update(json.loads(LOCAL_CONFIG_PATH.read_text(encoding="utf-8")))
    return cfg


def http_json(url: str, payload: dict | None = None, timeout: int = 120) -> dict:
    headers = {"Content-Type": "text/plain;charset=utf-8"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    else:
        req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_ctx) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {err.code}: {body[:400]}") from err


def gas_get(webapp: str, action: str, token: str) -> dict:
    query = urllib.parse.urlencode({"action": action, "token": token})
    return http_json(f"{webapp}?{query}")


def gas_write(webapp: str, payload: dict) -> dict:
    # Browser CORS needs iframe POST; from Python, POST then follow redirect.
    # If POST is converted to GET by a 302, retry via GET payload (short) or POST form.
    try:
        return http_json(webapp, payload)
    except Exception:
        form = urllib.parse.urlencode(
            {"payload": json.dumps(payload, ensure_ascii=False)}
        ).encode("utf-8")
        req = urllib.request.Request(
            webapp,
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120, context=ssl_ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))


def ollama_plan(cfg: dict, system: str, user: str) -> str:
    url = cfg["ollamaUrl"].rstrip("/") + "/api/chat"
    payload = {
        "model": cfg["ollamaModel"],
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    msg = result.get("message") or {}
    text = (msg.get("content") or result.get("response") or "").strip()
    if not text:
        raise RuntimeError("Ollama returned empty content")
    return text


def thread_context(messages: list[dict], target: dict) -> str:
    by_id = {m["id"]: m for m in messages}
    root = target
    while root.get("parent_id") and root["parent_id"] in by_id:
        root = by_id[root["parent_id"]]
    lines = []
    for m in messages:
        if m["id"] == root["id"] or m.get("parent_id") == root["id"] or m["id"] == target["id"]:
            who = m.get("author") or "匿名"
            role = m.get("role") or "human"
            lines.append(f"[{role}] {who}: {m.get('content', '')}")
    return "\n\n".join(lines)


def already_replied(messages: list[dict], post_id: str) -> bool:
    return any(
        m.get("parent_id") == post_id and m.get("role") == "ai" for m in messages
    )


def log(msg: str) -> None:
    now = datetime.now(TZ).strftime("%H:%M:%S")
    print(f"[{now}] {msg}", flush=True)


def main() -> int:
    cfg = load_config()
    webapp = (cfg.get("sheetsWebAppUrl") or "").strip()
    if not webapp:
        print("請先把 Apps Script Web App URL 寫進 config.json 的 sheetsWebAppUrl")
        print("或建立 worker/local_config.json 覆寫該欄位。")
        return 1
    system = CONTEXT_PATH.read_text(encoding="utf-8")
    token = cfg.get("teamToken", "")
    model = cfg.get("ollamaModel", "gpt-oss:20b")
    log(f"連線試算表 Web App，模型 {model}")
    log("在討論板勾選「請 AI 規劃」後，本程式會把回覆寫回留言串。")

    while True:
        try:
            gas_write(
                webapp,
                {
                    "action": "heartbeat",
                    "token": token,
                    "model": model,
                    "status": "online",
                },
            )
            listing = gas_get(webapp, "list", token)
            if not listing.get("ok"):
                log(f"讀取失敗：{listing.get('error')}")
            else:
                messages = listing.get("messages") or []
                pending = [
                    m
                    for m in messages
                    if m.get("ask_ai")
                    and m.get("ai_status") == "pending"
                    and m.get("role") != "ai"
                    and not already_replied(messages, m["id"])
                ]
                if pending:
                    log(f"待規劃 {len(pending)} 則")
                for post in pending:
                    user = (
                        "請根據下列討論串，針對最新一則組員提案產出 Track 2 執行規劃。\n\n"
                        + thread_context(messages, post)
                    )
                    log(f"規劃中：{post.get('author')} / {post['id'][:8]}…")
                    try:
                        plan = ollama_plan(cfg, system, user)
                        created = gas_write(
                            webapp,
                            {
                                "action": "reply",
                                "token": token,
                                "parent_id": post["id"],
                                "author": f"AI · {model}",
                                "role": "ai",
                                "content": plan,
                                "ask_ai": False,
                            },
                        )
                        if not created.get("ok"):
                            raise RuntimeError(created.get("error") or "write failed")
                        gas_write(
                            webapp,
                            {
                                "action": "mark_ai",
                                "token": token,
                                "id": post["id"],
                                "ai_status": "done",
                            },
                        )
                        log("已把 AI 規劃寫回討論串")
                    except Exception as inner:
                        log(f"這一則失敗：{inner}")
        except KeyboardInterrupt:
            log("停止")
            return 0
        except Exception as err:
            log(f"輪詢錯誤：{err}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
