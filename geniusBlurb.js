// geniusBlurb.js - Spicetify Extension
// Shows Genius song descriptions/meanings in Spotify

const TOKEN_KEY = "geniusBlurb:token";
const CACHE_KEY = "geniusBlurb:cache";

// Live line-sync state (not cached — tied to current playback)
let currentSongData = null;
let lastLineIndex = -1;
let lineSyncInterval = null;

// ── Wait for Spicetify to be ready ───────────────────────────────────────────
(function init() {
  if (!Spicetify?.Player || !Spicetify?.Platform || !Spicetify?.PopupModal) {
    setTimeout(init, 100);
    return;
  }
  main();
})();

// ── Genius API token (stored locally via Spicetify, never in source) ───────────
function getToken() {
  return Spicetify.LocalStorage.get(TOKEN_KEY) || "";
}

function promptForToken(onSaved) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:320px;";
  wrapper.innerHTML = `
    <p style="margin:0;font-size:13px;color:#ccc;">
      Enter your Genius API access token (create a free client at
      <a href="https://genius.com/api-clients" target="_blank" style="color:#ffff64;">genius.com/api-clients</a>).
    </p>
    <input id="genius-token-input" type="password" placeholder="Genius access token"
      style="padding:8px;border-radius:4px;border:1px solid #444;background:#111;color:#fff;font-size:13px;" />
    <button id="genius-token-save"
      style="padding:8px;border-radius:4px;border:none;background:#ffff64;color:#000;font-weight:700;cursor:pointer;">
      Save
    </button>
  `;
  Spicetify.PopupModal.display({ title: "✦ Genius — API Token", content: wrapper });

  wrapper.querySelector("#genius-token-save").addEventListener("click", () => {
    const val = wrapper.querySelector("#genius-token-input").value.trim();
    if (!val) return;
    Spicetify.LocalStorage.set(TOKEN_KEY, val);
    Spicetify.PopupModal.hide();
    onSaved?.();
  });
}

// ── Genius API ────────────────────────────────────────────────────────────────
async function geniusFetch(url) {
  const token = getToken();
  if (!token) throw new Error("NO_TOKEN");
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}access_token=${token}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchGenius(title, artist) {
  const query = encodeURIComponent(`${title} ${artist}`);
  const data = await geniusFetch(`https://api.genius.com/search?q=${query}`);
  const hits = data?.response?.hits;
  if (!hits || hits.length === 0) return null;
  return hits[0].result;
}

async function getSongDetails(songId) {
  const data = await geniusFetch(`https://api.genius.com/songs/${songId}?text_format=plain`);
  return data?.response?.song;
}

