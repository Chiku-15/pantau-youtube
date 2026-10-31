// Dijalankan oleh GitHub Actions (Node 20, tanpa dependensi).
// Membaca config.json, mengambil angka dari YouTube + Spotify, lalu menambahkannya ke folder data.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) { console.error("YOUTUBE_API_KEY belum diisi di GitHub Secrets."); process.exit(1); }
const D = path.join(__dirname, "data");
fs.mkdirSync(D, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const MIN_DUR = Number(cfg.minDuration || 0); // detik; video lebih pendek dari ini (mis. Shorts) tidak dicatat. 0 = mati.
// Judul yang selalu dibuang meski cocok dengan aturan config: vlog member, cover lagu orang lain,
// versi duplikat (RAW VERSION), dan latihan panggung acara (bukan dance practice biasa).
const JUNK = /\([^()]*\s-\s[^()]*\)|jenny from the block|a\$ap|lil pump|drake|wild for the night|god's plan|be like me|babushka boi|vlog|raw version|stage practice|sbs 20/i;
const now = Date.now();
let failed = 0, recorded = 0;

async function yt(endpoint, params) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + endpoint);
  Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
  url.searchParams.set("key", KEY);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error((json.error && json.error.message) || "Permintaan ke YouTube gagal");
  return json;
}
function videoId(s) {
  s = String(s || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s), h = u.hostname.replace(/^www\./, "");
    if (h === "youtu.be") return u.pathname.slice(1, 12);
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    if (m) return m[1];
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
  } catch (e) { /* abaikan */ }
  return null;
}
function durS(iso){const m=/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(iso||""));return m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):null}
function mapChannel(c) {
  const st = c.statistics || {}, th = (c.snippet && c.snippet.thumbnails) || {};
  return {
    id: c.id, title: c.snippet.title, handle: c.snippet.customUrl || "",
    thumb: (th.medium || th.default || {}).url || "",
    subs: st.hiddenSubscriberCount || st.subscriberCount === undefined ? null : Number(st.subscriberCount),
    views: Number(st.viewCount || 0), videos: Number(st.videoCount || 0),
  };
}
async function channel(input) {
  const s = String(input || "").trim();
  const params = { part: "snippet,statistics" };
  let val = s;
  const found = s.match(/UC[\w-]{22}/);
  if (found) { params.id = found[0]; val = null; }
  else if (/^https?:\/\//i.test(s) || /^(www\.)?youtube\.com\//i.test(s)) {
    const u = new URL(/^https?:/i.test(s) ? s : "https://" + s);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "channel") val = parts[1];
    else if (parts[0] && parts[0][0] === "@") val = parts[0];
    else if (parts[0] === "user") { params.forUsername = parts[1]; val = null; }
    else throw new Error("Tautan channel belum dikenali: " + s + " (pakai @handle atau tautan /channel/UC...)");
  }
  if (val) {
    params.forHandle = val[0] === "@" ? val : "@" + val;
  }
  const json = await yt("channels", params);
  const c = json.items && json.items[0];
  if (!c) throw new Error("Channel tidak ditemukan: " + s);
  return mapChannel(c);
}

// Memilih video dari channel berdasarkan kata di judulnya (hasil disimpan 6 jam, atau dipindai ulang saat "Run workflow").
async function autoVideoIds() {
  const rules = cfg.autoVideos || [];
  if (!rules.length) return [];
  const file = path.join(D, "auto_videos.json");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* belum ada */ }
  const force = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const out = [];
  for (const rule of rules) {
    const key = JSON.stringify(rule), c = cache[key];
    if (c && !force && now - c.at < 6 * 3600e3) { out.push(...c.ids); continue; }
    try {
      const m = String(rule.channel || "").match(/UC[\w-]{22}/);
      const chId = m ? m[0] : (await channel(rule.channel)).id;
      const inc = (rule.include || ["M/V"]).map((x) => x.toLowerCase());
      const exc = (rule.exclude || []).map((x) => x.toLowerCase());
      const max = rule.max || 30, ids = [];
      let token = "";
      for (let page = 0; page < (rule.scanPages || 20) && ids.length < max; page++) {
        const params = { part: "snippet", playlistId: "UU" + chId.slice(2), maxResults: 50 };
        if (token) params.pageToken = token;
        const j = await yt("playlistItems", params);
        (j.items || []).forEach((it) => {
          const t = (it.snippet.title || "").toLowerCase();
          if (inc.some((x) => t.includes(x)) && !exc.some((x) => t.includes(x)) && !JUNK.test(t)) ids.push(it.snippet.resourceId.videoId);
        });
        token = j.nextPageToken;
        if (!token) break;
      }
      const cut = ids.slice(0, max);
      cache[key] = { at: now, ids: cut };
      out.push(...cut);
      console.log("Video otomatis dari " + rule.channel + ": " + cut.length);
    } catch (e) {
      failed++; console.log("::warning::Video otomatis gagal: " + e.message);
      if (c) out.push(...c.ids);
    }
  }
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  return out;
}

