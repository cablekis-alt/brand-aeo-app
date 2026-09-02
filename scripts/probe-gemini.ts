import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const candidates = [
  process.env.GEMINI_MODEL,
  'gemini-3.7-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
].filter((name, i, all): name is string => Boolean(name) && all.indexOf(name) === i);

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY missing (.env 루트를 확인하세요)');
  console.log(`key loaded length=${apiKey.length} prefix=${apiKey.slice(0, 4)}`);

  const ai = new GoogleGenAI({ apiKey });
  for (const model of candidates) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'ping',
        config: { maxOutputTokens: 16 },
      });
      const text = (response.text ?? '').slice(0, 40);
      console.log(`OK ${model} chars=${text.length}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /API_KEY_INVALID|INVALID_ARGUMENT.*key|401|403/.test(message)
        ? 'auth'
        : /404|NOT_FOUND/.test(message)
          ? '404'
          : 'error';
      console.log(`FAIL ${model}: ${code}`);
      if (code === 'auth') {
        console.log(message.slice(0, 180));
        process.exitCode = 1;
        return;
      }
    }
  }
  process.exitCode = 1;
}

void main();
