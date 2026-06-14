/* IPTV playback. The channel URL is tried DIRECTLY first — the viewer's
   browser fetches the CDN itself, so geo/IP allow-lists apply to the viewer
   (in Lithuania) instead of the hosting server, which some CDNs (penki.lt
   wowza, stream-secure.lrt.lt) block. If the direct attempt fails (CORS,
   geo-block, network), the same channel is retried through /tvproxy.
   http:// sources skip the direct attempt — they'd be blocked as mixed
   content on an https page.

   hls.js is used wherever MediaSource exists (Chrome, Firefox, Edge,
   LG/Samsung TV browsers — their canPlayType lies about native HLS), native
   <video> otherwise (iPhone/iPad Safari play HLS natively). If hls.js can't
   parse the manifest (plain mp4 / radio stream), fall back to a direct src.
   Autoplay with sound is often blocked until a gesture, so a tap-to-play
   overlay appears when play() is rejected.

   Some "clean" HLS feeds turn DRM-encrypted at times (e.g. Go3 applies
   SAMPLE-AES/FairPlay to TV6 during live sports). hls.js can't decrypt those —
   it downloads every segment but finds no media, and would otherwise spin
   forever. When that's detected and the channel declares a licensed `embedUrl`,
   we swap the <video> for that embed iframe (its own player negotiates
   Widevine/PlayReady/FairPlay per browser). It reverts to clean HLS on its own
   once the encryption is dropped. */
function initIptv(directUrl, proxyUrl, embedUrl) {
  'use strict';
  var v = document.getElementById('tvvideo');
  var tap = document.getElementById('tvtap');
  var err = document.getElementById('tverr');
  var hls = null;
  var nativeActive = false;

  // clean HLS is DRM-locked right now — hand off to the channel's licensed
  // embed player; returns false when there's nothing to fall back to
  function embedFallback() {
    if (!embedUrl) return false;
    if (hls) { hls.destroy(); hls = null; }
    nativeActive = false;
    var f = document.createElement('iframe');
    f.className = 'playerframe';
    f.src = embedUrl;
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'no-referrer');
    tap.hidden = true;
    err.hidden = true;
    if (v.parentNode) v.parentNode.replaceChild(f, v);
    return true;
  }

  // sources to try in order; the last entry is always the server proxy
  var queue = [];
  if (directUrl && /^https:/i.test(directUrl)) queue.push(directUrl);
  queue.push(proxyUrl);

  function fail() {
    tap.hidden = true;
    err.hidden = false;
  }

  // current source is dead — move on to the next one (or give up)
  function bail() {
    if (hls) { hls.destroy(); hls = null; }
    nativeActive = false;
    queue.shift();
    if (queue.length) start(); else fail();
  }

  function tryPlay() {
    var p = v.play();
    if (p && p.catch) {
      p.then(function () { tap.hidden = true; }).catch(function () { tap.hidden = false; });
    }
  }

  v.addEventListener('error', function () { if (nativeActive) bail(); });
  v.addEventListener('loadedmetadata', function () { if (nativeActive) tryPlay(); });
  tap.addEventListener('click', function () {
    tap.hidden = true;
    tryPlay();
  });

  function native(src) {
    if (hls) { hls.destroy(); hls = null; }
    nativeActive = true;
    v.src = src;
    tryPlay();
  }

  /* JSON wrappers (LRT get_live_url.php and friends) are unwrapped by the
     proxy server-side; on the direct path the browser does it itself. Same
     picking rules as the server: prefer a plain HLS source over
     DRM/Verimatrix (VMX) variants. */
  function resolve(src, cb) {
    if (/\.m3u8(\?|$)/i.test(src)) return cb(src);
    fetch(src).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (body) {
      if (body.trimStart().indexOf('#EXTM3U') === 0) return cb(src);
      var urls = body.replace(/\\\//g, '/').match(/(?:https?:)?\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*/gi) || [];
      var pick = null, i;
      for (i = 0; i < urls.length && !pick; i++) if (/GO3_LIVE_HLS/.test(urls[i])) pick = urls[i];
      for (i = 0; i < urls.length && !pick; i++) if (!/VMX|nHLS/i.test(urls[i])) pick = urls[i];
      pick = pick || urls[0];
      if (!pick) throw new Error('no stream url');
      cb(pick.indexOf('//') === 0 ? 'https:' + pick : pick);
    }).catch(bail);
  }

  function go(src) {
    var isDirect = queue.length > 1; // anything before the final proxy entry
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        // live TV: stay close to the live edge, keep buffers modest for TVs
        liveSyncDurationCount: 3,
        maxBufferLength: 30,
        backBufferLength: 30,
      });
      var retries = 0;
      var parsed = false;
      var parseErrs = 0;
      var buffered = false;
      // FairPlay SAMPLE-AES is signalled on the media playlist before any
      // segment loads — catch it here for an instant, spinner-free swap
      hls.on(Hls.Events.LEVEL_LOADED, function (_, data) {
        var frags = data.details && data.details.fragments;
        var dd = frags && frags.length && frags[0].decryptdata;
        if (dd && dd.keyFormat === 'com.apple.streamingkeydelivery') {
          if (embedFallback()) return;
          fail(); // encrypted with no embed to fall back to — don't spin forever
        }
      });
      hls.on(Hls.Events.FRAG_BUFFERED, function () { buffered = true; });
      hls.on(Hls.Events.ERROR, function (_, data) {
        if (!hls) return;
        // encrypted content hls.js can't depacketize floods non-fatal
        // fragParsingErrors while nothing ever buffers — treat as DRM (backstop
        // for key formats LEVEL_LOADED didn't flag)
        if (data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR) {
          if (++parseErrs >= 3 && !buffered) { if (embedFallback()) return; fail(); }
          return;
        }
        if (!data.fatal) return;
        // not an HLS playlist at all — let the browser try it directly
        if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) return native(src);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // a direct CDN that won't even serve the manifest (CORS/geo-block)
          // isn't going to start working — switch to the proxy right away
          if (isDirect && !parsed) return bail();
          if (retries++ < 3) return hls.startLoad();
          return bail();
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retries++ < 3) hls.recoverMediaError();
        else bail();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { parsed = true; tryPlay(); });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      native(src);
    }
  }

  function start() {
    // the proxy unwraps JSON itself (and redirects), so feed it in as-is
    if (queue.length > 1) resolve(queue[0], go);
    else go(queue[0]);
  }

  start();
}

