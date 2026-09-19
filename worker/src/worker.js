/* 記録のあずかり所（Cloudflare Worker）
 *
 *   GET  /  … あずかっている JSON を返す。だれでも読める（ブログが読みに来る）
 *   POST /  … あいことば（x-key）が合っていれば、送られてきた JSON で置きかえる
 *
 * あいことばは wrangler secret put WRITE_KEY で入れる。
 * 中身は数字だけで、種目名や作業名は入っていない。
 */
const EMPTY = '{"generated":"","streak":0,"bestStreak":0,"level":1,"points":0,' +
              '"totalTimes":0,"totalMinutes":0,"cats":[],"days":[]}';
const MAX = 300 * 1024;   // 300KB より大きいものは受け取らない

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const reply = (body, status, extra) =>
  new Response(body, {status, headers:Object.assign({}, cors, extra)});

export default {
  async fetch(req, env){
    if(req.method === 'OPTIONS') return reply(null, 204);

    if(req.method === 'GET'){
      const v = await env.RECORDS.get('records');
      return reply(v || EMPTY, 200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
    }

    if(req.method === 'POST'){
      if(!env.WRITE_KEY) return reply('あいことばが未設定', 500);
      const given = req.headers.get('x-key') || '';
      // 長さの違いで中身を当てられないように、一定時間で比べる
      if(!safeEqual(given, env.WRITE_KEY)) return reply('あいことばが違う', 403);

      const text = await req.text();
      if(text.length > MAX) return reply('大きすぎる', 413);
      let data;
      try { data = JSON.parse(text); } catch(e){ return reply('JSONとして読めない', 400); }
      if(!data || !Array.isArray(data.days)) return reply('形が違う', 400);

      await env.RECORDS.put('records', text);
      return reply('ok', 200);
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
