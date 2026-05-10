const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY;
const PORT = process.env.PORT || 3000;

// 語言 fallback 順序（優先繁中 → 簡中 → 英）
const LANG_FALLBACK = ['zh-TW', 'zh-Hant', 'zh-Hans', 'zh', 'en'];

// 從 URL 或 ID 擷取 video ID
function extractVideoId(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1);
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}

// 取字幕（含自動 fallback）
async function fetchTranscriptWithFallback(videoId, preferredLang) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const langsToTry = preferredLang
    ? [preferredLang, ...LANG_FALLBACK.filter(l => l !== preferredLang)]
    : LANG_FALLBACK;

  let lastError = null;

  for (const lang of langsToTry) {
    try {
      const res = await axios.get('https://api.supadata.ai/v1/youtube/transcript', {
        headers: { 'x-api-key': SUPADATA_API_KEY },
        params: { url: videoUrl, lang, text: true },
      });

      const data = res.data;
      const text = typeof data.content === 'string'
        ? data.content
        : (data.content ?? []).map(s => s.text).join(' ');

      return {
        videoId,
        lang: data.lang ?? lang,
        availableLangs: data.availableLangs ?? [],
        text,
      };
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const errMsg = err.response?.data?.message ?? '';

      // 字幕不存在此語言 → 繼續嘗試下一個
      if (status === 404 || errMsg.includes('not available') || errMsg.includes('language')) continue;

      // 其他錯誤（quota、網路等）直接拋出
      throw new Error(err.response?.data?.message ?? err.message);
    }
  }

  // 所有語言都失敗 → 嘗試不指定語言讓 Supadata 自動選
  try {
    const res = await axios.get('https://api.supadata.ai/v1/youtube/transcript', {
      headers: { 'x-api-key': SUPADATA_API_KEY },
      params: { url: videoUrl, text: true },
    });
    const data = res.data;
    const text = typeof data.content === 'string'
      ? data.content
      : (data.content ?? []).map(s => s.text).join(' ');

    return {
      videoId,
      lang: data.lang ?? 'auto',
      availableLangs: data.availableLangs ?? [],
      text,
      note: 'auto-selected language',
    };
  } catch (err) {
    throw new Error(err.response?.data?.message ?? lastError?.message ?? '無法取得字幕');
  }
}

// ─── API 1：關鍵字搜尋 ───────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, maxResults = 10, regionCode = 'TW', order = 'relevance', videoDuration = 'any' } = req.body;

  if (!query) return res.status(400).json({ error: '缺少 query 參數' });

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'snippet',
        q: query,
        type: 'video',
        maxResults,
        regionCode,
        order,
        videoDuration,
      },
    });

    const items = response.data.items.map(item => ({
      videoId: item.id.videoId,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url,
    }));

    res.json({ query, total: items.length, items });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// ─── API 2：取字幕 ────────────────────────────────────────────
app.post('/api/transcript', async (req, res) => {
  const { url, lang } = req.body;

  if (!url) return res.status(400).json({ error: '缺少 url 參數' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: '無效的 YouTube URL 或 video ID' });

  try {
    const result = await fetchTranscriptWithFallback(videoId, lang);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── 健康檢查 ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`yt-api running on port ${PORT}`);
});
