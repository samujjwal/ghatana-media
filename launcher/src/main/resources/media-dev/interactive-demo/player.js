/*
 * Ghatana Media DEV_ONLY interactive demonstration player (self-contained, no network beyond this package).
 *
 * Every asset is fetched from this package only, its SHA-256 is compared with the manifest BEFORE it can play, and a scene
 * whose video, captions or caption binding is stale is refused with a visible typed message (role=alert). Manifest text is
 * only ever written with textContent. The page's Content-Security-Policy (meta tag) forbids every other request.
 */
(function () {
  "use strict";

  var ASSET = /^assets\/([0-9a-f]{64})\.(webm|mp4|ogv)$/;
  var CAPTION = /^captions\/([0-9a-f]{64})\.vtt$/;
  var SHA = /^[0-9a-f]{64}$/;
  var MEDIA_TYPE = /^video\/[a-z0-9.+-]{1,40}$/;
  var ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  var LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
  var SCHEMA = "media.dev.interactive-demo.v1";

  function $(id) { return document.getElementById(id); }
  var video = $("video");
  var manifest = null;
  var nodes = {};
  var current = null;
  var pathIds = [];
  var taken = [];
  var ended = false;
  var refused = false;
  var cues = [];
  var replayQueue = null;
  var loadToken = 0;
  var verified = {};

  function Fault(code, message) { this.code = code; this.message = message; }

  function say(text) { $("status").textContent = text; }

  function showFault(code, message) {
    refused = true;
    var box = $("fault");
    box.hidden = false;
    box.setAttribute("data-code", code);
    box.textContent = "";
    var strong = document.createElement("strong");
    strong.textContent = code;
    box.appendChild(strong);
    box.appendChild(document.createTextNode(": " + message));
    document.getElementById("demo").setAttribute("data-state", "refused");
    video.pause();
    setControls();
    say("Refused: " + code + ". " + message);
  }

  function clearFault() {
    refused = false;
    var box = $("fault");
    box.hidden = true;
    box.textContent = "";
    box.removeAttribute("data-code");
    document.getElementById("demo").setAttribute("data-state", "loading");
  }

  function hex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function fetchVerified(path, expected, kind) {
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.reject(new Fault("DIGEST_UNAVAILABLE", "this browser context cannot compute SHA-256 (a secure context is required); the asset was not played"));
    }
    return fetch(path, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" }).then(function (response) {
      if (!response.ok) throw new Fault("ASSET_UNAVAILABLE", "the package file " + path + " could not be read (HTTP " + response.status + ")");
      return response.arrayBuffer();
    }, function () {
      throw new Fault("ASSET_UNAVAILABLE", "the package file " + path + " could not be fetched");
    }).then(function (buffer) {
      return window.crypto.subtle.digest("SHA-256", buffer).then(function (digest) {
        var actual = hex(digest);
        if (actual !== expected) {
          throw new Fault(kind === "caption" ? "CAPTION_DIGEST_MISMATCH" : "ASSET_DIGEST_MISMATCH",
            "the " + kind + " file " + path + " does not match its recorded SHA-256 (expected " + expected + ", found " + actual + "); it was not played");
        }
        return buffer;
      });
    });
  }

  function parseVtt(text) {
    var lines = text.replace(/\r\n?/g, "\n").split("\n");
    var timing = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})\s+-->\s+(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})/;
    var result = [];
    for (var i = 0; i < lines.length; i++) {
      var m = timing.exec(lines[i]);
      if (!m) continue;
      var start = ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]);
      var end = ((+(m[5] || 0)) * 3600 + (+m[6]) * 60 + (+m[7])) * 1000 + (+m[8]);
      var body = [];
      for (var j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) body.push(lines[j].replace(/<[^>]*>/g, ""));
      result.push({ start: start, end: end, text: body.join(" ") });
      i = j;
    }
    return result;
  }

  function validate(m) {
    if (!m || m.schema !== SCHEMA || !Array.isArray(m.nodes) || m.nodes.length < 1 || m.nodes.length > 32) return ["MANIFEST_INVALID", "the manifest is not a " + SCHEMA + " document"];
    if (!m.sourceTruth || (m.sourceTruth.kind !== "LIVE" && m.sourceTruth.kind !== "CURATED")) return ["MANIFEST_INVALID", "the manifest does not state whether it is live or curated"];
    var ids = {};
    for (var i = 0; i < m.nodes.length; i++) {
      var n = m.nodes[i];
      if (!n || typeof n.id !== "string" || !ID.test(n.id) || ids[n.id] || typeof n.label !== "string" || !n.label.trim()) return ["MANIFEST_INVALID", "node " + i + " is malformed"];
      ids[n.id] = true;
      if (!Number.isInteger(n.durationMs) || n.durationMs <= 0) return ["MANIFEST_INVALID", "node " + n.id + " has no duration"];
      if (n.origin !== "LIVE" && n.origin !== "CURATED") return ["MANIFEST_INVALID", "node " + n.id + " has no origin"];
      var v = n.video;
      if (!v || typeof v.path !== "string" || !ASSET.test(v.path) || !SHA.test(v.sha256) || v.path.indexOf(v.sha256) !== 7 || !MEDIA_TYPE.test(v.contentType)) {
        return ["ASSET_PATH_INVALID", "node " + n.id + " names a video outside this package or without a SHA-256"];
      }
      if (n.captions) {
        var c = n.captions;
        if (typeof c.path !== "string" || !CAPTION.test(c.path) || !SHA.test(c.sha256) || c.path.indexOf(c.sha256) !== 9 || !SHA.test(c.forVideoSha256) || !LANGUAGE.test(c.language)) {
          return ["ASSET_PATH_INVALID", "node " + n.id + " names captions outside this package or without a SHA-256"];
        }
      }
      if (!Array.isArray(n.choices)) return ["MANIFEST_INVALID", "node " + n.id + " has no choices array"];
    }
    for (var k = 0; k < m.nodes.length; k++) {
      for (var j = 0; j < m.nodes[k].choices.length; j++) {
        var ch = m.nodes[k].choices[j];
        if (!ch || !ID.test(ch.id) || typeof ch.label !== "string" || !ch.label.trim() || !ids[ch.to]) return ["MANIFEST_INVALID", "a choice of node " + m.nodes[k].id + " is malformed or dangling"];
      }
    }
    if (!ids[m.startNodeId]) return ["MANIFEST_INVALID", "the start node does not exist"];
    return null;
  }

  function renderTruth() {
    var truth = manifest.sourceTruth;
    var allLive = manifest.nodes.every(function (n) { return n.origin === "LIVE"; });
    var box = $("truth");
    if (truth.kind === "LIVE" && allLive) {
      box.setAttribute("data-truth", "live");
      box.textContent = "Live output: every scene is output generated by this Media runtime (DEV_ONLY, unreviewed).";
    } else {
      box.setAttribute("data-truth", "curated");
      var note = typeof truth.curationNote === "string" && truth.curationNote ? " " + truth.curationNote : "";
      var extra = truth.kind === "LIVE" ? " (a live claim is not supported by every scene)" : "";
      box.textContent = "Curated demonstration" + extra + ": scenes were chosen and assembled by the author and are not a live run." + note;
    }
  }

  function setControls() {
    var usable = !refused && !!current && video.getAttribute("src") !== null;
    $("play").disabled = !usable || !video.paused;
    $("pause").disabled = !usable || video.paused;
    $("replay-scene").disabled = !usable;
    $("replay-path").disabled = refused || !current || taken.length === 0;
    $("seek").disabled = !usable;
    $("restart").disabled = !manifest;
    renderChoices();
  }

  function renderChoices() {
    var list = $("choices");
    list.textContent = "";
    if (!current) return;
    var enabled = ended && !refused;
    $("choices-note").textContent = current.choices.length === 0
      ? "This scene is an ending."
      : (enabled ? "Choose how to continue. The keys 1 to " + current.choices.length + " also pick a choice." : "Choices become available when the scene has finished.");
    current.choices.forEach(function (choice, index) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.disabled = !enabled;
      button.setAttribute("data-choice", choice.id);
      button.setAttribute("aria-label", (index + 1) + ": " + choice.label + "; continue to " + nodes[choice.to].label);
      button.textContent = (index + 1) + ". " + choice.label;
      button.addEventListener("click", function () { choose(choice.id, false); });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function renderPath() {
    var list = $("path");
    list.textContent = "";
    pathIds.forEach(function (id, index) {
      var item = document.createElement("li");
      item.textContent = nodes[id].label;
      item.setAttribute("data-node", id);
      if (index === pathIds.length - 1) item.setAttribute("aria-current", "step");
      list.appendChild(item);
    });
  }

  function loadVideo(node) {
    var v = node.video;
    if (verified[v.sha256]) return Promise.resolve(verified[v.sha256]);
    return fetchVerified(v.path, v.sha256, "video").then(function (buffer) {
      var url = URL.createObjectURL(new Blob([buffer], { type: v.contentType }));
      verified[v.sha256] = url;
      return url;
    });
  }

  function loadCaptions(node) {
    if (!node.captions) return Promise.resolve([]);
    return fetchVerified(node.captions.path, node.captions.sha256, "caption").then(function (buffer) {
      return parseVtt(new TextDecoder("utf-8", { fatal: false }).decode(buffer));
    });
  }

  function enter(id, autoplay) {
    var token = ++loadToken;
    var node = nodes[id];
    current = node;
    ended = false;
    cues = [];
    clearFault();
    video.pause();
    video.removeAttribute("src");
    video.load();
    $("scene-heading").textContent = node.label;
    $("origin").textContent = node.origin === "LIVE"
      ? "Scene origin: output generated by this Media runtime (live)."
      : "Scene origin: media uploaded by the author (curated).";
    $("origin").setAttribute("data-origin", node.origin.toLowerCase());
    $("caption").textContent = "";
    $("caption").setAttribute("lang", node.captions ? node.captions.language : "en");
    var seek = $("seek");
    seek.max = String(node.durationMs);
    seek.value = "0";
    seek.setAttribute("aria-valuetext", "0 milliseconds");
    seek.setAttribute("aria-label", "Seek within " + node.label);
    renderPath();
    setControls();
    say("Verifying the files of " + node.label + ".");
    // The caption binding is checked before any network request.
    if (node.captions && node.captions.forVideoSha256 !== node.video.sha256) {
      showFault("CAPTION_VERSION_MISMATCH", "the captions of " + node.label + " were written for a different version of the video (" + node.captions.forVideoSha256 + ") than the one recorded for this scene (" + node.video.sha256 + "); the scene was not played");
      return;
    }
    loadVideo(node).then(function (url) {
      return loadCaptions(node).then(function (parsed) { return [url, parsed]; });
    }).then(function (pair) {
      if (token !== loadToken) return;
      cues = pair[1];
      video.src = pair[0];
      document.getElementById("demo").setAttribute("data-state", "ready");
      $("scene-heading").focus();
      setControls();
      say(node.label + " is ready. Its files match their recorded SHA-256 digests.");
      if (autoplay) video.play().catch(function () { showFault("MEDIA_PLAYBACK_FAILED", "the browser did not start playback"); });
    }).catch(function (failure) {
      if (token !== loadToken) return;
      if (failure instanceof Fault) showFault(failure.code, failure.message);
      else showFault("MEDIA_PLAYBACK_FAILED", "the scene could not be prepared");
    });
  }

  function choose(choiceId, replaying) {
    if (!current || !ended || refused) return;
    var choice = null;
    for (var i = 0; i < current.choices.length; i++) if (current.choices[i].id === choiceId) choice = current.choices[i];
    if (!choice) { showFault("REPLAY_PATH_INVALID", "the recorded choice " + choiceId + " does not exist in " + current.label); return; }
    taken.push({ from: current.id, choice: choice.id, to: choice.to });
    pathIds.push(choice.to);
    say("Chose: " + choice.label + ".");
    enter(choice.to, replaying);
  }

  function restart() {
    replayQueue = null;
    taken = [];
    pathIds = [manifest.startNodeId];
    enter(manifest.startNodeId, false);
  }

  function replayPath() {
    var recorded = taken.map(function (t) { return t.choice; });
    replayQueue = recorded;
    taken = [];
    pathIds = [manifest.startNodeId];
    enter(manifest.startNodeId, true);
  }

  function replayScene() {
    if (!current || refused) return;
    ended = false;
    video.currentTime = 0;
    renderChoices();
    video.play().catch(function () { showFault("MEDIA_PLAYBACK_FAILED", "the browser did not start playback"); });
  }

  function onEnded(played) {
    if (!current || refused || ended) return;
    ended = true;
    setControls();
    if (replayQueue && replayQueue.length > 0) {
      var next = replayQueue.shift();
      choose(next, true);
      return;
    }
    if (replayQueue) { replayQueue = null; say("Replay finished at " + current.label + "."); return; }
    if (current.choices.length === 0) say(current.label + " finished. This is an ending. You can replay it, replay your path or restart.");
    else {
      say(current.label + " finished. Choose how to continue: " + current.choices.map(function (c, i) { return (i + 1) + ", " + c.label; }).join("; ") + ".");
      var first = $("choices").querySelector("button");
      if (first && played === true) first.focus();
    }
  }

  function captionAt(ms) {
    var texts = [];
    for (var i = 0; i < cues.length; i++) if (ms >= cues[i].start && ms < cues[i].end) texts.push(cues[i].text);
    return texts.join(" ");
  }

  function boot() {
    var raw;
    try { raw = JSON.parse($("demo-manifest").textContent); } catch (e) { showFault("MANIFEST_INVALID", "the embedded manifest is not valid JSON"); return; }
    var problem = validate(raw);
    if (problem) { showFault(problem[0], problem[1]); $("truth").textContent = "Unverified demonstration."; return; }
    manifest = raw;
    manifest.nodes.forEach(function (n) { nodes[n.id] = n; });
    renderTruth();
    document.addEventListener("securitypolicyviolation", function (event) {
      var list = $("policy");
      var none = list.querySelector(".none");
      if (none) list.removeChild(none);
      var item = document.createElement("li");
      item.setAttribute("data-directive", event.effectiveDirective);
      item.textContent = "Blocked by " + event.effectiveDirective + ": " + event.blockedURI;
      list.appendChild(item);
      say("A request outside this package was blocked: " + event.blockedURI);
    });
    video.addEventListener("timeupdate", function () {
      var ms = Math.round(video.currentTime * 1000);
      var seek = $("seek");
      seek.value = String(Math.min(ms, +seek.max));
      seek.setAttribute("aria-valuetext", ms + " milliseconds");
      $("caption").textContent = captionAt(ms);
    });
    video.addEventListener("play", function () { setControls(); say("Playing " + current.label + "."); });
    video.addEventListener("pause", function () { if (!video.ended) { setControls(); say("Paused " + current.label + "."); } });
    video.addEventListener("ended", function () { onEnded(true); });
    function leftTheEnd() { return video.currentTime * 1000 < current.durationMs - 100; }
    video.addEventListener("seeking", function () {
      if (current && ended && leftTheEnd()) { ended = false; setControls(); }
    });
    video.addEventListener("seeked", function () {
      if (!current) return;
      if (video.ended) onEnded(false);
      else if (ended && leftTheEnd()) { ended = false; setControls(); }
    });
    video.addEventListener("error", function () { if (video.getAttribute("src") !== null) showFault("MEDIA_PLAYBACK_FAILED", "the browser could not decode the verified video"); });
    $("play").addEventListener("click", function () { video.play().catch(function () { showFault("MEDIA_PLAYBACK_FAILED", "the browser did not start playback"); }); });
    $("pause").addEventListener("click", function () { video.pause(); });
    $("replay-scene").addEventListener("click", replayScene);
    $("replay-path").addEventListener("click", replayPath);
    $("restart").addEventListener("click", restart);
    $("seek").addEventListener("input", function () {
      if (!current || refused) return;
      video.currentTime = (+$("seek").value) / 1000;
      say("Seeked to " + $("seek").value + " milliseconds in " + current.label + ".");
    });
    document.addEventListener("keydown", function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey || !/^[1-8]$/.test(event.key)) return;
      if (!current || !ended || refused) return;
      var choice = current.choices[+event.key - 1];
      if (choice) { event.preventDefault(); choose(choice.id, false); }
    });
    pathIds = [manifest.startNodeId];
    enter(manifest.startNodeId, false);
  }

  boot();
})();
