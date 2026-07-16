/**
 * Frontend logic for the Odds-API.io demo web app.
 *
 * Talks to the Flask backend's REST endpoints (which proxy the
 * odds_api Python SDK) and to its Socket.IO server for real-time
 * odds updates.
 */

const DEFAULT_MARKETS = "ML,Spread,Totals";
const DEFAULT_BOOKMAKERS = "Bet365,SingBet";

const state = {
  sport: null,
  league: null,
  status: "upcoming",
  eventId: null,
};

const sportSelect = document.getElementById("sport-select");
const leagueSelect = document.getElementById("league-select");
const eventsList = document.getElementById("events-list");
const eventDetail = document.getElementById("event-detail");
const feedLog = document.getElementById("feed-log");
const feedToggle = document.getElementById("feed-toggle");
const connStatus = document.getElementById("conn-status");
const tabButtons = document.querySelectorAll(".tab-btn");

async function fetchJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

function setOptions(select, items, { valueKey, labelKey, placeholder }) {
  select.innerHTML = "";
  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item[valueKey];
    opt.textContent = item[labelKey] || item[valueKey];
    select.appendChild(opt);
  }
}

// ─── 1. Sports & leagues ────────────────────────────────────────────

async function loadSports() {
  try {
    const sports = await fetchJSON("/api/sports");
    // Normalise the sport identifier field name (APIs may use
    // `slug`, `key`, or `id`) so the <select> value always matches
    // what we store in `state.sport`.
    const normalised = sports.map((s) => ({
      ...s,
      slug: s.slug || s.key || s.id,
    }));
    setOptions(sportSelect, normalised, { valueKey: "slug", labelKey: "name" });
    state.sport = sportSelect.value;
    await loadLeagues();
    await loadEvents();
  } catch (err) {
    eventsList.innerHTML = `<li class="muted">Failed to load sports: ${err.message}</li>`;
  }
}

async function loadLeagues() {
  if (!state.sport) return;
  try {
    const leagues = await fetchJSON(`/api/leagues?sport=${encodeURIComponent(state.sport)}`);
    setOptions(leagueSelect, leagues, {
      valueKey: "slug",
      labelKey: "name",
      placeholder: "All leagues",
    });
    state.league = "";
  } catch (err) {
    leagueSelect.innerHTML = `<option value="">All leagues</option>`;
  }
}

sportSelect.addEventListener("change", async () => {
  state.sport = sportSelect.value;
  await loadLeagues();
  await loadEvents();
});

leagueSelect.addEventListener("change", async () => {
  state.league = leagueSelect.value;
  await loadEvents();
});

// ─── 2. Events ──────────────────────────────────────────────────────

tabButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.status = btn.dataset.status;
    await loadEvents();
  });
});

async function loadEvents() {
  if (!state.sport) return;
  eventsList.innerHTML = `<li class="muted">Loading...</li>`;
  try {
    const params = new URLSearchParams({ sport: state.sport, status: state.status });
    if (state.league) params.set("league", state.league);
    const events = await fetchJSON(`/api/events?${params.toString()}`);
    renderEvents(events);
  } catch (err) {
    eventsList.innerHTML = `<li class="muted">Failed to load events: ${err.message}</li>`;
  }
}

function renderEvents(events) {
  eventsList.innerHTML = "";
  if (!events.length) {
    eventsList.innerHTML = `<li class="muted">No events found.</li>`;
    return;
  }
  for (const event of events) {
    const li = document.createElement("li");
    const home = event.home || event.homeTeam || "?";
    const away = event.away || event.awayTeam || "?";
    const when = event.startTime || event.start || event.commenceTime || "";
    li.textContent = `${home} vs ${away} ${when ? `— ${when}` : ""}`;
    li.addEventListener("click", () => loadOdds(event.id));
    eventsList.appendChild(li);
  }
}

// ─── 3. Odds ────────────────────────────────────────────────────────

async function loadOdds(eventId) {
  state.eventId = eventId;
  eventDetail.innerHTML = `<p class="muted">Loading odds...</p>`;
  try {
    const odds = await fetchJSON(
      `/api/odds?event_id=${encodeURIComponent(eventId)}&bookmakers=${encodeURIComponent(DEFAULT_BOOKMAKERS)}`
    );
    renderOdds(odds);
  } catch (err) {
    eventDetail.innerHTML = `<p class="muted">Failed to load odds: ${err.message}</p>`;
  }
}

function renderOdds(odds) {
  const bookmakers = odds.bookmakers || {};
  if (!Object.keys(bookmakers).length) {
    eventDetail.innerHTML = `<p class="muted">No odds available for this event.</p>`;
    return;
  }

  let html = "";
  for (const [bookie, markets] of Object.entries(bookmakers)) {
    html += `<h3>${bookie}</h3><table><thead><tr><th>Market</th><th>Line</th><th>Odds</th></tr></thead><tbody>`;
    for (const market of markets || []) {
      for (const o of market.odds || []) {
        const line = o.hdp !== undefined ? o.hdp : "-";
        const values = Object.entries(o)
          .filter(([k]) => k !== "hdp")
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ");
        html += `<tr><td>${market.name}</td><td>${line}</td><td>${values}</td></tr>`;
      }
    }
    html += "</tbody></table>";
  }
  eventDetail.innerHTML = html;
}

// ─── 4. Live odds feed via Socket.IO ───────────────────────────────

const socket = io();

socket.on("connect", () => {
  connStatus.textContent = "Connected";
  connStatus.className = "badge badge-online";
});

socket.on("disconnect", () => {
  connStatus.textContent = "Disconnected";
  connStatus.className = "badge badge-offline";
});

socket.on("subscribed", (payload) => {
  logFeed(`Subscribed to feed: ${payload.room}`);
});

socket.on("subscribe_error", (payload) => {
  logFeed(`Subscription error: ${payload.error}`);
});

socket.on("odds_update", (data) => {
  const type = data.type || "message";
  if (type === "welcome") {
    logFeed(`Feed connected. Bookmakers: ${(data.bookmakers || []).join(", ")}`);
    return;
  }
  if (type === "created" || type === "updated") {
    logFeed(`[${type.toUpperCase()}] event ${data.id} @ ${data.bookie} (seq ${data.seq})`);
  } else if (type === "deleted") {
    logFeed(`[DELETED] event ${data.id} @ ${data.bookie}`);
  } else if (type === "resync_required") {
    logFeed(`[RESYNC REQUIRED] ${data.reason || ""}`);
  }
});

function logFeed(message) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  li.textContent = `[${time}] ${message}`;
  feedLog.prepend(li);
  while (feedLog.children.length > 200) {
    feedLog.removeChild(feedLog.lastChild);
  }
}

function buildFeedPayload() {
  return {
    sport: state.sport,
    leagues: state.league || undefined,
    markets: DEFAULT_MARKETS,
    status: state.status === "live" ? "live" : "prematch",
  };
}

feedToggle.addEventListener("change", () => {
  if (feedToggle.checked) {
    socket.emit("subscribe", buildFeedPayload());
  } else {
    socket.emit("unsubscribe", buildFeedPayload());
  }
});

loadSports();