// ================= Spotify =================
// config.json: "spotify": { "artists": ["<ID/URL artis>", ...] }
// - Ringkasan artis (nama, foto, pengikut, pendengar bulanan): queryArtistOverview web player
//   (token anonim TOTP; metode tidak resmi, bisa berubah). Token resmi (SPOTIFY_CLIENT_ID &
//   SPOTIFY_CLIENT_SECRET di GitHub Secrets) dipakai sebagai cadangan bila jalur web player gagal.
// - Jumlah putar per lagu: getAlbum web player per album (semua lagu + playcount).
// - Pasangan video YouTube → lagu Spotify dicocokkan otomatis dari judul, disimpan di spotify.json.
// - Frekuensi: maksimal tiap 30 menit (menit UTC 2 & 32) atau saat "Run workflow", agar sopan ke Spotify.
const SP_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36", Origin: "https://open.spotify.com", Referer: "https://open.spotify.com/" };
const SP_MAX_ALBUMS = Number(process.env.SP_MAX_ALBUMS || 40); // album disampling bergantian tiap giliran
let spTok = null, spOpsRetried = false;

function spIdOf(s, kind) {
  s = String(s || "");
  const m = s.match(new RegExp("/" + kind + "/([A-Za-z0-9]{22})"));
  if (m) return m[1];
  return /^[A-Za-z0-9]{22}$/.test(s.trim()) ? s.trim() : null;
}
let spCache = null;
function spCacheLoad() {
  if (spCache) return spCache;
  try { spCache = JSON.parse(fs.readFileSync(path.join(D, "spotify_cache.json"), "utf8")); } catch (e) { spCache = {}; }
  return spCache;
}
function spCacheSave() { try { fs.writeFileSync(path.join(D, "spotify_cache.json"), JSON.stringify(spCache, null, 2)); } catch (e) { /* abaikan */ } }

