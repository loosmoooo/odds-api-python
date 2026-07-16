# Odds-API.io Web App Demo

A small Flask web application that demonstrates the `odds_api` Python SDK
end to end:

1. **Sports & leagues** — browse everything you can bet on.
2. **Events** — list upcoming and live events for a sport/league.
3. **Odds** — fetch real-time odds for a selected event.
4. **Live updates** — subscribe to the Odds-API.io real-time WebSocket
   feed and see odds changes streamed to the browser via Socket.IO.

## Setup

From the repository root:

```bash
pip install -e .
pip install -r webapp/requirements.txt
```

Set your API key (get one at https://odds-api.io):

```bash
export ODDS_API_KEY="your_api_key_here"
```

## Run

```bash
python webapp/app.py
```

Then open http://localhost:5000 in your browser.

## How it works

- `webapp/app.py` exposes REST endpoints (`/api/sports`, `/api/leagues`,
  `/api/events`, `/api/odds`) that call the synchronous `OddsAPIClient`
  from the `odds_api` package.
- It also runs a Flask-SocketIO server. When a browser client emits a
  `subscribe` event, the server opens (or reuses) a single upstream
  WebSocket connection to `wss://api.odds-api.io/v3/ws` and rebroadcasts
  every message to subscribed clients through a Socket.IO room, so
  many browser tabs can share one upstream feed connection.
- `webapp/static/js/app.js` implements the frontend: it loads sports and
  leagues into dropdowns, lists events, fetches odds on click, and
  connects to Socket.IO to display live feed messages.
