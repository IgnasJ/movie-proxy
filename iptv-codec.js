'use strict';

/* Light, keyless obfuscation for the channel list so plaintext stream URLs
   aren't committed to the repo. This is NOT encryption — it's base64 with a
   small header, trivially reversible by design. The point is only to keep the
   raw m3u out of git while still shipping a working default the app can decode
   on deploy.

   Layout in the repo:
     iptv.iptv        encoded default (committed)
     iptv.m3u         plaintext master you edit locally (gitignored)
     data/iptv.m3u    runtime file, seeded from iptv.iptv on first run
                      (gitignored; edit this one live in hosting)

   Update the baked-in default:  npm run encode-iptv
   (reads iptv.m3u -> writes iptv.iptv) */

const fs = require('fs');

const HEADER = 'IPTV-B64-V1\n';

function encode(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n');
  return HEADER + b64 + '\n';
}

// Tolerant: accepts an encoded blob OR a plaintext m3u (so a hand-edited
// iptv.iptv still works), and ignores the header / line wrapping.
function decode(blob) {
  const s = String(blob);
  if (s.trimStart().startsWith('#EXTM3U')) return s;
  const body = s.startsWith(HEADER) ? s.slice(HEADER.length) : s;
  return Buffer.from(body, 'base64').toString('utf8');
}

module.exports = { encode, decode, HEADER };

/* CLI: node iptv-codec.js encode [src=iptv.m3u] [out=iptv.iptv]
        node iptv-codec.js decode [src=iptv.iptv] [out=stdout] */
if (require.main === module) {
  const [mode, src, out] = process.argv.slice(2);
  if (mode !== 'encode' && mode !== 'decode') {
    console.error('usage: node iptv-codec.js encode|decode [src] [out]');
    process.exit(1);
  }
  const srcPath = src || (mode === 'encode' ? 'iptv.m3u' : 'iptv.iptv');
  const input = fs.readFileSync(srcPath, 'utf8');
  const result = mode === 'encode' ? encode(input) : decode(input);
  const outPath = out || (mode === 'encode' ? 'iptv.iptv' : null);
  if (outPath) {
    fs.writeFileSync(outPath, result);
    console.log(`${mode}d ${srcPath} -> ${outPath} (${result.length} bytes)`);
  } else {
    process.stdout.write(result);
  }
}
