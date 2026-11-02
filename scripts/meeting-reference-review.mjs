// Local-only listening and reference annotation. No model or provider calls.
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(process.argv[2] || 'artifacts/meeting-baseline');
const pilotBytes = await readFile(path.join(root, 'pilot.json'));
const pilot = JSON.parse(pilotBytes);
const pilotHash = createHash('sha256').update(pilotBytes).digest('hex');
const token = randomUUID();
const rows = pilot.results.map((row, index) => ({
  id: `${row.startSeconds}:${row.role}`,
  index,
  role: row.role,
  start: row.startSeconds,
  end: row.endSeconds,
  inputHash: row.inputStats.sha256,
  draft: row.result?.text || '',
  audio: row.reviewAudio,
}));
const referenceFile = path.join(root, 'reference.json');
let previous = null;
try {
  previous = JSON.parse(await readFile(referenceFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous && previous.pilotHash !== pilotHash)
  throw Error(
    'Existing review belongs to a different pilot. Preserve it before starting a new review.',
  );
const data = { pilotHash, rows: rows.map(({ audio, ...row }) => row), previous, token };
const html = await readFile(new URL('./meeting-reference-review.html', import.meta.url), 'utf8');
let page = html.replace('/*REVIEW_DATA*/', JSON.stringify(data).replace(/</g, '\\u003c'));
await writeFile(path.join(root, 'review.html'), page);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    // The random path limits access to this local review session. No CORS.
    if (!url.pathname.startsWith('/' + token + '/')) {
      res.writeHead(404).end();
      return;
    }
    const route = url.pathname.slice(token.length + 2);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && route === '') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page);
      return;
    }
    if (req.method === 'GET' && /^audio\/\d+$/.test(route)) {
      const row = rows[Number(route.split('/')[1])];
      if (!row) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', 'audio/wav');
      res.end(await readFile(row.audio));
      return;
    }
    if (req.method === 'POST' && route === 'save') {
      if (req.headers['content-type'] !== 'application/json') {
        res.writeHead(415).end();
        return;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 200000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        payload.pilotHash !== pilotHash ||
        !Array.isArray(payload.annotations) ||
        payload.annotations.length !== rows.length
      )
        throw Error('Review does not match this pilot');
      const annotations = rows.map((row) => {
        const found = payload.annotations.filter((a) => a.id === row.id);
        if (found.length !== 1) throw Error('Duplicate or missing annotation');
        const a = found[0];
        if (
          a.inputHash !== row.inputHash ||
          !['pending', 'speech', 'no-speech', 'uncertain'].includes(a.status) ||
          typeof a.text !== 'string' ||
          a.text.length > 10000
        )
          throw Error('Invalid annotation');
        if (a.status === 'speech' && !a.text.trim()) throw Error('Speech needs a transcript');
        if (
          a.status === 'speech' &&
          /\[\s*(unclear|inaudible|overlapping speech)\s*\]/i.test(a.text)
        )
          throw Error('Unclear speech must remain uncertain');
        if (a.status === 'no-speech' && a.text.trim())
          throw Error('No-speech transcript must be empty');
        return {
          id: row.id,
          role: row.role,
          startSeconds: row.start,
          endSeconds: row.end,
          inputHash: row.inputHash,
          status: a.status,
          text: a.text.trim(),
          draftRevealed: a.draftRevealed === true,
          textBeforeReveal:
            typeof a.textBeforeReveal === 'string' ? a.textBeforeReveal.slice(0, 10000) : null,
        };
      });
      const saved = {
        kind: 'human-meeting-reference',
        pilotHash,
        savedAt: new Date().toISOString(),
        provenance:
          'User-entered listening review; speech/no-speech explicitly marked; uncertain and pending items must not be scored as verified.',
        annotations,
      };
      const temp = referenceFile + '.tmp';
      await writeFile(temp, JSON.stringify(saved, null, 2));
      await rename(temp, referenceFile);
      page = html.replace(
        '/*REVIEW_DATA*/',
        JSON.stringify({ ...data, previous: saved }).replace(/</g, '\\u003c'),
      );
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          reviewed: annotations.filter((a) => ['speech', 'no-speech'].includes(a.status)).length,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        ok: false,
        error: 'Could not save. Check the transcript and review status.',
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/${token}/`;
await writeFile(
  path.join(root, 'review-server.json'),
  JSON.stringify({ url, pid: process.pid, referenceFile }, null, 2),
);
console.log(url);
console.log('Review saves locally to ' + referenceFile);
