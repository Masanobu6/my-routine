/* 記録のあずかり所（Cloudflare Worker）
 *
 *   GET  /        … ブログに載せる集計。だれでも読める
 *   POST /        … 集計を置きかえる（あいことばが要る）
 *
 *   GET  /data    … アプリのデータ一式（あいことばが要る）
 *                   { version, savedAt, data }
 *   POST /data    … 書きかえる（あいことばが要る）
 *                   body: { baseVersion, data, force? }
 *                   版が食い違えば 409 と最新を返す。呼び手が混ぜて出し直す
 *   GET  /history … 直近の版の一覧（あいことばが要る）
 *   GET  /history?v=3 … その版の中身を返す
 *
 * 大事なのは3つ。
 *   - 版を見ずに上書きできない（409）
 *   - 書くたびに前の版を残す（巻き戻せる）
 *   - records が激減する書き込みは、force が無ければ拒む
 */
const EMPTY_SUM = '{"generated":"","streak":0,"bestStreak":0,"level":1,"points":0,' +
                  '"totalTimes":0,"totalMinutes":0,"cats":[],"days":[]}';
const MAX = 2 * 1024 * 1024;
const KEEP = 20;              // 残す版の数
const SHRINK_LIMIT = 0.5;     // これより減るときは force が要る

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const reply = (body, status, extra) =>
  new Response(body, {status, headers:Object.assign({}, cors, extra)});
const json = (obj, status) =>
  reply(typeof obj === 'string' ? obj : JSON.stringify(obj), status || 200,
        {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});

const countRecords = d =>
  ['logs','spots','exercises','menus','rewards','redemptions']
    .reduce((n,k) => n + (Array.isArray(d && d[k]) ? d[k].length : 0), 0);

export default {
  async fetch(req, env){
    if(req.method === 'OPTIONS') return reply(null, 204);
    if(!env.WRITE_KEY) return reply('あいことばが未設定', 500);

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ok = safeEqual(req.headers.get('x-key') || '', env.WRITE_KEY);

    /* ---- ブログ用の集計 ---- */
    if(path === '/'){
      if(req.method === 'GET'){
        const v = await env.RECORDS.get('records');
        return reply(v || EMPTY_SUM, 200,
          {'content-type':'application/json; charset=utf-8', 'cache-control':'public, max-age=300'});
      }
      if(req.method === 'POST'){
        if(!ok) return reply('あいことばが違う', 403);
        const text = await req.text();
        if(text.length > MAX) return reply('大きすぎる', 413);
        let d; try { d = JSON.parse(text); } catch(e){ return reply('JSONとして読めない', 400); }
        if(!d || !Array.isArray(d.days)) return reply('形が違う', 400);
        await env.RECORDS.put('records', text);
        return json({ok:true});
      }
      return reply('だめ', 405);
    }

    /* ---- ここから先はすべて、あいことばが要る ---- */
    if(!ok) return reply('あいことばが違う', 403);

    /* ---- 版の履歴 ---- */
    if(path === '/history' && req.method === 'GET'){
      const want = url.searchParams.get('v');
      if(want){
        const body = await env.RECORDS.get('hist:' + want);
        return body ? json(body) : reply('その版はありません', 404);
      }
      const list = JSON.parse(await env.RECORDS.get('histlist') || '[]');
      return json({versions:list});
    }

    /* ---- データ一式 ---- */
    if(path === '/data'){
      let cur = JSON.parse(await env.RECORDS.get('appdata') || 'null');
      // 版を持たない古い形式は、版0として読み替える
      if(cur && typeof cur.version !== 'number') cur = {version:0, savedAt:0, data:cur};

      if(req.method === 'GET'){
        return json(cur || {version:0, savedAt:0, data:null});
      }

      if(req.method === 'POST'){
        const text = await req.text();
        if(text.length > MAX) return reply('大きすぎる', 413);
        let body; try { body = JSON.parse(text); } catch(e){ return reply('JSONとして読めない', 400); }
        const data = body && body.data;
        if(!data || !Array.isArray(data.logs)) return reply('形が違う', 400);

        const curVersion = cur ? cur.version : 0;
        const base = Number(body.baseVersion);

        // 版を見ていない書き込みは通さない
        if(!body.force && base !== curVersion){
          return json({conflict:true, version:curVersion, savedAt:cur ? cur.savedAt : 0,
                       data:cur ? cur.data : null}, 409);
        }

        // 急に減る書き込みは止める
        if(!body.force && cur && cur.data){
          const before = countRecords(cur.data), after = countRecords(data);
          if(before >= 5 && after < before * SHRINK_LIMIT){
            return json({refused:'shrink', before, after, version:curVersion,
                         message:'記録が大きく減るので止めました'}, 409);
          }
        }

        const version = curVersion + 1;
        const saved = {version, savedAt:Date.now(), data};

        // 前の版を残す
        if(cur){
          await env.RECORDS.put('hist:' + curVersion, JSON.stringify(cur));
          const list = JSON.parse(await env.RECORDS.get('histlist') || '[]');
          list.unshift({version:curVersion, savedAt:cur.savedAt,
                        records:countRecords(cur.data)});
          const drop = list.splice(KEEP);
          await env.RECORDS.put('histlist', JSON.stringify(list));
          for(const d of drop) await env.RECORDS.delete('hist:' + d.version);
        }

        await env.RECORDS.put('appdata', JSON.stringify(saved));
        return json({ok:true, version, savedAt:saved.savedAt});
      }
      return reply('だめ', 405);
    }

    return reply('そんな場所はありません', 404);
  },
};

function safeEqual(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
