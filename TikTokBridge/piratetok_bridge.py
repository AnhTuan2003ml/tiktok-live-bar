#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Engine doc TikTok LIVE bang PirateTok (noi thang TikTok, khong EulerStream, khong key).
Nhan username tu argv, phat su kien da chuan hoa ra stdout dang JSON moi dong;
server.js (Node) spawn tien trinh nay va doc stdout de dua vao game.

Dong stdout:
  {"__status__": "connected"}                      -> da noi
  {"__error__": "..."}                             -> loi ket noi
  {"type":"chat","userId":..,"nickname":..,"comment":..}
  {"type":"gift","userId":..,"nickname":..,"giftName":..,"diamondCount":..,"repeatCount":..}
  {"type":"like","userId":..,"nickname":..,"likeCount":..}
  {"type":"member"/"follow"/"share","userId":..,"nickname":..}
"""
import asyncio
import json
import sys

try:
    from piratetok_live import TikTokLiveClient, EventType
except Exception as ex:  # thu vien chua cai
    sys.stdout.write(json.dumps({"__error__": "piratetok_live chua cai: %s" % ex}) + "\n")
    sys.stdout.flush()
    sys.exit(2)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def pick(d, *keys, default=""):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return default


def user_of(data):
    u = data.get("user") if isinstance(data, dict) else None
    u = u if isinstance(u, dict) else {}
    return {
        "userId": str(pick(u, "userId", "user_id", "id")),
        "uniqueId": str(pick(u, "uniqueId", "unique_id", "handle")),
        "nickname": str(pick(u, "nickname", "nickName", "display_name") or pick(u, "uniqueId", "unique_id") or "Khach"),
        "avatar": str(pick(u, "avatar", "avatarUrl", "avatar_url", "profilePicture")),
    }


def main():
    username = sys.argv[1].lstrip("@") if len(sys.argv) > 1 else ""
    if not username:
        emit({"__error__": "thieu username"})
        return

    client = TikTokLiveClient(username).max_retries(8).timeout(15).stale_timeout(90)

    @client.on(EventType.connected)
    def _connected(evt):
        emit({"__status__": "connected"})

    @client.on(EventType.disconnected)
    def _disconnected(evt):
        emit({"__status__": "disconnected"})

    @client.on(EventType.live_ended)
    def _ended(evt):
        emit({"__status__": "ended"})

    @client.on(EventType.chat)
    def _chat(evt):
        d = getattr(evt, "data", {}) or {}
        u = user_of(d)
        emit({"type": "chat", **u, "comment": str(pick(d, "content", "comment", "text"))})

    @client.on(EventType.gift)
    def _gift(evt):
        d = getattr(evt, "data", {}) or {}
        u = user_of(d)
        g = d.get("gift") if isinstance(d.get("gift"), dict) else {}
        diamond = pick(g, "diamondCount", "diamond_count", default=pick(d, "diamondCount", "diamond_count", default=0))
        try:
            diamond = int(diamond)
        except Exception:
            diamond = 0
        repeat = pick(d, "repeatCount", "repeat_count", "count", default=1)
        try:
            repeat = int(repeat)
        except Exception:
            repeat = 1
        emit({"type": "gift", **u,
              "giftName": str(pick(g, "name", "giftName") or pick(d, "giftName") or "Gift"),
              "giftId": str(pick(g, "id", "giftId") or pick(d, "giftId")),
              "diamondCount": diamond, "repeatCount": repeat})

    @client.on(EventType.like)
    def _like(evt):
        d = getattr(evt, "data", {}) or {}
        u = user_of(d)
        cnt = pick(d, "likeCount", "count", "likes", default=1)
        try:
            cnt = int(cnt)
        except Exception:
            cnt = 1
        emit({"type": "like", **u, "likeCount": cnt})

    @client.on(EventType.member)
    def _member(evt):
        emit({"type": "member", **user_of(getattr(evt, "data", {}) or {})})

    @client.on(EventType.join)
    def _join(evt):
        emit({"type": "member", **user_of(getattr(evt, "data", {}) or {})})

    @client.on(EventType.follow)
    def _follow(evt):
        emit({"type": "follow", **user_of(getattr(evt, "data", {}) or {})})

    @client.on(EventType.share)
    def _share(evt):
        emit({"type": "share", **user_of(getattr(evt, "data", {}) or {})})

    async def run():
        try:
            await client.connect()
        except Exception as ex:
            emit({"__error__": "%s: %s" % (type(ex).__name__, str(ex)[:300])})

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except Exception as ex:
        emit({"__error__": "%s: %s" % (type(ex).__name__, str(ex)[:300])})


if __name__ == "__main__":
    main()
