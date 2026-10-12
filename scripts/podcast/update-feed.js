#!/usr/bin/env node

// ============================================================================
// Follow Builders — Update Podcast RSS Feed
// ============================================================================
// Adds one episode to the site directory (the gh-pages checkout) and rewrites
// feed.xml. Also records which feed items the episode covered so the next
// episode skips them.
//
// Usage:
//   node update-feed.js --site <dir> --episode <episode.json>
//     --audio-url <url> --audio-bytes <n> --base-url <https://.../>
//   node update-feed.js --site <dir> --base-url <https://.../> --rebuild
//     (re-render feed.xml from episodes.json, e.g. after renaming the show)
//
// Site files: episodes.json (episode list), state.json (covered item keys),
// cover.jpg (artwork), feed.xml (generated).
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SHOW = {
  title: 'AI 实干派',
  author: 'AI 实干派',
  description: '每天十分钟，听懂 AI 一线 builder 在 X、播客和官方博客上说了什么。由 follow-builders 自动生成。',
  language: 'zh-cn'
};
const MAX_EPISODES = 60;   // episodes kept in the feed
const MAX_SEEN = 5000;     // covered item keys kept in state.json

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(await readFile(path, 'utf-8')) : fallback;
}

function hms(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function renderFeed(episodes, baseUrl) {
  const items = episodes.map((ep) => {
    const notes = `<p>${esc(ep.summary)}</p><ul>${ep.sources
      .map((s) => `<li><a href="${esc(s.url)}">${esc(s.label)}</a></li>`).join('')}</ul>`;
    return `    <item>
      <title>${esc(`${ep.date} · ${ep.title}`)}</title>
      <description>${esc(ep.summary)}</description>
      <content:encoded><![CDATA[${notes.replace(/]]>/g, ']]&gt;')}]]></content:encoded>
      <enclosure url="${esc(ep.audioUrl)}" length="${ep.audioBytes}" type="audio/mpeg"/>
      <guid isPermaLink="false">follow-builders-${ep.date}</guid>
      <pubDate>${new Date(ep.publishedAt).toUTCString()}</pubDate>
      <itunes:duration>${hms(ep.duration)}</itunes:duration>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SHOW.title)}</title>
    <link>${esc(baseUrl)}</link>
    <atom:link href="${esc(baseUrl)}feed.xml" rel="self" type="application/rss+xml"/>
    <description>${esc(SHOW.description)}</description>
    <language>${SHOW.language}</language>
    <itunes:author>${esc(SHOW.author)}</itunes:author>
    <itunes:image href="${esc(baseUrl)}cover.jpg"/>
    <image><url>${esc(baseUrl)}cover.jpg</url><title>${esc(SHOW.title)}</title><link>${esc(baseUrl)}</link></image>
    <itunes:category text="Technology"/>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
${items}
  </channel>
</rss>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rebuild = process.argv.includes('--rebuild');
  const required = rebuild ? ['site', 'base-url'] : ['site', 'episode', 'audio-url', 'audio-bytes', 'base-url'];
  for (const key of required) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  const baseUrl = args['base-url'].endsWith('/') ? args['base-url'] : `${args['base-url']}/`;

  if (rebuild) {
    const episodes = await readJson(join(args.site, 'episodes.json'), []);
    await writeFile(join(args.site, 'feed.xml'), renderFeed(episodes, baseUrl));
    console.error(`Feed rebuilt: ${episodes.length} episodes`);
    return;
  }
  const meta = JSON.parse(await readFile(args.episode, 'utf-8'));
  if (meta.skip) throw new Error('episode.json is a skip marker; nothing to publish');

  const episodesPath = join(args.site, 'episodes.json');
  const statePath = join(args.site, 'state.json');
  const episodes = await readJson(episodesPath, []);
  const state = await readJson(statePath, { seen: [] });

  const episode = {
    date: meta.date,
    title: meta.title,
    summary: meta.summary,
    sources: meta.sources,
    duration: meta.duration,
    audioUrl: args['audio-url'],
    audioBytes: Number(args['audio-bytes']),
    publishedAt: new Date().toISOString()
  };
  // Re-running the same day replaces that day's episode.
  const kept = episodes.filter((ep) => ep.date !== episode.date);
  const next = [episode, ...kept].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_EPISODES);

  state.seen = [...new Set([...meta.seenKeys, ...state.seen])].slice(0, MAX_SEEN);

  await writeFile(episodesPath, JSON.stringify(next, null, 2));
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await writeFile(join(args.site, 'feed.xml'), renderFeed(next, baseUrl));
  console.error(`Feed updated: ${next.length} episodes`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
