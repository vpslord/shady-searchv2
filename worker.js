// وسيط بسيط بيستقبل الرسالة من موقعك ويبعتها لتليجرام بالنيابة عنه
// (تليجرام مش بيسمح للمتصفح يكلمه مباشرة، فمحتاجين الوسيط ده)

const BOT_TOKEN = '8834084269:AAEhGxoq2eO81pK_mZRAXY53t2Bg7rS3akk';
const CHAT_ID = '8779630036';

export default {
  async fetch(request) {
    // السماح لأي موقع يكلم الوسيط ده (CORS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
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
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
