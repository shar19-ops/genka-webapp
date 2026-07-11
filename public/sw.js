// PWAとしてインストール可能にする（ファイルハンドラ機能に必要）ための最小限のService Worker。
// キャッシュ戦略は持たず、すべてのリクエストをそのままネットワークへ通す（更新が常に反映されるように）。
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