async function spAnonToken() {
  // Secret TOTP diambil dari repo terbuka yang mengikuti versi terbaru Spotify, lalu di-decode (XOR).
  const raw = JSON.parse(await (await fetch("https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretBytes.json")).text());
  const last = raw[raw.length - 1];
  const secret = Buffer.from(last.secret.map((v, i) => v ^ ((i % 33) + 9)).join(""), "ascii");
  const st = await (await fetch("https://open.spotify.com/api/server-time", { headers: SP_UA })).json();
  const ms = st.serverTime * 1000;
  const counter = Math.floor(ms / 1000 / 30);
  const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(counter / 2 ** 32), 0); b.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac("sha1", secret).update(b).digest();
  const off = h[h.length - 1] & 0xf;
  const totp = String(((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6).padStart(6, "0");
  const u = new URL("https://open.spotify.com/api/token");
  u.searchParams.set("reason", "init"); u.searchParams.set("productType", "mobile-web-player");
  u.searchParams.set("ts", String(ms)); u.searchParams.set("totp", totp); u.searchParams.set("totpVer", String(last.version));
  const j = await (await fetch(u, { headers: SP_UA })).json();
  if (!j.accessToken) throw new Error("token anonim Spotify gagal: " + JSON.stringify(j).slice(0, 140));
  return j.accessToken;
}

async function spResolveOps() {
  // Hash operasi pathfinder diambil dari bundle JavaScript web player (dipakai situs statistik umumnya).
  const html = await (await fetch("https://open.spotify.com/", { headers: SP_UA })).text();
  const src = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
    .find((s) => s.endsWith(".js") && (s.includes("/web-player/") || s.includes("/mobile-web-player/")));
  if (!src) throw new Error("bundle web player Spotify tidak ditemukan");
  const js = await (await fetch(src, { headers: SP_UA })).text();
  const ops = {};
  for (const op of ["getAlbum", "queryArtistOverview"]) {
    let m = new RegExp(op + "[\\s\\S]{0,400}?sha256Hash\":\"([a-f0-9]{64})\"").exec(js);
    if (!m) m = new RegExp('"' + op + '","(?:query|mutation)","([a-f0-9]{64})"').exec(js);
    if (m) ops[op] = m[1];
  }
  if (!ops.getAlbum || !ops.queryArtistOverview) throw new Error("hash operasi pathfinder tidak lengkap: " + JSON.stringify(ops));
  return ops;
}

async function spPf(op, variables) {
  const c = spCacheLoad();
  if (!c.ops || !c.ops[op]) { c.ops = await spResolveOps(); c.opsAt = now; spCacheSave(); }
  const call = async () => {
    const u = "https://api-partner.spotify.com/pathfinder/v1/query?operationName=" + op +
      "&variables=" + encodeURIComponent(JSON.stringify(variables)) +
      "&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: c.ops[op] } }));
    const r = await fetch(u, { headers: { ...SP_UA, Authorization: "Bearer " + spTok } });
    const j = await r.json().catch(() => null);
    if (!j || j.errors) throw new Error(op + ": " + (j && j.errors ? JSON.stringify(j.errors).slice(0, 160) : "HTTP " + r.status));
    return j.data;
  };
  try { return await call(); }
  catch (e) {
    if (spOpsRetried) throw e; // hash sudah dicoba diganti sekali run ini; serah ke penanganan di atas
    spOpsRetried = true;
    c.ops = await spResolveOps(); c.opsAt = now; spCacheSave();
    return await call();
  }
}

function spNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, ""); }
function spTokens(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").split(" ").filter(Boolean); }

// Mencocokkan judul video YouTube dengan judul lagu Spotify (angka 0-1).
function spMatch(video, tracks) {
  const t = String(video.title || "");
  const parts = t.split(/\s+[-–—]\s+|\s+:\s+/);
  const core = parts.slice(1).join(" - ") || t;
  const quotes = [...core.matchAll(/['‘’"`“”]([^'‘’"`“”]{2,80})['‘’"`“”]/g)].map((m) => m[1]);
  // isi kurung juga kandidat: judul YouTube "미쳐가네(Going Crazy)" vs judul Spotify "GOING CRAZY"
  const parens = [...core.matchAll(/\(([^()]{2,80})\)/g)].map((m) => m[1].replace(/\b(ver\.?|version)\b/gi, " ").replace(/\s+/g, " ").trim());
  const strip = (x) => x.replace(/\(([^()]*)\)/g, " ").replace(/\b(m\/?v|mv|performance|dance|practice|special|exclusive|video|film|debut|remix|ver\.?|version|white|horizon|halloween|space set|4k|emoji|vlog|solo)\b/gi, " ").replace(/\s+/g, " ").trim();
  const cand = [...quotes, ...quotes.map(strip), ...parens, strip(core)].filter((x) => x && x.length >= 2);
  const vt = spTokens(video.title + " " + (video.channel || ""));
  let best = null;
  for (const tr of tracks) {
    const tn = spNorm(tr.name), ta = spTokens(tr.artist);
    const gate = ta.some((x) => x && vt.includes(x)) || spTokens(video.channel || "").some((x) => ta.includes(x));
    if (!gate) continue;
    for (const cc of cand) {
      const cn = spNorm(cc);
      if (!cn || cn.length < 2) continue;
      let s = 0;
      if (cn === tn) s = 1;
      else if (tn && (cn.includes(tn) || tn.includes(cn)) && Math.min(cn.length, tn.length) >= 3) s = 0.85;
      else {
        const ct = spTokens(cc), tt = spTokens(tr.name);
        if (ct.length && tt.length) s = ct.filter((x) => tt.includes(x)).length / Math.max(ct.length, tt.length);
      }
      if (s >= 0.85 && (!best || s > best.s)) best = { s, tr };
    }
  }
  return best ? { tid: best.tr.id, name: best.tr.name, artist: best.tr.artist } : null;
}

async function spCollect(artistIds) {
  const c = spCacheLoad();
  spTok = await spAnonToken();
  console.log("Spotify: token anonim OK");

  // Token resmi (opsional) — dipakai untuk daftar album lengkap & cadangan data artis
  let offTok = null;
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET).toString("base64") }, body: "grant_type=client_credentials" });
      const j = await r.json();
      if (j.access_token) offTok = j.access_token; else console.log("::warning::Token resmi Spotify gagal: " + (j.error_description || j.error));
    } catch (e) { console.log("::warning::Token resmi Spotify gagal: " + e.message); }
  }
  const spApi = async (ep) => { const r = await fetch("https://api.spotify.com/v1" + ep, { headers: { Authorization: "Bearer " + offTok } }); const j = await r.json(); if (!r.ok) throw new Error("Spotify API " + ((j.error && j.error.message) || r.status)); return j; };

  // 1) Ringkasan artis + kumpulan album dari diskografi
  const artists = [], albums = new Set(c.albums || []);
  for (const aid of artistIds) {
    try {
      const ov = await spPf("queryArtistOverview", { uri: "spotify:artist:" + aid, locale: "en" });
      const a = ov.artistUnion || {};
      const st = a.stats || {};
      const art = {
        id: aid,
        name: (a.profile && a.profile.name) || "",
        thumb: (((a.visuals || {}).avatarImage || {}).sources || [])[0] ? a.visuals.avatarImage.sources[0].url : "",
        followers: st.followers === undefined ? null : Number(st.followers),
        listeners: st.monthlyListeners === undefined ? null : Number(st.monthlyListeners),
        worldRank: st.worldRank || null,
        cities: (st.topCities && st.topCities.items || []).slice(0, 5).map((x) => ({ city: x.city, country: x.country, listeners: x.numberOfListeners })),
      };
      const disc = (a.discography || {});
      ["albums", "singles"].forEach((k) => ((disc[k] || {}).items || []).forEach((d) => ((d.releases || {}).items || []).forEach((r) => { if (r.id) albums.add(r.id); })));
      artists.push(art);
      console.log("Spotify artis: " + art.name + " | pengikut: " + art.followers + " | pendengar bulanan: " + art.listeners + " | album diketahui: " + albums.size);
    } catch (e) { console.log("::warning::Artis Spotify gagal (" + aid + "): " + e.message); }
  }
  if (!artists.length) throw new Error("tidak ada ringkasan artis yang berhasil");

  // 1b) Daftar album lengkap lewat API resmi (sekali per 24 jam; tanpa ini album lama bisa luput
  //     karena diskografi di halaman artis hanya menampilkan sebagian)
  if (offTok && (!c.albumsOfficialAt || now - c.albumsOfficialAt > 24 * 3600e3)) {
    for (const aid of artistIds) {
      for (let off = 0; off < 150; off += 50) {
        try {
          const j = await spApi("/artists/" + aid + "/albums?include_groups=album,single&limit=50&offset=" + off);
          (j.items || []).forEach((x) => { if (x.id) albums.add(x.id); });
          if (!j.items || j.items.length < 50) break;
        } catch (e) { console.log("::warning::Daftar album resmi gagal (" + aid + "): " + e.message); break; }
      }
    }
    c.albumsOfficialAt = now;
    console.log("Spotify: total album diketahui " + albums.size + " (termasuk daftar resmi)");
  }

  // 2) Sampling album bergantian (round-robin) supaya semua album tercakup tanpa membebani Spotify
  const list = c.albums, rr = Number(c.rr || 0) % Math.max(1, list.length);
  const batch = [];
  for (let i = 0; i < Math.min(SP_MAX_ALBUMS, list.length); i++) batch.push(list[(rr + i) % list.length]);
  c.rr = (rr + batch.length) % Math.max(1, list.length);

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(D, "spotify.json"), "utf8")); } catch (e) { /* belum ada */ }
  const merged = {};
  ((prev || {}).tracks || []).forEach((t) => { merged[t.id] = t; });

  let sampled = 0;
  for (const albId of batch) {
    try {
      const d = await spPf("getAlbum", { uri: "spotify:album:" + albId, locale: "en", offset: 0, limit: 50 });
      const al = d.albumUnion || {};
      const img = (((al.coverArt || {}).sources || [])[0] || {}).url || "";
      const an = (((al.artists || {}).items || []).map((x) => x.profile.name)).join(", ");
      const items = ((al.tracksV2 || {}).items || []);
      // sekalian panen album lain dari artis yang sama (membantu menemukan album lama tanpa API resmi)
      ((al.moreAlbumsByArtist || {}).items || []).forEach((x) => {
        ((((x.discography || {}).popularReleasesAlbums || {}).items) || (((x.releases || {}).items) || [])).forEach((r) => { if (r.id) albums.add(r.id); });
      });
      for (const it of items) {
        const t = it.track || {};
        if (t.playcount === undefined || !t.uri) continue;
        const tid = t.uri.split(":").pop();
        const names = ((t.artists || {}).items || []).map((x) => x.profile.name);
        merged[tid] = {
          id: tid, name: t.name || "", artist: names.join(", "),
          album: al.name || "", albumId: albId,
          release: (al.date && (al.date.isoString || al.date.year)) || "",
          thumb: img, streams: Number(t.playcount) || 0,
        };
        sampled++;
      }
    } catch (e) { console.log("::warning::Album Spotify gagal (" + albId + "): " + e.message); }
  }
  c.albums = [...albums];
  spCacheSave();

  // 3) Satu judul lagu bisa ada di beberapa album → tampilkan versi dengan putar terbanyak
  const byKey = {};
  Object.values(merged).forEach((t) => {
    const k = spNorm(String(t.artist || "").split(",")[0]) + "|" + spNorm(t.name);
    const o = byKey[k];
    if (!o || t.streams > o.streams) byKey[k] = t;
  });
  const tracks = Object.values(byKey).sort((a, b) => b.streams - a.streams);

  // 4) Pasangkan video YouTube → lagu Spotify
  let vids = [];
  try { vids = JSON.parse(fs.readFileSync(path.join(D, "videos.json"), "utf8")); } catch (e) { /* belum ada */ }
  const videos = {};
  vids.forEach((v) => { const m = spMatch(v, tracks); if (m) videos[v.id] = m; });

  // 5) Simpan sampel riwayat + snapshot terkini
  const lines = [];
  Object.values(merged).forEach((t) => { if (t.streams) lines.push(JSON.stringify({ id: t.id, t: now, s: t.streams })); });
  artists.forEach((a) => { if (a.followers != null || a.listeners != null) lines.push(JSON.stringify({ id: "ar:" + a.id, t: now, f: a.followers, m: a.listeners })); });
  if (lines.length) fs.appendFileSync(path.join(D, "spotify_samples.jsonl"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(D, "spotify.json"), JSON.stringify({ updated: now, artists, tracks, videos }));
  console.log("Spotify tercatat: " + lines.length + " sampel | " + tracks.length + " lagu | " + sampled + " disampling run ini | " + Object.keys(videos).length + "/" + vids.length + " video terhubung");
}

(async () => {
  // ----- Video -----
  const autoIds = await autoVideoIds();
  const ids = [...new Set([...(cfg.videos || []).map(videoId), ...autoIds].filter(Boolean))];
  if (ids.length) {
    try {
      const metas = [], lines = [];
      for (let i = 0; i < ids.length; i += 50) {
        const j = await yt("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") });
        (j.items || []).forEach((v) => {
          const dur = durS(v.contentDetails && v.contentDetails.duration);
          if (MIN_DUR && dur !== null && dur < MIN_DUR) return; // lewati video terlalu pendek (mis. Shorts)
          const n = (k) => (v.statistics[k] === undefined ? null : Number(v.statistics[k]));
          metas.push({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, publishedAt: v.snippet.publishedAt || "",
            thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default).url });
          lines.push(JSON.stringify({ id: v.id, t: now, v: Number(v.statistics.viewCount || 0), l: n("likeCount"), c: n("commentCount") }));
        });
      }
      metas.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      if (lines.length) {
        fs.appendFileSync(path.join(D, "samples.jsonl"), lines.join("\n") + "\n");
        fs.writeFileSync(path.join(D, "videos.json"), JSON.stringify(metas, null, 2));
      }
      recorded += lines.length;
      console.log("Video tercatat:", lines.length + "/" + ids.length);
    } catch (e) { failed++; console.log("::warning::Video gagal: " + e.message); }
  }
  // ----- Channel -----
  const metas = [], lines = [];
  for (const input of cfg.channels || []) {
    try {
      const c = await channel(input);
      if (metas.some((m) => m.id === c.id)) continue;
      metas.push({ id: c.id, title: c.title, handle: c.handle, thumb: c.thumb });
      lines.push(JSON.stringify({ id: c.id, t: now, s: c.subs, v: c.views, n: c.videos }));
    } catch (e) { failed++; console.log("::warning::Channel gagal: " + e.message); }
  }
  if (lines.length) {
    fs.appendFileSync(path.join(D, "channel_samples.jsonl"), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(D, "channels.json"), JSON.stringify(metas, null, 2));
  }
  recorded += lines.length;
  console.log("Channel tercatat:", lines.length + "/" + (cfg.channels || []).length);
  // ----- Spotify (opsional) -----
  const SPC = cfg.spotify || {};
  const spIds = [...new Set((SPC.artists || []).map((s) => spIdOf(s, "artist")).filter(Boolean))];
  const spFile = path.join(D, "spotify.json");
  const spDue = process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ||
    new Date(now).getUTCMinutes() % 30 < 5 || !fs.existsSync(spFile);
  if (spIds.length && spDue) {
    try { await spCollect(spIds); }
    catch (e) { console.log("::warning::Spotify dilewati: " + e.message); }
  } else if (spIds.length) {
    console.log("Spotify: bukan giliran sampling (maksimal tiap 30 menit), dilewati run ini.");
  }
  if (failed && !recorded) process.exit(1); // gagal total; kalau sebagian berhasil, datanya tetap disimpan
})();
