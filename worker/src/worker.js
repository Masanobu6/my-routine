/* 記録のあずかり所（Cloudflare Worker）
 *
 *   GET  /       … ブログに載せる集計を返す。だれでも読める
 *   POST /       … あいことば（x-key）が合っていれば、集計を置きかえる
 *
 *   GET  /data   … アプリのデータ一式を返す。**あいことばが要る**
 *   POST /data   … あいことばが合っていれば、データ一式を置きかえる
 *
 * /data は端末どうしで中身をそろえるためのもの。読むのにも鍵が要る。
 * あいことばは wrangler secret か、ダッシュボードの Secret で入れる。
 */
const EMPTY = '{"generated":"","streak":0,"bestStreak":0,"level":1,"points":0,' +
              '"totalTimes":0,"totalMinutes":0,"cats":[],"days":[]}';
const MAX = 2 * 1024 * 1024;   // 2MB より大きいものは受け取らない

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const reply = (body, status, extra) =>
  new Response(body, {status, headers:Object.assign({}, cors, extra)});
const json = (body, status) =>
  reply(body, status || 200, {'content-type':'application/json; charset=utf-8',
                              'cache-control':'no-store'});

export default {
  async fetch(req, env){
    if(req.method === 'OPTIONS') return reply(null, 204);

    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    const isData = path === '/data';
    const key = isData ? 'appdata' : 'records';

    if(!env.WRITE_KEY) return reply('あいことばが未設定', 500);
    const ok = safeEqual(req.headers.get('x-key') || '', env.WRITE_KEY);

    if(req.method === 'GET'){
      // データ一式は、読むのにもあいことばが要る
      if(isData && !ok) return reply('あいことばが違う', 403);
      const v = await env.RECORDS.get(key);
      if(isData) return json(v || 'null');
      return reply(v || EMPTY, 200, {'content-type':'application/json; charset=utf-8',
                                     'cache-control':'public, max-age=300'});
    }

    if(req.method === 'POST'){
      if(!ok) return reply('あいことばが違う', 403);
      const text = await req.text();
      if(text.length > MAX) return reply('大きすぎる', 413);
      let data;
      try { data = JSON.parse(text); } catch(e){ return reply('JSONとして読めない', 400); }
      if(!data || typeof data !== 'object') return reply('形が違う', 400);
      if(!isData && !Array.isArray(data.days)) return reply('形が違う', 400);
      if(isData && !Array.isArray(data.logs)) return reply('形が違う', 400);

      await env.RECORDS.put(key, text);
      return json(JSON.stringify({ok:true, savedAt:Date.now()}));
    }

    return reply('だめ', 405);
  },
};

function safeEqual(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
