// Dijalankan oleh GitHub Actions (Node 20, tanpa dependensi).
// Membaca config.json, mengambil angka dari YouTube, lalu menambahkannya ke folder data.
const fs = require("fs");
const path = require("path");
const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) { console.error("YOUTUBE_API_KEY belum diisi di GitHub Secrets."); process.exit(1); }
const D = path.join(__dirname, "data");
fs.mkdirSync(D, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const now = Date.now();
let failed = 0;

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
  if (/^https?:\/\//i.test(s) || /^(www\.)?youtube\.com\//i.test(s)) {
    const u = new URL(/^https?:/i.test(s) ? s : "https://" + s);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "channel") val = parts[1];
    else if (parts[0] && parts[0][0] === "@") val = parts[0];
    else if (parts[0] === "user") { params.forUsername = parts[1]; val = null; }
    else throw new Error("Tautan channel belum dikenali: " + s + " (pakai @handle atau tautan /channel/UC...)");
  }
  if (val) {
    if (/^UC[\w-]{22}$/.test(val)) params.id = val;
    else params.forHandle = val[0] === "@" ? val : "@" + val;
  }
  const json = await yt("channels", params);
  const c = json.items && json.items[0];
  if (!c) throw new Error("Channel tidak ditemukan: " + s);
  return mapChannel(c);
}

(async () => {
  // ----- Video -----
  const ids = [...new Set((cfg.videos || []).map(videoId).filter(Boolean))];
  if (ids.length) {
    try {
      const metas = [], lines = [];
      for (let i = 0; i < ids.length; i += 50) {
        const j = await yt("videos", { part: "snippet,statistics", id: ids.slice(i, i + 50).join(",") });
        (j.items || []).forEach((v) => {
          const n = (k) => (v.statistics[k] === undefined ? null : Number(v.statistics[k]));
          metas.push({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle,
            thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default).url });
          lines.push(JSON.stringify({ id: v.id, t: now, v: Number(v.statistics.viewCount || 0), l: n("likeCount"), c: n("commentCount") }));
        });
      }
      metas.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      if (lines.length) {
        fs.appendFileSync(path.join(D, "samples.jsonl"), lines.join("\n") + "\n");
        fs.writeFileSync(path.join(D, "videos.json"), JSON.stringify(metas, null, 2));
      }
      console.log("Video tercatat:", lines.length + "/" + ids.length);
    } catch (e) { failed++; console.error("Video gagal:", e.message); }
  }
  // ----- Channel -----
  const metas = [], lines = [];
  for (const input of cfg.channels || []) {
    try {
      const c = await channel(input);
      if (metas.some((m) => m.id === c.id)) continue;
      metas.push({ id: c.id, title: c.title, handle: c.handle, thumb: c.thumb });
      lines.push(JSON.stringify({ id: c.id, t: now, s: c.subs, v: c.views, n: c.videos }));
    } catch (e) { failed++; console.error("Channel gagal:", e.message); }
  }
  if (lines.length) {
    fs.appendFileSync(path.join(D, "channel_samples.jsonl"), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(D, "channels.json"), JSON.stringify(metas, null, 2));
  }
  console.log("Channel tercatat:", lines.length + "/" + (cfg.channels || []).length);
  if (failed) process.exit(1);
})();
