/* IPTV playback. hls.js first wherever MediaSource exists (Chrome, Firefox,
   Edge, LG/Samsung TV browsers — their canPlayType lies about native HLS),
   native <video> otherwise (iPhone/iPad Safari play HLS natively). If hls.js
   can't parse the manifest (plain mp4 / radio stream), fall back to a direct
   src. Autoplay with sound is often blocked until a gesture, so a tap-to-play
   overlay appears when play() is rejected. */
function initIptv(src) {
  'use strict';
  var v = document.getElementById('tvvideo');
  var tap = document.getElementById('tvtap');
  var err = document.getElementById('tverr');
  var hls = null;

  function fail() {
    if (hls) { hls.destroy(); hls = null; }
    tap.hidden = true;
    err.hidden = false;
  }

  function tryPlay() {
    var p = v.play();
    if (p && p.catch) {
      p.then(function () { tap.hidden = true; }).catch(function () { tap.hidden = false; });
    }
  }

  function native() {
    if (hls) { hls.destroy(); hls = null; }
    v.addEventListener('error', fail);
    v.addEventListener('loadedmetadata', tryPlay);
    v.src = src;
    tryPlay();
  }

  tap.addEventListener('click', function () {
    tap.hidden = true;
    tryPlay();
  });

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      // live TV: stay close to the live edge, keep buffers modest for TVs
      liveSyncDurationCount: 3,
      maxBufferLength: 30,
      backBufferLength: 30,
    });
    var retries = 0;
    hls.on(Hls.Events.ERROR, function (_, data) {
      if (!data.fatal || !hls) return;
      // not an HLS playlist at all — let the browser try it directly
      if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) return native();
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries++ < 3) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retries++ < 3) hls.recoverMediaError();
      else fail();
    });
    hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
    hls.loadSource(src);
    hls.attachMedia(v);
  } else {
    native();
  }
}