/* Direct-MP4 playback for the ad-free streams played in a bare <video> through
   /stream (8filmai's Streamtape MP4, TopFilmai's MP4). Smart-TV browsers block
   autoplay-with-sound until a user gesture and surface no obvious controls, so a
   bare autoplaying <video> just sits there never buffering — "opens but doesn't
   load". Mirror initIptv's resilience: drive playback with play() so the
   autoplay rejection is caught and the ▶ tap overlay shown, and reveal the
   error+retry overlay if the media fails to load. (preload=auto in the markup
   fills the buffer immediately, even before playback starts.) */
function initMp4(v) {
  'use strict';
  var tap = document.getElementById('tvtap');
  var err = document.getElementById('tverr');
  function tryPlay() {
    var p = v.play();
    if (p && p.catch) {
      p.then(function () { if (tap) tap.hidden = true; })
       .catch(function () { if (tap) tap.hidden = false; });
    }
  }
  if (tap) tap.addEventListener('click', function () { tap.hidden = true; tryPlay(); });
  v.addEventListener('loadedmetadata', tryPlay);
  v.addEventListener('error', function () { if (err) err.hidden = false; });
  tryPlay();
}

/* Subtitle rendering for the ad-free HLS player.

   Almost every browser — desktop Chrome/Firefox/Edge and iPhone/iPad Safari —
   paints a <track>'s WebVTT cues natively, both windowed and inside the native
   fullscreen video player. There we just switch the track on and let the
   browser draw it (styled via ::cue in tv.css).

   The exception is smart-TV browsers (Samsung Tizen, LG webOS): they parse the
   cues but never paint them over hls.js/MSE video, so captions silently never
   appear. Only there do we render the cues ourselves into a DOM overlay (fetch
   the same-origin WebVTT, parse it, draw the active cue). The native fullscreen
   button fullscreens the <video>, which would drop the sibling overlay off the
   top layer — so on that path we also re-target fullscreen to the container
   that holds the overlay (TV browsers are Chromium-based and allow that). We do
   NOT use the overlay on desktop precisely because that re-target is refused by
   Firefox, which is why the captions vanished in fullscreen there. */
