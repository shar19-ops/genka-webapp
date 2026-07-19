const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5173;

// 静的ファイル配信（pdf.js本体・cmapsも public/vendor/pdfjs 配下に物理コピー済み。
// GitHub Pagesなどの静的ホスティングでもそのまま動くよう、node_modulesからの動的配信はしない）
app.use(express.static(path.join(__dirname, 'public')));

// 任意URLのPDFを取得するプロキシ（ブラウザ単体だとCORSで弾かれるURLに対応するため）
app.get('/api/fetch-pdf', (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'url パラメータが必要です' });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'URLの形式が不正です' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'http/https のURLのみ対応しています' });
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const request = client.get(parsed, { headers: { 'User-Agent': 'genka-webapp/1.0' } }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      // 簡易リダイレクト追従（1回のみ）
      const redirectUrl = new URL(upstream.headers.location, parsed);
      const redirectClient = redirectUrl.protocol === 'https:' ? https : http;
      redirectClient.get(redirectUrl, { headers: { 'User-Agent': 'genka-webapp/1.0' } }, (upstream2) => {
        pipeUpstream(upstream2, res);
      }).on('error', (err) => res.status(502).json({ error: '取得に失敗しました: ' + err.message }));
      return;
    }
    pipeUpstream(upstream, res);
  });
  request.on('error', (err) => {
    res.status(502).json({ error: '取得に失敗しました: ' + err.message });
  });
  request.setTimeout(20000, () => request.destroy());
});

function pipeUpstream(upstream, res) {
  if (upstream.statusCode !== 200) {
    res.status(502).json({ error: `取得元がエラーを返しました (HTTP ${upstream.statusCode})` });
    upstream.resume();
    return;
  }
  res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/pdf');
  upstream.pipe(res);
}

app.listen(PORT, () => {
  console.log(`原価計算書アプリ起動: http://localhost:${PORT}`);
});
