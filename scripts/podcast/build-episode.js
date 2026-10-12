#!/usr/bin/env node

// ============================================================================
// Follow Builders — Build Daily Podcast Episode
// ============================================================================
// Fetches the central feeds, drops items already covered in earlier episodes,
// asks an OpenAI model to write a spoken Chinese script, synthesizes it with
// OpenAI TTS, and encodes one MP3.
//
// Usage:
//   node build-episode.js --out <dir> [--state <state.json>] [--feeds-dir <dir>]
//
// Env:
//   OPENAI_API_KEY        required
//   PODCAST_SCRIPT_MODEL  default gpt-5.5
//   PODCAST_TTS_MODEL     default gpt-4o-mini-tts-2025-12-15
//   PODCAST_VOICE         default marin
//   PODCAST_TIMEZONE      default America/Los_Angeles
//
// Writes to <dir>: episode.mp3, episode.json (metadata), script.txt.
// If there is nothing new, writes episode.json with { "skip": true } only.
// Requires ffmpeg and ffprobe on PATH.
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

// -- Config ------------------------------------------------------------------

const FEED_BASE = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main';
const FEED_FILES = { x: 'feed-x.json', podcasts: 'feed-podcasts.json', blogs: 'feed-blogs.json' };

const SCRIPT_MODEL = process.env.PODCAST_SCRIPT_MODEL || 'gpt-5.5';
const TTS_MODEL = process.env.PODCAST_TTS_MODEL || 'gpt-4o-mini-tts-2025-12-15';
const VOICE = process.env.PODCAST_VOICE || 'marin';
const TIMEZONE = process.env.PODCAST_TIMEZONE || 'America/Los_Angeles';

const TARGET_MINUTES = 12;
const CHARS_PER_MINUTE = 270;          // typical spoken Mandarin pace
const MAX_TRANSCRIPT_CHARS = 60000;    // per podcast episode sent to the script model
const MAX_TTS_CHUNK_CHARS = 900;       // keeps each TTS request well under the input limit
const SAMPLE_RATE = 24000;             // OpenAI "pcm" format: 24kHz, 16-bit LE, mono
const GAP_SECONDS = 0.35;              // silence inserted between chunks

const TTS_INSTRUCTIONS =
  '用标准普通话播报，语气自然、亲切、像在跟朋友聊天的科技播客主持人。' +
  '语速适中偏快，句间停顿自然。英文人名、公司名、产品名和技术术语用地道的英文发音。';

// -- Helpers -----------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

async function loadFeed(name, feedsDir) {
  if (feedsDir) return JSON.parse(await readFile(join(feedsDir, FEED_FILES[name]), 'utf-8'));
  const res = await fetch(`${FEED_BASE}/${FEED_FILES[name]}`);
  if (!res.ok) throw new Error(`Could not fetch ${FEED_FILES[name]}: HTTP ${res.status}`);
  return res.json();
}

async function openai(path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.openai.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) return res;
    const text = await res.text();
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`OpenAI ${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}

// -- Content selection -------------------------------------------------------

// Each item gets a stable key so the same tweet / episode / post is never
// covered twice, even though the central feed has a multi-day lookback.
function selectNewContent(feeds, seen) {
  const x = feeds.x.x
    .map((builder) => ({ ...builder, tweets: builder.tweets.filter((t) => !seen.has(`x:${t.id}`)) }))
    .filter((builder) => builder.tweets.length > 0);
  const podcasts = feeds.podcasts.podcasts
    .filter((p) => !seen.has(`pod:${p.guid}`))
    .map((p) => ({ ...p, transcript: (p.transcript || '').slice(0, MAX_TRANSCRIPT_CHARS) }));
  const blogs = feeds.blogs.blogs.filter((b) => !seen.has(`blog:${b.url}`));

  const keys = [
    ...x.flatMap((b) => b.tweets.map((t) => `x:${t.id}`)),
    ...podcasts.map((p) => `pod:${p.guid}`),
    ...blogs.map((b) => `blog:${b.url}`)
  ];
  return { content: { x, podcasts, blogs }, keys };
}

// -- Script ------------------------------------------------------------------

async function writeScript(content, date) {
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const template = await readFile(join(scriptDir, '..', '..', 'prompts', 'podcast-script.md'), 'utf-8');
  const prompt = template
    .replaceAll('{{TARGET_CHARS}}', String(TARGET_MINUTES * CHARS_PER_MINUTE))
    .replaceAll('{{TARGET_MINUTES}}', String(TARGET_MINUTES));

  const res = await openai('chat/completions', {
    model: SCRIPT_MODEL,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Today's date: ${date}\n\n${JSON.stringify(content)}` }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'podcast_episode',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'summary', 'script', 'sources'],
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            script: { type: 'string' },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'url'],
                properties: { label: { type: 'string' }, url: { type: 'string' } }
              }
            }
          }
        }
      }
    }
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// -- TTS ---------------------------------------------------------------------

