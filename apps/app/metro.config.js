const http = require('node:http');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Dev server only: forward /api to the local API, so the app is same-origin in dev just as
// it is behind Caddy in production.
const API_PORT = 3000;

config.server.enhanceMiddleware = (middleware) => (req, res, next) => {
  if (!req.url.startsWith('/api/')) return middleware(req, res, next);
  const upstream = http.request(
    { host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers: req.headers },
    (apiRes) => {
      res.writeHead(apiRes.statusCode, apiRes.headers);
      apiRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502).end();
  });
  req.pipe(upstream);
};

module.exports = config;