function initCaptions(video) {
  'use strict';
  var trackEl = video.querySelector('track');
  if (!trackEl) return;

  // Smart-TV browsers can't paint <track> over MSE; everything else can.
  var isTV = /Tizen|Web0S|WebOS|webOS|SmartTV|SMART-TV|HbbTV|NetCast|BRAVIA|VIDAA|Viera|AQUOS|DTV/i
    .test(navigator.userAgent || '');
  if (!isTV) {
    var show = function () {
      try { for (var i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = 'showing'; }
      catch (e) { /* not ready yet */ }
    };
    video.addEventListener('loadedmetadata', show);
    show();
    return;
  }

  // Smart-TV overlay path: drop the native track (it won't paint anyway) and
  // draw cues into our own overlay instead.
  var src = trackEl.getAttribute('src');
  if (trackEl.parentNode) trackEl.parentNode.removeChild(trackEl);
  if (!src) return;

  var box = video.parentNode || document.body;
  var overlay = document.createElement('div');
  overlay.className = 'tv-caption';
  overlay.setAttribute('aria-hidden', 'true');
  box.appendChild(overlay);

  // The native fullscreen button fullscreens the <video> itself, which leaves
  // the overlay (a sibling) off the top layer — captions vanish in fullscreen.
  // When the video goes fullscreen, re-target fullscreen to the container that
  // holds the overlay. Browsers allow transferring fullscreen between elements
  // from inside the fullscreenchange handler without a fresh user gesture.
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function onFsChange() {
    if (fsElement() !== video) return;
    var req = box.requestFullscreen || box.webkitRequestFullscreen;
    if (!req) return;
    try {
      var p = req.call(box);
      if (p && p.catch) p.catch(function () { /* transfer refused — leave video fullscreen */ });
    } catch (e) { /* leave the video fullscreen */ }
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // [HH:]MM:SS.mmm (or ,mmm) -> seconds
  function toSeconds(ts) {
    var m = ts.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 +
      parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
  }

  function parseVtt(text) {
    var out = [];
    var blocks = text.replace(/\r\n?/g, '\n').split(/\n\n+/);
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n');
      var ti = -1;
      for (var i = 0; i < lines.length; i++) if (lines[i].indexOf('-->') !== -1) { ti = i; break; }
      if (ti === -1) continue;
      var bounds = lines[ti].split('-->');
      var startT = toSeconds(bounds[0]);
      var endT = toSeconds(bounds[1]);
      if (startT == null || endT == null) continue;
      // strip cue tags (<i>, <c>, inline timestamps) — overlay is plain text
      var txt = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (txt) out.push({ start: startT, end: endT, text: txt });
    }
    return out;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var cues = [];
  var lastText = null;
  function render() {
    var t = video.currentTime, shown = '';
    for (var i = 0; i < cues.length; i++) {
      if (cues[i].start <= t && t < cues[i].end) shown += (shown ? '\n' : '') + cues[i].text;
    }
    if (shown === lastText) return;        // avoid reflowing the DOM every tick
    lastText = shown;
    overlay.innerHTML = shown ? escapeHtml(shown).replace(/\n/g, '<br>') : '';
  }

  fetch(src)
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (text) {
      cues = parseVtt(text);
      if (!cues.length) return;
      // timeupdate fires ~4x/s — fine granularity for subtitles; seeked covers jumps
      video.addEventListener('timeupdate', render);
      video.addEventListener('seeked', render);
      render();
    })
    .catch(function () { /* no subs — leave the overlay empty */ });
}
