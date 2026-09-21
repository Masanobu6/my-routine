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
 *   GET/PUT/DELETE /img/<id> … タスクの表紙画像（あいことばが要る）
 *                   データ本体には画像のIDだけを持たせ、中身はここに別に置く
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
const IMG_MAX = 1.5 * 1024 * 1024;   // 画像1枚の上限。アプリ側で縮めてから送る

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-key,x-token',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const reply = (body, status, extra) =>
  new Response(body, {status, headers:Object.assign({}, cors, extra)});
const json = (obj, status) =>
  reply(typeof obj === 'string' ? obj : JSON.stringify(obj), status || 200,
        {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});

/* ---- Google の身分証（IDトークン）を確かめる ----
   署名を Google の公開鍵で検証し、宛先（aud）と有効期限と発行元を見る。
   通ったら、その端末だけの長い合鍵を発行して KV に置く。            */
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const b64url = str => {
  const s2 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s2 + '==='.slice((s2.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64json = str => JSON.parse(new TextDecoder().decode(b64url(str)));

async function verifyGoogle(idToken, clientId){
  const parts = String(idToken || '').split('.');
  if(parts.length !== 3) return null;
  let head, body;
  try {
    head = b64json(parts[0]);
    body = b64json(parts[1]);
  } catch(e){ return null; }      // 形が壊れているものは、ここで捨てる
  if(!head || !body) return null;
  const certs = await fetch(GOOGLE_JWKS).then(r => r.json());
  const jwk = (certs.keys || []).find(k => k.kid === head.kid);
  if(!jwk) return null;
  const key = await crypto.subtle.importKey('jwk',
    {kty:jwk.kty, n:jwk.n, e:jwk.e, alg:'RS256', ext:true},
    {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['verify']);
  const okSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if(!okSig) return null;
  if(body.aud !== clientId) return null;
  if(body.iss !== 'accounts.google.com' && body.iss !== 'https://accounts.google.com') return null;
  if((body.exp || 0) * 1000 < Date.now()) return null;
  if(body.email_verified === false) return null;
  return body;
}

const countRecords = d =>
  ['logs','spots','exercises','menus','rewards','redemptions']
    .reduce((n,k) => n + (Array.isArray(d && d[k]) ? d[k].length : 0), 0);

export default {
  async fetch(req, env){
    if(req.method === 'OPTIONS') return reply(null, 204);
    if(!env.WRITE_KEY) return reply('あいことばが未設定', 500);

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let ok = safeEqual(req.headers.get('x-key') || '', env.WRITE_KEY);
    let who = ok ? 'あいことば' : null;
    const tok = req.headers.get('x-token');
    if(!ok && tok){
      const rec = JSON.parse(await env.RECORDS.get('tok:' + tok) || 'null');
      if(rec){ ok = true; who = rec.email; }
    }

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

    /* ---- Google で入る ---- */
    if(path === '/auth/google' && req.method === 'POST'){
      if(!env.GOOGLE_CLIENT_ID) return json({error:'Googleログインは未設定です'}, 501);
      let body; try { body = await req.json(); } catch(e){ return json({error:'読めません'}, 400); }
      let claims = null;
      try { claims = await verifyGoogle(body.idToken, env.GOOGLE_CLIENT_ID); }
      catch(e){ return json({error:'確認中に問題が起きました'}, 401); }
      if(!claims) return json({error:'Googleの身分証を確認できませんでした'}, 401);
      const allow = (env.ALLOW_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
      if(allow.length && allow.indexOf(claims.email) < 0)
        return json({error:'このアカウントは許可されていません（' + claims.email + '）'}, 403);
      const token = crypto.randomUUID() + '-' + crypto.randomUUID();
      await env.RECORDS.put('tok:' + token,
        JSON.stringify({email:claims.email, name:claims.name || '', at:Date.now()}));
      return json({token, email:claims.email, name:claims.name || ''});
    }
    if(path === '/auth/me' && req.method === 'GET'){
      if(!ok) return json({error:'入っていません'}, 403);
      return json({who});
    }

    /* ---- ここから先はすべて、あいことばか端末トークンが要る ---- */
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

    /* ---- 表紙画像 ---- */
    const im = path.match(/^\/img\/([A-Za-z0-9_-]{8,80})$/);
    if(im){
      const key = 'img:' + im[1];
      if(req.method === 'GET'){
        const got = await env.RECORDS.getWithMetadata(key, 'arrayBuffer');
        if(!got || !got.value) return reply('その画像はありません', 404);
        return reply(got.value, 200, {
          'content-type':(got.metadata && got.metadata.type) || 'image/jpeg',
          'cache-control':'private, max-age=31536000, immutable'});
      }
      if(req.method === 'PUT'){
        const type = (req.headers.get('content-type') || '').split(';')[0].trim();
        if(!/^image\/(jpeg|png|webp)$/.test(type)) return reply('画像ではない', 415);
        const buf = await req.arrayBuffer();
        if(buf.byteLength > IMG_MAX) return reply('大きすぎる', 413);
        await env.RECORDS.put(key, buf, {metadata:{type}});
        return json({ok:true});
      }
      if(req.method === 'DELETE'){
        await env.RECORDS.delete(key);
        return json({ok:true});
      }
      return reply('だめ', 405);
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
