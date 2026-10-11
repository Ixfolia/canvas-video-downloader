// Unit tests for lib/common.js helpers. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load common.js in a sandbox with a fake `chrome` namespace.
const ctx = {
  chrome: {
    runtime: { getURL: (p) => 'chrome-extension://abc/' + p },
    storage: { session: {}, local: { get: async () => ({}) } },
  },
  URL,
  TextDecoder,
  DataView,
  Uint8Array,
};
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL('../lib/common.js', import.meta.url), 'utf8'), ctx);
const CVS = ctx.CVS;

test('sanitizeFilename strips illegal characters and reserved names', () => {
  assert.equal(CVS.sanitizeFilename('Week 3: Intro / Part <1>?'), 'Week 3_ Intro _ Part _1__');
  assert.equal(CVS.sanitizeFilename('  ..hidden.  '), 'hidden');
  assert.equal(CVS.sanitizeFilename('CON'), '_CON');
  assert.equal(CVS.sanitizeFilename(''), 'video');
  assert.equal(CVS.sanitizeFilename('a\u0000b‮c'), 'abc');
  assert.equal(Array.from(CVS.sanitizeFilename('é'.repeat(300))).length, 120);
});

test('videoKey dedupes range chunks and re-signed URLs', () => {
  const a = CVS.videoKey('https://cdn.x.com/v/lecture.mp4?Expires=1&Signature=a');
  const b = CVS.videoKey('https://cdn.x.com/v/lecture.mp4?Expires=2&Signature=b');
  assert.equal(a, b);
  assert.notEqual(CVS.videoKey('https://x.com/media?id=1'), CVS.videoKey('https://x.com/media?id=2'));
});

test('kindFrom / extOf ignore query strings', () => {
  assert.equal(CVS.extOf('https://a/b/c.M3U8?x=y.mp4'), 'm3u8');
  assert.equal(CVS.kindFrom('https://a/b/c.m3u8?x', ''), 'hls');
  assert.equal(CVS.kindFrom('https://a/b/play', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(CVS.kindFrom('https://a/b/play', 'application/x-mpegURL'), 'hls');
  assert.equal(CVS.kindFrom('https://a/b/v.webm', ''), 'webm');
  assert.equal(CVS.kindFrom('https://a/b/v', 'video/mp4'), 'mp4');
  assert.equal(CVS.kindFrom('https://a/b/v.js', 'text/javascript'), null);
});

test('pageAllowed respects restricted mode', () => {
  const s = { hostMode: 'restricted', customDomains: ['*.myschool.edu', 'https://lms.other.org/x'] };
  assert.ok(CVS.pageAllowed('https://school.instructure.com/courses/1', s));
  assert.ok(CVS.pageAllowed('https://canvas.myschool.edu/', s));
  assert.ok(CVS.pageAllowed('https://lms.other.org/', s));
  assert.ok(!CVS.pageAllowed('https://evilinstructure.com/', s));
  assert.ok(CVS.pageAllowed('https://anything.com/', { hostMode: 'all' }));
});

test('parseM3U8 master playlist', () => {
  const pl = CVS.parseM3U8(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
https://cdn.example.com/hi/index.m3u8?tok=1
`,
    'https://media.example.com/v/master.m3u8?sig=z',
  );
  assert.equal(pl.kind, 'master');
  assert.equal(pl.encrypted, false);
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].uri, 'https://media.example.com/v/low/index.m3u8');
  assert.equal(pl.variants[1].codecs, 'avc1.4d401f,mp4a.40.2');
  assert.equal(pl.media[0].uri, 'https://media.example.com/v/audio/en.m3u8');
});

test('parseM3U8 media playlist with fMP4 map and byte ranges', () => {
  const pl = CVS.parseM3U8(
    `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@720
main.mp4
#EXTINF:4.5,
#EXT-X-BYTERANGE:500
main.mp4
#EXT-X-ENDLIST
`,
    'https://m.example.com/p/index.m3u8',
  );
  assert.equal(pl.kind, 'media');
  assert.equal(pl.container, 'fmp4');
  assert.equal(pl.endList, true);
  assert.equal(pl.duration, 10.5);
  assert.deepEqual({ ...pl.segments[0].range }, { offset: 720, length: 1000 });
  assert.deepEqual({ ...pl.segments[1].range }, { offset: 1720, length: 500 });
  assert.deepEqual({ ...pl.segments[0].map.range }, { offset: 0, length: 720 });
});

test('parseM3U8 detects encryption', () => {
  const aes = CVS.parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST', 'https://x/');
  assert.equal(aes.encrypted, true);
  const none = CVS.parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:5,\na.ts', 'https://x/');
  assert.equal(none.encrypted, false);
  assert.equal(none.endList, false);
  const session = CVS.parseM3U8(
    '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://x"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8',
    'https://x/',
  );
  assert.equal(session.encrypted, true);
  assert.throws(() => CVS.parseM3U8('<html>', 'https://x/'));
});

function box(type, payload = new Uint8Array(0)) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
}
const cat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) (out.set(x, o), (o += x.length));
  return out;
};

test('sniffMp4Encrypted', () => {
  const ftyp = box('ftyp', new Uint8Array(8));
  const clear = cat(ftyp, box('moov', box('trak', box('avc1', new Uint8Array(16)))), box('mdat', new Uint8Array(32)));
  const enc = cat(ftyp, box('moov', box('trak', box('encv', box('sinf')))));
  const mdatFirst = cat(ftyp, box('mdat', new Uint8Array(64)));
  assert.equal(CVS.sniffMp4Encrypted(clear), false);
  assert.equal(CVS.sniffMp4Encrypted(enc), true);
  assert.equal(CVS.sniffMp4Encrypted(mdatFirst), null);
  // 'encv' bytes inside mdat must not count
  const fake = cat(ftyp, box('mdat', new TextEncoder().encode('xxencvxx')), box('moov', box('trak')));
  assert.equal(CVS.sniffMp4Encrypted(fake), false);
});