// Per-line annotations ("referents") — first page (50) covers the vast
// majority of songs; deeply-annotated tracks may be missing later ones.
async function fetchReferents(songId) {
  try {
    const data = await geniusFetch(
      `https://api.genius.com/referents?song_id=${songId}&text_format=plain&per_page=50`
    );
    const referents = data?.response?.referents || [];
    return referents
      .map((r) => {
        const annotation = r.annotations?.[0]?.body?.plain?.trim();
        const fragment = r.fragment?.trim();
        if (!annotation || !fragment) return null;
        return { fragment, words: normalizeWords(fragment), annotation };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Spotify synced lyrics (internal endpoint, exposed via CosmosAsync) ─────────
async function fetchLyrics(spotifyTrackId) {
  if (!spotifyTrackId || !Spicetify?.CosmosAsync) return null;
  try {
    const data = await Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/color-lyrics/v2/track/${spotifyTrackId}?format=json&vocalRemoval=false&market=from_token`
    );
    const lines = data?.lyrics?.lines;
    if (data?.lyrics?.syncType !== "LINE_SYNCED" || !lines?.length) return null;
    return lines.map((l, i) => ({
      startMs: Number(l.startTimeMs),
      endMs: lines[i + 1] ? Number(lines[i + 1].startTimeMs) : Infinity,
      text: l.words || "",
    }));
  } catch {
    return null;
  }
}

// ── Line ↔ annotation matching ──────────────────────────────────────────────────
function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Genius fragments don't line up 1:1 with Spotify's lyric lines (they can span
// partial lines or multiple lines), so match by word overlap rather than exact text.
function findLineAnnotation(lineText, referents) {
  if (!lineText || !referents?.length) return null;
  const lineWords = new Set(normalizeWords(lineText));
  if (lineWords.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const ref of referents) {
    if (!ref.words?.length) continue;
    let overlap = 0;
    for (const w of ref.words) if (lineWords.has(w)) overlap++;
    const score = overlap / Math.max(ref.words.length, lineWords.size);
    if (score > bestScore) {
      bestScore = score;
      best = ref;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
function getCached(trackId) {
  try {
    const raw = Spicetify.LocalStorage.get(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    return cache[trackId] || null;
  } catch { return null; }
}

function setCache(trackId, data) {
  try {
    const raw = Spicetify.LocalStorage.get(CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    const keys = Object.keys(cache);
    if (keys.length >= 50) delete cache[keys[0]];
    cache[trackId] = data;
    Spicetify.LocalStorage.set(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

// ── Fetch current song data ───────────────────────────────────────────────────
async function fetchGeniusData() {
  const meta = Spicetify.Player.data?.item;
  if (!meta) return null;

  const title = meta.name;
  const artist = meta.artists?.[0]?.name || "";
  const trackId = meta.uri;

  const cached = getCached(trackId);
  if (cached) return cached;

  const [result, lyrics] = await Promise.all([
    searchGenius(title, artist),
    fetchLyrics(trackId.split(":")[2]),
  ]);
  if (!result) return null;

  const song = await getSongDetails(result.id);
  if (!song) return null;

  // Only worth fetching per-line annotations if we have timestamps to sync them to.
  const referents = lyrics ? await fetchReferents(song.id) : [];

  const desc = song.description?.plain?.trim();
  const payload = {
    title: song.title,
    artist: song.primary_artist?.name,
    description: (!desc || desc === "?") ? null : desc,
    url: song.url,
    thumbnail: song.song_art_image_thumbnail_url,
    album: song.album?.name || null,
    releaseDate: song.release_date || null,
    producers: (song.producer_artists || []).map((a) => a.name).filter(Boolean),
    writers: (song.writer_artists || []).map((a) => a.name).filter(Boolean),
    media: (song.media || [])
      .filter((m) => m.url)
      .map((m) => ({ provider: m.provider, url: m.url })),
    lyrics,
    referents,
  };

  setCache(trackId, payload);
  return payload;
}

// ── Styles ────────────────────────────────────────────────────────────────────
function addStyles() {
  const style = document.createElement("style");
  style.textContent = `
    #genius-panel {
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 320px;
      max-height: 420px;
      background: #1a1a2e;
      border: 1px solid #ffff64;
      border-radius: 12px;
      padding: 16px;
      overflow-y: auto;
      z-index: 9999;
      font-family: 'Circular', sans-serif;
      color: #fff;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      scrollbar-width: thin;
      scrollbar-color: #ffff64 transparent;
    }
    #genius-panel::-webkit-scrollbar { width: 4px; }
    #genius-panel::-webkit-scrollbar-thumb { background: #ffff64; border-radius: 4px; }
    #genius-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    #genius-panel-logo {
      font-size: 13px;
      font-weight: 700;
      color: #ffff64;
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    #genius-panel-close {
      background: none;
      border: none;
      color: #aaa;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #genius-panel-close:hover { color: #fff; }
    #genius-panel-thumb {
      width: 48px;
      height: 48px;
      border-radius: 6px;
      object-fit: cover;
      margin-bottom: 10px;
    }
    #genius-panel-song {
      font-size: 13px;
      color: #aaa;
      margin-bottom: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #genius-panel-body {
      font-size: 14px;
      line-height: 1.6;
      color: #e0e0e0;
    }
    #genius-panel-link {
      display: none;
      margin-top: 12px;
      font-size: 12px;
      color: #ffff64;
      text-decoration: none;
      opacity: 0.8;
    }
    #genius-panel-link:hover { opacity: 1; }
    #genius-panel-line {
      display: none;
      margin-bottom: 14px;
      padding: 10px 12px;
      background: rgba(255,255,100,0.08);
      border-left: 3px solid #ffff64;
      border-radius: 4px;
    }
    #genius-panel-line-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      color: #ffff64;
      margin-bottom: 4px;
    }
    #genius-panel-line-text {
      font-size: 12px;
      font-style: italic;
      color: #ccc;
      margin-bottom: 6px;
    }
    #genius-panel-line-annotation {
      font-size: 13px;
      line-height: 1.5;
      color: #fff;
    }
    #genius-panel-body-label {
      display: none;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      color: #888;
      margin-bottom: 6px;
    }
    #genius-panel-facts-label {
      display: none;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      color: #888;
      margin: 14px 0 6px;
    }
    #genius-panel-facts {
      display: none;
    }
    .genius-fact-row {
      display: flex;
      gap: 8px;
      font-size: 12px;
      line-height: 1.6;
      color: #e0e0e0;
    }
    .genius-fact-key {
      flex: 0 0 88px;
      color: #888;
    }
    .genius-fact-val a {
      color: #ffff64;
      text-decoration: none;
    }
    .genius-fact-val a:hover { text-decoration: underline; }
    #genius-toggle-btn {
      position: fixed;
      bottom: 90px;
      right: 20px;
      background: #ffff64;
      color: #000;
      border: none;
      border-radius: 20px;
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      z-index: 9998;
      letter-spacing: 0.5px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: transform 0.1s;
    }
    #genius-toggle-btn:hover { transform: scale(1.05); }
  `;
  document.head.appendChild(style);
}

// ── UI ────────────────────────────────────────────────────────────────────────
function buildUI() {
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "genius-toggle-btn";
  toggleBtn.textContent = "✦ Genius";
  document.body.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.id = "genius-panel";
  panel.innerHTML = `
    <div id="genius-panel-header">
      <span id="genius-panel-logo">✦ Genius</span>
      <button id="genius-panel-close">✕</button>
    </div>
    <img id="genius-panel-thumb" style="display:none" alt="" />
    <div id="genius-panel-song">Loading...</div>
    <div id="genius-panel-line">
      <div id="genius-panel-line-label">♪ CURRENTLY PLAYING LINE</div>
      <div id="genius-panel-line-text"></div>
      <div id="genius-panel-line-annotation"></div>
    </div>
    <div id="genius-panel-body-label">ABOUT THIS SONG</div>
    <div id="genius-panel-body"></div>
    <div id="genius-panel-facts-label">SONG FACTS</div>
    <div id="genius-panel-facts"></div>
    <a id="genius-panel-link" target="_blank" href="#">View on Genius ↗</a>
  `;
  document.body.appendChild(panel);

  let panelOpen = false;

  toggleBtn.addEventListener("click", () => {
    panelOpen = true;
    panel.style.display = "block";
    toggleBtn.style.display = "none";
    renderPanel();
    startLineTicker();
  });

  document.getElementById("genius-panel-close").addEventListener("click", () => {
    panelOpen = false;
    panel.style.display = "none";
    toggleBtn.style.display = "block";
    stopLineTicker();
  });

  // Auto-refresh when song changes and panel is open
  Spicetify.Player.addEventListener("songchange", () => {
    if (panelOpen) renderPanel();
    // Always prefetch in background for instant load next time
    fetchGeniusData().catch(() => {});
  });
}

// ── Render panel content ──────────────────────────────────────────────────────
async function renderPanel() {
  currentSongData = null;
  lastLineIndex = -1;
  const lineSectionEl = document.getElementById("genius-panel-line");
  if (lineSectionEl) lineSectionEl.style.display = "none";

  const meta = Spicetify.Player.data?.item;
  if (!meta) {
    document.getElementById("genius-panel-body").innerHTML = "Play a song first!";
    return;
  }

  const title = meta.name;
  const artist = meta.artists?.[0]?.name || "";
  document.getElementById("genius-panel-song").textContent = `${title} — ${artist}`;

  // Show cached data instantly if available
  const cached = getCached(meta.uri);
  if (cached) {
    showData(cached);
    return;
  }

  if (!getToken()) {
    showTokenPrompt();
    return;
  }

  document.getElementById("genius-panel-body").innerHTML = "Searching Genius...";
  document.getElementById("genius-panel-link").style.display = "none";
  document.getElementById("genius-panel-thumb").style.display = "none";
  document.getElementById("genius-panel-facts-label").style.display = "none";
  document.getElementById("genius-panel-facts").style.display = "none";

  try {
    const data = await fetchGeniusData();
    if (!data) {
      document.getElementById("genius-panel-body").innerHTML = "No Genius page found for this song.";
      return;
    }
    showData(data);
  } catch (err) {
    if (err?.message === "NO_TOKEN") {
      showTokenPrompt();
      return;
    }
    document.getElementById("genius-panel-body").innerHTML = `<em style="color:#f88">Error: ${err?.message || err}</em>`;
    console.error("[geniusBlurb]", err);
  }
}

function showTokenPrompt() {
  const body = document.getElementById("genius-panel-body");
  body.innerHTML = `<button id="genius-token-setup-btn"
    style="width:100%;padding:8px;border-radius:6px;border:none;background:#ffff64;color:#000;font-weight:700;cursor:pointer;">
    Set up Genius API token
  </button>`;
  document.getElementById("genius-token-setup-btn").addEventListener("click", () => {
    promptForToken(() => renderPanel());
  });
}

function showData(data) {
  currentSongData = data;
  lastLineIndex = -1;
  document.getElementById("genius-panel-line").style.display = "none";
  document.getElementById("genius-panel-body-label").style.display = "none";

  // Thumbnail
  const thumb = document.getElementById("genius-panel-thumb");
  if (data.thumbnail) {
    thumb.src = data.thumbnail;
    thumb.style.display = "block";
  } else {
    thumb.style.display = "none";
  }

  // Song label
  document.getElementById("genius-panel-song").textContent = `${data.title} — ${data.artist}`;

  // Description
  const body = document.getElementById("genius-panel-body");
  if (data.description) {
    body.innerHTML = `<p>${data.description.replace(/\n/g, "<br>")}</p>`;
  } else {
    body.innerHTML = `<em style="color:#888">No description available for this song on Genius.</em>`;
  }

  // Facts
  renderFacts(data);

  // Link
  const link = document.getElementById("genius-panel-link");
  link.href = data.url;
  link.style.display = "inline-block";
}

const MEDIA_LABELS = { youtube: "YouTube", soundcloud: "SoundCloud", spotify: "Spotify", vevo: "Vevo", audiomack: "Audiomack" };

function mediaLabel(provider) {
  return MEDIA_LABELS[provider] || (provider ? provider[0].toUpperCase() + provider.slice(1) : "Link");
}

function factRow(key, valueHtml) {
  return `<div class="genius-fact-row"><span class="genius-fact-key">${key}</span><span class="genius-fact-val">${valueHtml}</span></div>`;
}

function renderFacts(data) {
  const label = document.getElementById("genius-panel-facts-label");
  const container = document.getElementById("genius-panel-facts");
  const rows = [];

  if (data.album) rows.push(factRow("Album", escapeHtml(data.album)));
  if (data.releaseDate) rows.push(factRow("Released", escapeHtml(data.releaseDate)));
  if (data.producers?.length) {
    rows.push(factRow(data.producers.length > 1 ? "Producers" : "Producer", escapeHtml(data.producers.join(", "))));
  }
  if (data.writers?.length) {
    rows.push(factRow(data.writers.length > 1 ? "Writers" : "Writer", escapeHtml(data.writers.join(", "))));
  }
  if (data.media?.length) {
    const links = data.media
      .map((m) => `<a href="${escapeHtml(m.url)}" target="_blank">${escapeHtml(mediaLabel(m.provider))}</a>`)
      .join(" · ");
    rows.push(factRow("Listen/Watch", links));
  }

  if (!rows.length) {
    label.style.display = "none";
    container.style.display = "none";
    return;
  }
  container.innerHTML = rows.join("");
  label.style.display = "block";
  container.style.display = "block";
}

// ── Live line-sync ticker ────────────────────────────────────────────────────
function startLineTicker() {
  if (lineSyncInterval) return;
  lineSyncInterval = setInterval(tickLineSync, 400);
}

function stopLineTicker() {
  clearInterval(lineSyncInterval);
  lineSyncInterval = null;
}

function tickLineSync() {
  const lineSection = document.getElementById("genius-panel-line");
  if (!lineSection) return;

  if (!currentSongData?.lyrics?.length || typeof Spicetify.Player.getProgress !== "function") {
    lineSection.style.display = "none";
    return;
  }

  const progress = Spicetify.Player.getProgress();
  const idx = currentSongData.lyrics.findIndex(
    (l) => progress >= l.startMs && progress < l.endMs
  );
  if (idx === -1 || idx === lastLineIndex) return;
  lastLineIndex = idx;

  const line = currentSongData.lyrics[idx];
  const match = findLineAnnotation(line.text, currentSongData.referents);

  if (match && line.text.trim()) {
    document.getElementById("genius-panel-line-text").textContent = `"${line.text}"`;
    document.getElementById("genius-panel-line-annotation").innerHTML = match.annotation.replace(/\n/g, "<br>");
    document.getElementById("genius-panel-body-label").style.display = currentSongData.description ? "block" : "none";
    lineSection.style.display = "block";
  } else {
    lineSection.style.display = "none";
    document.getElementById("genius-panel-body-label").style.display = "none";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  addStyles();
  buildUI();
  // Prefetch immediately for current song
  fetchGeniusData().catch(() => {});
  console.log("[geniusBlurb] Extension loaded ✓");
}