function splitForTts(script) {
  const pieces = [];
  for (const para of script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= MAX_TTS_CHUNK_CHARS) { pieces.push(para); continue; }
    // Oversized paragraph: break after sentence-ending punctuation.
    let buf = '';
    for (const sentence of para.match(/[^。！？!?]+[。！？!?]*/g) || [para]) {
      if (buf && buf.length + sentence.length > MAX_TTS_CHUNK_CHARS) { pieces.push(buf); buf = ''; }
      buf += sentence;
    }
    if (buf) pieces.push(buf);
  }
  // Merge short neighbours so we make fewer requests.
  const chunks = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + piece.length + 2 <= MAX_TTS_CHUNK_CHARS) chunks[chunks.length - 1] = `${last}\n\n${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

async function synthesize(text) {
  // gpt-4o-mini-tts occasionally pads output with long silence; retry once if the
  // audio is far longer than the text could plausibly take to read.
  const expectedSeconds = text.length / (CHARS_PER_MINUTE / 60);
  let pcm;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await openai('audio/speech', {
      model: TTS_MODEL, voice: VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm'
    });
    pcm = Buffer.from(await res.arrayBuffer());
    const seconds = pcm.length / (SAMPLE_RATE * 2);
    if (seconds <= expectedSeconds * 2.5 + 5) break;
    console.error(`  chunk audio ${seconds.toFixed(0)}s vs ~${expectedSeconds.toFixed(0)}s expected, retrying`);
  }
  return pcm;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) throw new Error('--out <dir> is required');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  await mkdir(args.out, { recursive: true });

  const date = todayIn(TIMEZONE);
  const state = args.state && existsSync(args.state) ? JSON.parse(await readFile(args.state, 'utf-8')) : { seen: [] };
  const seen = new Set(state.seen);

  const feeds = {
    x: await loadFeed('x', args['feeds-dir']),
    podcasts: await loadFeed('podcasts', args['feeds-dir']),
    blogs: await loadFeed('blogs', args['feeds-dir'])
  };
  const { content, keys } = selectNewContent(feeds, seen);
  console.error(`${date}: ${content.x.length} builders, ${content.podcasts.length} podcasts, ${content.blogs.length} blogs new`);

  if (keys.length === 0) {
    await writeFile(join(args.out, 'episode.json'), JSON.stringify({ skip: true, date }, null, 2));
    console.error('Nothing new — skipping episode');
    return;
  }

  const episode = await writeScript(content, date);
  await writeFile(join(args.out, 'script.txt'), episode.script);
  console.error(`Script: "${episode.title}", ${episode.script.length} chars`);

  const chunks = splitForTts(episode.script);
  const gap = Buffer.alloc(Math.round(SAMPLE_RATE * GAP_SECONDS) * 2);
  const parts = [];
  for (const [i, chunk] of chunks.entries()) {
    console.error(`TTS ${i + 1}/${chunks.length} (${chunk.length} chars)`);
    parts.push(await synthesize(chunk), gap);
  }
  const pcmPath = join(args.out, 'episode.pcm');
  await writeFile(pcmPath, Buffer.concat(parts));

  // Collapse any leftover long silences, then encode speech-friendly mono MP3.
  const mp3Path = join(args.out, 'episode.mp3');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath,
    '-af', 'silenceremove=stop_periods=-1:stop_duration=1.5:stop_threshold=-50dB:stop_silence=0.6',
    '-c:a', 'libmp3lame', '-b:a', '64k', mp3Path
  ]);
  const duration = Math.round(Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3Path
  ]).toString().trim()));

  const meta = {
    skip: false,
    date,
    title: episode.title,
    summary: episode.summary,
    sources: episode.sources,
    duration,
    scriptModel: SCRIPT_MODEL,
    ttsModel: TTS_MODEL,
    voice: VOICE,
    seenKeys: keys
  };
  await writeFile(join(args.out, 'episode.json'), JSON.stringify(meta, null, 2));
  console.error(`Done: ${mp3Path} (${Math.floor(duration / 60)}m${duration % 60}s)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
