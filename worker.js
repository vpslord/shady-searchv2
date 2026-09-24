// وسيط بسيط بيعمل حاجتين للموقع:
// 1) يبعت إشعارات تليجرام بالنيابة عن الموقع (تليجرام مش بيسمح للمتصفح
//    يكلمه مباشرة).
// 2) يبحث عن العناوين على الخريطة بالنيابة عن الموقع (Nominatim برضو
//    مش بيسمح للمتصفح يكلمه مباشرة من غير Referer صحيح).

const BOT_TOKEN = '8834084269:AAEhGxoq2eO81pK_mZRAXY53t2Bg7rS3akk';
const CHAT_ID = '8779630036';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // -------------------- البحث عن عنوان على الخريطة --------------------
    if (url.pathname === '/geocode' && request.method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q) {
        return new Response(JSON.stringify({ error: 'missing q' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      try {
        const nominatimUrl =
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=eg&q=${encodeURIComponent(q)}`;
        const resp = await fetch(nominatimUrl, {
          headers: {
            'User-Agent': 'ShadySearchApp/1.0 (personal use, contact via telegram bot)',
            'Referer': 'https://shady-search.pages.dev',
          },
        });
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // -------------------- إشعار تليجرام --------------------
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    try {
      const { text } = await request.json();
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, text }),
        }
      );
      const data = await tgResponse.json();
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  },
};
