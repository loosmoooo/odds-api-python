"""
Odds-API.io demo web application.

A small Flask app that showcases the ``odds_api`` Python SDK:

1. Browse available sports & leagues
2. List upcoming and live events
3. Fetch real-time odds for an event
4. Stream live odds updates to the browser over WebSocket (Socket.IO),
   backed by a connection to the Odds-API.io real-time feed.

Run with:
    ODDS_API_KEY=your_key python webapp/app.py
"""

import json
import logging
import os
import threading
from urllib.parse import urlencode

import websocket
from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO

from odds_api import OddsAPIClient
from odds_api.exceptions import OddsAPIError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("odds_api_webapp")

API_KEY = os.environ.get("ODDS_API_KEY", "")
WS_URL = os.environ.get("ODDS_API_WS_URL", "wss://api.odds-api.io/v3/ws")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-key")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


def get_client() -> OddsAPIClient:
    """Create a new SDK client for the configured API key."""
    if not API_KEY:
        raise RuntimeError(
            "ODDS_API_KEY environment variable is not set. "
            "Get a key at https://odds-api.io and export it before "
            "starting the server."
        )
    return OddsAPIClient(api_key=API_KEY)


def handle_api_error(exc: Exception):
    logger.exception("Odds-API request failed")
    status = 502 if isinstance(exc, OddsAPIError) else 500
    return jsonify({"error": str(exc)}), status


# ─── Pages ─────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return render_template("index.html", api_key_configured=bool(API_KEY))


# ─── REST API (proxied through the odds_api SDK) ───────────────────────


@app.route("/api/sports")
def api_sports():
    """1. Get all sports/leagues that can be participated in."""
    try:
        client = get_client()
        try:
            return jsonify(client.get_sports())
        finally:
            client.close()
    except Exception as exc:  # noqa: BLE001
        return handle_api_error(exc)


@app.route("/api/leagues")
def api_leagues():
    sport = request.args.get("sport")
    if not sport:
        return jsonify({"error": "Query parameter 'sport' is required"}), 400
    try:
        client = get_client()
        try:
            return jsonify(client.get_leagues(sport=sport))
        finally:
            client.close()
    except Exception as exc:  # noqa: BLE001
        return handle_api_error(exc)


@app.route("/api/events")
def api_events():
    """2. Get upcoming and live events."""
    sport = request.args.get("sport")
    if not sport:
        return jsonify({"error": "Query parameter 'sport' is required"}), 400
    league = request.args.get("league") or None
    status = request.args.get("status") or None
    try:
        client = get_client()
        try:
            if status == "live":
                events = client.get_live_events(sport=sport)
            else:
                events = client.get_events(
                    sport=sport, league=league, status=status or "upcoming"
                )
            return jsonify(events)
        finally:
            client.close()
    except Exception as exc:  # noqa: BLE001
        return handle_api_error(exc)


@app.route("/api/odds")
def api_odds():
    """3. Get real-time odds for an event."""
    event_id = request.args.get("event_id")
    bookmakers = request.args.get("bookmakers", "Bet365")
    if not event_id:
        return jsonify({"error": "Query parameter 'event_id' is required"}), 400
    try:
        client = get_client()
        try:
            return jsonify(
                client.get_event_odds(event_id=event_id, bookmakers=bookmakers)
            )
        finally:
            client.close()
    except Exception as exc:  # noqa: BLE001
        return handle_api_error(exc)


# ─── 4. Real-time odds updates via WebSocket ───────────────────────────
#
# The browser talks to this server over Socket.IO. This server, in turn,
# opens a single upstream WebSocket connection per subscription to the
# Odds-API.io real-time feed and rebroadcasts every message to the
# subscribed Socket.IO clients.


class OddsFeedBroadcaster:
    """Bridges the Odds-API.io WebSocket feed to Socket.IO rooms."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self._lock = threading.Lock()
        self._feeds = {}  # room -> {"ws": WebSocketApp, "thread": Thread}

    @staticmethod
    def _room_name(sport, leagues, markets, status):
        return "|".join(
            [
                sport or "",
                leagues or "",
                markets or "",
                status or "",
            ]
        )

    def _build_url(self, sport, leagues, markets, status):
        params = {"apiKey": self.api_key, "markets": markets}
        if sport:
            params["sport"] = sport
        if leagues:
            params["leagues"] = leagues
        if status:
            params["status"] = status
        return f"{WS_URL}?{urlencode(params)}"

    def ensure_feed(self, sport, leagues, markets, status):
        room = self._room_name(sport, leagues, markets, status)
        with self._lock:
            if room in self._feeds:
                return room

            url = self._build_url(sport, leagues, markets, status)

            def on_message(_ws, message):
                for line in message.strip().split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    socketio.emit("odds_update", data, room=room)

            def on_error(_ws, error):
                logger.warning("Feed %s error: %s", room, error)

            def on_close(_ws, code, reason):
                logger.info("Feed %s closed (%s %s)", room, code, reason)
                with self._lock:
                    self._feeds.pop(room, None)

            def on_open(_ws):
                logger.info("Feed %s connected", room)

            ws_app = websocket.WebSocketApp(
                url,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            thread = threading.Thread(
                target=ws_app.run_forever,
                kwargs={"ping_interval": 30, "ping_timeout": 10},
                daemon=True,
            )
            self._feeds[room] = {"ws": ws_app, "thread": thread}
            thread.start()
            return room


broadcaster = OddsFeedBroadcaster(API_KEY)


@socketio.on("subscribe")
def on_subscribe(payload):
    """Browser client asks to subscribe to a live odds feed.

    Expected payload: {"sport": "football", "leagues": "england-premier-league",
                        "markets": "ML,Spread,Totals", "status": "prematch"}
    """
    if not API_KEY:
        socketio.emit(
            "subscribe_error",
            {"error": "Server is missing ODDS_API_KEY"},
            room=request.sid,
        )
        return

    sport = (payload or {}).get("sport")
    leagues = (payload or {}).get("leagues")
    markets = (payload or {}).get("markets") or "ML,Spread,Totals"
    status = (payload or {}).get("status")

    room = broadcaster.ensure_feed(sport, leagues, markets, status)
    from flask_socketio import join_room

    join_room(room)
    socketio.emit("subscribed", {"room": room}, room=request.sid)


@socketio.on("unsubscribe")
def on_unsubscribe(payload):
    from flask_socketio import leave_room

    room = broadcaster._room_name(
        (payload or {}).get("sport"),
        (payload or {}).get("leagues"),
        (payload or {}).get("markets") or "ML,Spread,Totals",
        (payload or {}).get("status"),
    )
    leave_room(room)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "true").lower() == "true"
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=debug,
        allow_unsafe_werkzeug=True,
    )
