import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { runCommonVoiceHumanReferenceReview, startCommonVoiceReferenceReview } from '../scripts/qualification/common-voice-reference-review-ui.mjs';

const REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASET = { en: 'cmu5jplf300nwmh07iqvk9leo', 'ne-NP': 'cmu61478v00j9o107alzuue1z' };
function clip(locale, number, sentence = `synthetic sentence ${number}`) {
  const clipId = `common_voice_${locale}_${100000 + number}.mp3`;
  const audioBytes = Buffer.from(`synthetic mp3 ${locale} ${number}`);
  return { clipId, sentence, audioBytes, audioSha256: createHash('sha256').update(audioBytes).digest('hex') };
}
function records(locale = 'en') { return Array.from({ length: 24 }, (_, i) => clip(locale, i)); }
function input(rows = records('en'), overrides = {}) {
  const locale = overrides.locale ?? 'en';
  return { locale, sourceDatasetId: DATASET[locale], sourceRevision: REVISION, sourceSplit: 'test', records: rows, ...overrides };
}
function baseUrl(url) { const u = new URL(url); u.pathname = u.pathname.replace(/\/\d+$/u, ''); return u; }
async function postDecision(url, index, decision) {
  const base = baseUrl(url);
  return fetch(`${base.origin}${base.pathname}/decision/${index}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
}
function requestWithHost(url, hostHeader, path = new URL(url).pathname) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: target.port, path, headers: { host: hostHeader } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
    request.end();
  });
}

test('loopback-only server applies privacy headers, advances sequentially and returns aggregates only', async () => {
  const rows = records();
  const audioBuffers = rows.map((record) => record.audioBytes);
  const session = await startCommonVoiceReferenceReview(rows, { locale: 'en' });
  try {
    assert.equal(session.address, '127.0.0.1');
    const first = await fetch(session.url);
    const firstHtml = await first.text();
    assert.equal(first.headers.get('cache-control'), 'no-store, max-age=0');
    assert.match(first.headers.get('content-security-policy'), /default-src 'none'/u);
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.match(firstHtml, /Reviewer must be fluent in the target language/u);
    assert.match(firstHtml, /This tool does not prove reviewer competence/u);
    assert.match(firstHtml, /Responses are a human assessment/u);
    assert.match(firstHtml, /synthetic sentence 0/u);
    assert.doesNotMatch(firstHtml, /synthetic sentence 1|common_voice_en_/u);

    const base = baseUrl(session.url);
    const denied = await requestWithHost(session.url, 'example.com', base.pathname);
    assert.equal(denied.statusCode, 403);
    const audio = await fetch(`${base.origin}${base.pathname}/audio/0`);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), 'synthetic mp3 en 0');

    const firstDecision = await postDecision(session.url, 0, 'match');
    assert.deepEqual(await firstDecision.json(), { counts: { total: 24, match: 1, mismatch: 0, unintelligible: 0, skip: 0 }, complete: false });
    assert.equal((await fetch(`${base.origin}${base.pathname}/audio/0`)).status, 409);
    const second = await fetch(`${base.origin}${base.pathname}/1`);
    const secondHtml = await second.text();
    assert.match(secondHtml, /synthetic sentence 1/u);
    assert.doesNotMatch(secondHtml, /synthetic sentence 0|common_voice_en_/u);
    const staleDecision = await postDecision(session.url, 0, 'skip');
    assert.equal(staleDecision.status, 409);
    const staleAudio = await fetch(`${base.origin}${base.pathname}/audio/0`);
    assert.equal(staleAudio.status, 409);

    for (let i = 1; i < 23; i += 1) assert.equal((await postDecision(session.url, i, 'skip')).status, 200);
    const finalResponse = await postDecision(session.url, 23, 'unintelligible');
    const finalResult = { counts: { total: 24, match: 1, mismatch: 0, unintelligible: 1, skip: 22 }, complete: true };
    assert.deepEqual(await finalResponse.json(), finalResult);
    assert.deepEqual(await session.result, finalResult);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(audioBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true);
    assert.equal(rows.every((record) => record.sentence === '' && record.clipId === ''
      && record.audioSha256 === '' && record.audioBytes.length === 0), true);
    await assert.rejects(fetch(session.url), /fetch failed|ECONNREFUSED/u);
  } finally { await session.close(); }
});

test('hostile transcript is escaped and malformed / invalid choices do not advance', async () => {
  const rows = records('ne-NP');
  rows[0].sentence = '<img src=x onerror=alert(1)> & "quote"';
  const session = await startCommonVoiceReferenceReview(rows, { locale: 'ne-NP' });
  try {
    const html = await (await fetch(session.url)).text();
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quote&quot;/u);
    assert.match(html, /id="sentence" lang="ne-NP"/u);
    assert.match(html, /aria-label="Selected speech clip"/u);
    assert.doesNotMatch(html, /<img src=x/u);
    const invalid = await postDecision(session.url, 0, 'approve');
    assert.equal(invalid.status, 400);
    const base = baseUrl(session.url);
    const malformed = await fetch(`${base.origin}${base.pathname}/decision/0`, { method: 'POST', body: 'nope' });
    assert.equal(malformed.status, 400);
    assert.match(await (await fetch(session.url)).text(), /Clip 1 of 24/u);
  } finally { await session.close(); }
  assert.deepEqual(await session.result, { counts: { total: 24, match: 0, mismatch: 0, unintelligible: 0, skip: 0 }, complete: false });
});

test('coordinator pins source scope and rejects unsupported or altered records before serving', async () => {
  const valid = input();
  for (const bad of [
    { ...valid, sourceSplit: 'dev' },
    { ...valid, sourceRevision: 'arbitrary-revision' },
    { ...valid, locale: 'ar' },
  ]) await assert.rejects(runCommonVoiceHumanReferenceReview(bad), /pinned|locale must/u);
  const alteredId = records(); alteredId[0].clipId = 'common_voice_ne-NP_100000.mp3';
  await assert.rejects(runCommonVoiceHumanReferenceReview(input(alteredId)), /clip ID/u);
  const duplicate = records(); duplicate[1].clipId = duplicate[0].clipId;
  await assert.rejects(runCommonVoiceHumanReferenceReview(input(duplicate)), /unique/u);
  const badHash = records(); badHash[0].audioSha256 = '0'.repeat(64);
  await assert.rejects(runCommonVoiceHumanReferenceReview(input(badHash)), /does not match/u);
  const wrongDataset = { ...valid, sourceDatasetId: 'other-dataset' };
  await assert.rejects(runCommonVoiceHumanReferenceReview(wrongDataset), /pinned/u);
});

test('close before a delayed POST body ends prevents decisions from changing after abort', async () => {
  const rows = records();
  const session = await startCommonVoiceReferenceReview(rows, { locale: 'en' });
  const base = baseUrl(session.url);
  const request = httpRequest({ hostname: '127.0.0.1', port: base.port, path: `${base.pathname}/decision/0`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength('{"decision":"match"}') } });
  const responsePromise = new Promise((resolve, reject) => {
    request.on('response', (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  request.write('{"decision":');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const closePromise = session.close();
  assert.deepEqual(await session.result, { counts: { total: 24, match: 0, mismatch: 0, unintelligible: 0, skip: 0 }, complete: false });
  request.end('"match"}');
  assert.equal(await responsePromise, 410);
  await closePromise;
  assert.equal(rows.every((record) => record.sentence === '' && record.clipId === ''
    && record.audioSha256 === '' && record.audioBytes.length === 0), true);
});

test('coordinator abort returns aggregate-only incomplete result', async () => {
  let session;
  const payload = input(records());
  const resultPromise = runCommonVoiceHumanReferenceReview(payload, {
    serverFactory: async (...args) => { session = await startCommonVoiceReferenceReview(...args); return session; },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await session.close();
  const result = await resultPromise;
  assert.deepEqual(result, { completed: false, counts: { total: 24, match: 0, mismatch: 0, unintelligible: 0, skip: 0 } });
  assert.deepEqual(Object.keys(result).sort(), ['completed', 'counts']);
  assert.equal(JSON.stringify(result).includes('common_voice_en_'), false);
  await assert.rejects(fetch(session.url), /fetch failed|ECONNREFUSED/u);
});
