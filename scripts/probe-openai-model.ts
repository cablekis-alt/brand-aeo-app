import 'dotenv/config';
import OpenAI from 'openai';

const candidates = [
  process.env.OPENAI_MODEL,
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
].filter((name, i, all): name is string => Boolean(name) && all.indexOf(name) === i);

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const client = new OpenAI({ apiKey });
  for (const model of candidates) {
    try {
      const response = await client.responses.create({
        model,
        input: 'ping',
        max_output_tokens: 16,
      });
      const text = (response.output_text ?? '').slice(0, 40);
      console.log(`OK ${model} chars=${text.length}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /401/.test(message) ? '401' : /404/.test(message) ? '404' : 'error';
      console.log(`FAIL ${model}: ${code}`);
    }
  }
  process.exitCode = 1;
}

void main();
