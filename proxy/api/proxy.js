module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(204).end();
  }

  const targetUrl = 'https://www.deyecloud.com' + req.url;
  
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': 'application/json, text/plain, */*'
  };

  if (req.headers.authorization) {
    headers['authorization'] = req.headers.authorization;
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers
    });

    const body = await upstreamRes.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');
    res.status(upstreamRes.status).send(body);
  } catch (err) {
    res.status(502).json({ error: 'Proxy upstream error', message: err.message });
  }
};
