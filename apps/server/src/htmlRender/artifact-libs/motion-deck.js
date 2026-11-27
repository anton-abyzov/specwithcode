/*! SpecWithCode motion deck runtime | MIT License | Copyright 2026 SpecWithCode contributors */
// Runs a presentation made of scenes and beats in one page: hash links, keys, touch, a loading
// bar, an HDR post pass, a DOM text layer and synthesized sound. Pages load it with
// a script tag whose src is "specwithcode:motion-deck"; SpecWithCode inlines it when it publishes.
// Plain ES2020 in one IIFE so it runs inline, offline and from a downloaded file.
(function () {
  "use strict";

  // ---------------------------------------------------------------- easing and helpers
  var clamp01 = function (x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  };
  var ease = {
    linear: function (t) {
      return t;
    },
    inQuad: function (t) {
      return t * t;
    },
    outQuad: function (t) {
      return 1 - (1 - t) * (1 - t);
    },
    inOutQuad: function (t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    },
    outCubic: function (t) {
      return 1 - Math.pow(1 - t, 3);
    },
    inOutCubic: function (t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    outQuart: function (t) {
      return 1 - Math.pow(1 - t, 4);
    },
    inOutQuart: function (t) {
      return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
    },
    outExpo: function (t) {
      return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    },
    inOutExpo: function (t) {
      return t <= 0
        ? 0
        : t >= 1
          ? 1
          : t < 0.5
            ? Math.pow(2, 20 * t - 10) / 2
            : (2 - Math.pow(2, -20 * t + 10)) / 2;
    },
    outBack: function (t) {
      var c = 1.6;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    },
    inOutSine: function (t) {
      return -(Math.cos(Math.PI * t) - 1) / 2;
    },
    // A damped spring that settles by t = 1.
    spring: function (t) {
      return 1 - Math.exp(-6 * t) * Math.cos(9 * t);
    },
  };
  var easeOf = function (e) {
    return typeof e === "function" ? e : ease[e] || ease.inOutCubic;
  };
  var mix = function (a, b, t) {
    return a + (b - a) * t;
  };
  // Small deterministic random source for scenes that must look the same on every load.
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }
  var GLSL = {
    hash: "float swcHash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}\n",
    noise:
      "float swcNoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);" +
      "return mix(mix(swcHash(i),swcHash(i+vec2(1,0)),u.x),mix(swcHash(i+vec2(0,1)),swcHash(i+vec2(1,1)),u.x),u.y);}\n" +
      "float swcFbm(vec2 p){float a=0.5,s=0.0;for(int i=0;i<5;i++){s+=a*swcNoise(p);p=p*2.03+vec2(1.7,9.2);a*=0.5;}return s;}\n",
  };

  // ---------------------------------------------------------------- styles and chrome
  var CSS =
    "html,body{margin:0;height:100%;overflow:hidden;background:#05060a}" +
    "#swc-stage{position:fixed;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none}" +
    "#swc-layers{position:fixed;inset:0;pointer-events:none;--u:calc(min(100vw/1920,100vh/1080))}" +
    ".swc-layer{position:absolute;inset:0;opacity:0;transition:opacity .5s ease;color:#f4f1ea;" +
    "font-family:var(--swc-font,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif)}" +
    ".swc-layer.swc-on{opacity:1}" +
    ".swc-w{display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.08em;margin-bottom:-.08em}" +
    ".swc-w>span{display:inline-block;will-change:transform}" +
    ".swc-odo{display:inline-flex;font-variant-numeric:tabular-nums;line-height:1}" +
    ".swc-col{display:inline-block;height:1em;overflow:hidden;position:relative}" +
    ".swc-col>span{display:block;will-change:transform}.swc-col>span>i{display:block;height:1em;font-style:normal}" +
    "#swc-ui{position:fixed;inset:0;pointer-events:none;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e9e6df}" +
    "#swc-ui>*{pointer-events:auto}" +
    ".swc-load{position:absolute;inset:0;display:grid;place-content:center;gap:18px;background:radial-gradient(120% 90% at 50% 40%,#141826,#05060a);transition:opacity .7s ease}" +
    ".swc-load h1{margin:0;font-weight:500;font-size:20px;letter-spacing:.02em;text-align:center;color:#f4f1ea}" +
    ".swc-load .bar{width:min(360px,70vw);height:3px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden}" +
    ".swc-load .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#8fb3ff,#ffd59a);box-shadow:0 0 12px #9fc0ff;transition:width .25s ease}" +
    ".swc-load p{margin:0;text-align:center;color:#9aa0ad;font-variant-numeric:tabular-nums;font-size:13px}" +
    ".swc-progress{position:absolute;left:0;bottom:0;height:2px;background:rgba(255,255,255,.55);transition:width .6s ease;pointer-events:none}" +
    ".swc-panel{position:absolute;left:0;right:0;bottom:0;padding:16px 24px;background:rgba(10,12,18,.9);display:grid;grid-template-columns:1fr auto;gap:24px}" +
    ".swc-panel p{margin:0;max-width:72ch;font-size:17px;white-space:pre-line}.swc-panel span{color:#9aa0ad;white-space:nowrap}" +
    ".swc-help{position:absolute;right:20px;bottom:20px;background:rgba(10,12,18,.92);padding:16px 20px;display:grid;grid-template-columns:auto auto;gap:3px 18px;border-radius:10px}" +
    ".swc-help b{font-weight:600}.swc-help span{color:#9aa0ad}" +
    ".swc-toast{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(10,12,18,.9);padding:7px 14px;border-radius:999px;font-size:13px;transition:opacity .4s}" +
    ".swc-error{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:24px;background:#05060a}" +
    "body.swc-idle{cursor:none}" +
    "@media (prefers-reduced-motion:reduce){.swc-layer{transition:none}}";

  function el(tag, cls, parent, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------------------------------------------------------------- kinetic text
  // Wraps each word of an element so `rise(el, p)` can lift words in one after another.
  function words(node) {
    if (node.__swcWords) return node.__swcWords;
    var text = node.textContent;
    node.textContent = "";
    var list = [];
    text.split(/(\s+)/).forEach(function (part) {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        node.appendChild(document.createTextNode(part));
        return;
      }
      var outer = el("span", "swc-w", node);
      var inner = el("span", "", outer);
      inner.textContent = part;
      list.push(inner);
    });
    node.__swcWords = list;
    return list;
  }
  function rise(node, p, opts) {
    var list = words(node);
    var o = opts || {};
    var stagger = o.stagger === undefined ? 0.35 : o.stagger;
    var e = easeOf(o.ease || "outQuart");
    var n = list.length;
    for (var i = 0; i < n; i++) {
      var start = n > 1 ? (i / (n - 1)) * stagger : 0;
      var local = clamp01((p - start) / (1 - stagger || 1));
      var k = e(local);
      list[i].style.transform =
        "translate3d(0," +
        ((1 - k) * 105).toFixed(2) +
        "%,0) rotate(" +
        ((1 - k) * 3).toFixed(2) +
        "deg)";
      list[i].style.opacity = String(clamp01(local * 3));
    }
  }
  // A rolling-digit counter. Each column scrolls through 0-9; a column moves only while every
  // lower column is passing from 9 to 0, as on a mechanical counter.
  function odometer(node, opts) {
    var o = opts || {};
    var decimals = o.decimals || 0;
    var group = o.group === undefined ? "," : o.group;
    node.classList.add("swc-odo");
    var columns = [];
    var built = -1;
    function build(intDigits) {
      node.textContent = "";
      columns = [];
      var total = intDigits + decimals;
      for (var i = total - 1; i >= 0; i--) {
        var pos = i - decimals; // power of ten for this column
        if (decimals > 0 && pos === -1) el("span", "", node).textContent = ".";
        var col = el("span", "swc-col", node);
        var strip = el("span", "", col);
        for (var d = 0; d <= 10; d++) el("i", "", strip).textContent = String(d % 10);
        columns.push({ strip: strip, pos: pos });
        if (group && pos > 0 && pos % 3 === 0) el("span", "", node).textContent = group;
      }
      built = intDigits;
    }
    return {
      set: function (value) {
        var v = Math.max(0, value);
        var intDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, v))) + 1);
        if (intDigits !== built) build(intDigits);
        var scaled = v * Math.pow(10, decimals);
        for (var c = 0; c < columns.length; c++) {
          var unit = Math.pow(10, columns[c].pos + decimals);
          var digit = Math.floor(scaled / unit) % 10;
          var below = scaled % unit; // what the lower columns show, 0 to unit
          var carry = unit > 1 ? clamp01((below - (unit - 1)) / 1) : scaled % 1;
          var shown = digit + ease.inOutCubic(carry);
          columns[c].strip.style.transform = "translate3d(0," + (-shown * 1).toFixed(4) + "em,0)";
        }
      },
    };
  }

  // ---------------------------------------------------------------- sound
  // Everything is synthesized: no files. Pads are detuned oscillator pairs through a moving
  // low-pass into a generated-impulse reverb; hits are short enveloped tones and noise.
  function createAudio() {
    var ac = null,
      master,
      comp,
      wet,
      dry,
      verb,
      noise;
    var muted = false;
    var beds = [];
    var pendingBed; // asked for before the reader's first gesture; starts on unlock
    var lastHit = {};
    function midi(m) {
      return 440 * Math.pow(2, (m - 69) / 12);
    }
    function impulse(seconds, decay) {
      var len = Math.floor(ac.sampleRate * seconds);
      var buf = ac.createBuffer(2, len, ac.sampleRate);
      for (var ch = 0; ch < 2; ch++) {
        var d = buf.getChannelData(ch),
          r = rng(ch + 7),
          lp = 0;
        for (var i = 0; i < len; i++) {
          var white = r() * 2 - 1;
          lp += (white - lp) * (0.25 + 0.5 * (1 - i / len)); // darker tail
          d[i] =
            lp *
            Math.pow(1 - i / len, decay) *
            (i < ac.sampleRate * 0.012 ? i / (ac.sampleRate * 0.012) : 1);
        }
      }
      return buf;
    }
    function ensure() {
      if (ac) return true;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      ac = new Ctx({ latencyHint: "interactive" });
      comp = ac.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.005;
      comp.release.value = 0.25;
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.9;
      comp.connect(master);
      master.connect(ac.destination);
      dry = ac.createGain();
      dry.gain.value = 0.8;
      dry.connect(comp);
      verb = ac.createConvolver();
      verb.buffer = impulse(3.4, 2.6);
      wet = ac.createGain();
      wet.gain.value = 0.55;
      verb.connect(wet);
      wet.connect(comp);
      var nb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate),
        nd = nb.getChannelData(0),
        r = rng(99);
      for (var i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
      noise = nb;
      return true;
    }
    function send(node, verbAmount) {
      node.connect(dry);
      var s = ac.createGain();
      s.gain.value = verbAmount;
      node.connect(s);
      s.connect(verb);
    }
    var api = {
      get running() {
        return !!ac && ac.state === "running";
      },
      get muted() {
        return muted;
      },
      get context() {
        return ac;
      },
      unlock: function () {
        if (!ensure()) return;
        var startPending = function () {
          if (pendingBed === undefined || ac.state !== "running") return;
          var spec = pendingBed;
          pendingBed = undefined;
          api.bed(spec);
        };
        if (ac.state !== "running") ac.resume().then(startPending, function () {});
        else startPending();
      },
      mute: function (on) {
        muted = on === undefined ? !muted : !!on;
        if (ac) master.gain.setTargetAtTime(muted ? 0 : 0.9, ac.currentTime, 0.06);
        return muted;
      },
      suspend: function () {
        if (ac && ac.state === "running") ac.suspend().catch(function () {});
      },
      // A sustained chord bed. notes: MIDI numbers. color: "warm", "glass", "dark" or "air".
      bed: function (spec) {
        // Never create or feed a context before a gesture: browsers refuse and warn.
        if (!ac || ac.state !== "running") {
          pendingBed = spec;
          return;
        }
        var now = ac.currentTime;
        beds.forEach(function (b) {
          b.gain.gain.cancelScheduledValues(now);
          b.gain.gain.setTargetAtTime(0, now, 0.7);
          b.voices.forEach(function (v) {
            v.oscs.forEach(function (o) {
              o.stop(now + 4);
            });
          });
        });
        beds = [];
        if (!spec) return;
        var color = spec.color || "warm";
        var shapes = {
          warm: ["sawtooth", "triangle"],
          glass: ["sine", "triangle"],
          dark: ["sawtooth", "sawtooth"],
          air: ["sine", "sine"],
        }[color] || ["sawtooth", "triangle"];
        var cut = { warm: 900, glass: 2600, dark: 420, air: 3600 }[color] || 900;
        var gain = ac.createGain();
        gain.gain.value = 0;
        send(gain, color === "air" || color === "glass" ? 0.9 : 0.6);
        gain.gain.setTargetAtTime(spec.level || 0.16, now, 1.2);
        var voices = (spec.notes || [50, 57, 62, 66]).map(function (note, i) {
          var filter = ac.createBiquadFilter();
          filter.type = "lowpass";
          filter.frequency.value = cut;
          filter.Q.value = 0.7;
          var lfo = ac.createOscillator(),
            lfoGain = ac.createGain();
          lfo.frequency.value = 0.05 + i * 0.023;
          lfoGain.gain.value = cut * 0.35;
          lfo.connect(lfoGain);
          lfoGain.connect(filter.frequency);
          var vg = ac.createGain();
          vg.gain.value = (1 / Math.sqrt(spec.notes ? spec.notes.length : 4)) * 0.5;
          var oscs = [-7, 7].map(function (cents, j) {
            var o = ac.createOscillator();
            o.type = shapes[j];
            o.frequency.value = midi(note);
            o.detune.value = cents + (j ? 2 : -3) * i;
            o.connect(filter);
            o.start(now);
            return o;
          });
          lfo.start(now);
          oscs.push(lfo);
          filter.connect(vg);
          vg.connect(gain);
          return { oscs: oscs, note: note };
        });
        beds.push({ gain: gain, voices: voices });
      },
      // Glides the current bed's voices to new notes.
      chord: function (notes, glide) {
        if (!ac || !beds.length) return;
        var now = ac.currentTime;
        beds[0].voices.forEach(function (v, i) {
          var n = notes[i % notes.length] + (i >= notes.length ? 12 : 0);
          v.oscs.slice(0, 2).forEach(function (o) {
            o.frequency.setTargetAtTime(midi(n), now, glide || 0.4);
          });
        });
      },
      level: function (value, seconds) {
        if (!ac || !beds.length) return;
        beds[0].gain.gain.setTargetAtTime(value, ac.currentTime, seconds || 0.8);
      },
      // One-shot sounds: tick, pop, chime, whoosh, rise, boom, blip.
      hit: function (kind, opts) {
        if (!ac || ac.state !== "running") return;
        var o = opts || {};
        var t = ac.currentTime + (o.delay || 0);
        if (lastHit[kind] && t - lastHit[kind] < 0.02) return;
        lastHit[kind] = t;
        var g = ac.createGain();
        g.gain.value = 0;
        var pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
        if (pan) {
          pan.pan.value = o.pan || 0;
          g.connect(pan);
          send(pan, o.verb === undefined ? 0.35 : o.verb);
        } else send(g, o.verb === undefined ? 0.35 : o.verb);
        var vol = o.gain === undefined ? 0.5 : o.gain;
        var tone = function (type, f0, f1, dur) {
          var osc = ac.createOscillator();
          osc.type = type;
          osc.frequency.setValueAtTime(f0, t);
          if (f1) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
          osc.connect(g);
          osc.start(t);
          osc.stop(t + dur + 0.05);
        };
        var hiss = function (type, f0, f1, dur, q) {
          var src = ac.createBufferSource();
          src.buffer = noise;
          src.loop = true;
          var f = ac.createBiquadFilter();
          f.type = type;
          f.Q.value = q || 0.8;
          f.frequency.setValueAtTime(f0, t);
          f.frequency.exponentialRampToValueAtTime(f1, t + dur);
          src.connect(f);
          f.connect(g);
          src.start(t, Math.random());
          src.stop(t + dur + 0.05);
        };
        var env = function (attack, dur) {
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(vol, t + attack);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        };
        var pitch = midi(o.note || 76);
        switch (kind) {
          case "tick":
            tone("triangle", 2400, 1800, 0.05);
            env(0.002, 0.06);
            break;
          case "pop":
            tone("sine", pitch * 1.5, pitch * 0.75, 0.12);
            env(0.003, 0.14);
            break;
          case "chime":
            tone("sine", pitch, 0, 1.6);
            tone("sine", pitch * 2.01, 0, 1.2);
            tone("sine", pitch * 3.02, 0, 0.7);
            env(0.004, 1.8);
            break;
          case "whoosh":
            hiss("bandpass", 300, 4200, o.dur || 0.9, 1.2);
            env((o.dur || 0.9) * 0.6, o.dur || 0.9);
            break;
          case "rise":
            hiss("bandpass", 200, 6000, o.dur || 1.6, 2);
            tone("sawtooth", pitch / 4, pitch, o.dur || 1.6);
            env((o.dur || 1.6) * 0.92, (o.dur || 1.6) + 0.1);
            break;
          case "boom":
            tone("sine", 90, 34, 1.4);
            hiss("lowpass", 900, 60, 1.0);
            env(0.006, 1.6);
            break;
          default:
            tone("square", pitch, pitch * 0.5, 0.08);
            env(0.002, 0.09); // blip
        }
      },
    };
    return api;
  }

  // ---------------------------------------------------------------- post-processing
  // Scene -> HDR target -> dual-filter bloom (down then tent-up chain) -> composite: bloom,
  // exposure, ACES fit, grade, vignette, grain, dither -> LDR target or screen. Two LDR targets
  // let a transition blend the outgoing and incoming scenes.
  function createPost(THREE, renderer) {
    var tri = new THREE.BufferGeometry();
    tri.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    var cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(tri, null);
    quad.frustumCulled = false;
    var scene = new THREE.Scene();
    scene.add(quad);
    var VERT =
      "varying vec2 vUv;void main(){vUv=position.xy*0.5+0.5;gl_Position=vec4(position.xy,0.0,1.0);}";
    function mat(frag, uniforms) {
      return new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms: uniforms,
        depthTest: false,
        depthWrite: false,
      });
    }
    var prefilter = mat(
      "uniform sampler2D tIn;uniform float threshold,knee;varying vec2 vUv;void main(){vec3 c=min(texture2D(tIn,vUv).rgb,vec3(64.0));" +
        "float b=max(c.r,max(c.g,c.b));float s=clamp(b-threshold+knee,0.0,2.0*knee);s=s*s/(4.0*knee+1e-4);" +
        "gl_FragColor=vec4(c*max(s,b-threshold)/max(b,1e-4),1.0);}",
      { tIn: { value: null }, threshold: { value: 0.9 }, knee: { value: 0.5 } },
    );
    var down = mat(
      "uniform sampler2D tIn;uniform vec2 texel;varying vec2 vUv;void main(){vec2 h=texel*0.5;" +
        "vec3 s=texture2D(tIn,vUv).rgb*4.0+texture2D(tIn,vUv-h).rgb+texture2D(tIn,vUv+h).rgb+texture2D(tIn,vUv+vec2(h.x,-h.y)).rgb+texture2D(tIn,vUv-vec2(h.x,-h.y)).rgb;" +
        "gl_FragColor=vec4(s/8.0,1.0);}",
      { tIn: { value: null }, texel: { value: new THREE.Vector2() } },
    );
    var up = mat(
      "uniform sampler2D tIn,tAdd;uniform vec2 texel;varying vec2 vUv;void main(){vec2 h=texel*0.5;" +
        "vec3 s=texture2D(tIn,vUv+vec2(-h.x*2.0,0.0)).rgb+texture2D(tIn,vUv+vec2(h.x*2.0,0.0)).rgb+texture2D(tIn,vUv+vec2(0.0,-h.y*2.0)).rgb+texture2D(tIn,vUv+vec2(0.0,h.y*2.0)).rgb;" +
        "s+=(texture2D(tIn,vUv+vec2(-h.x,h.y)).rgb+texture2D(tIn,vUv+h).rgb+texture2D(tIn,vUv+vec2(h.x,-h.y)).rgb+texture2D(tIn,vUv-h).rgb)*2.0;" +
        "gl_FragColor=vec4(s/12.0+texture2D(tAdd,vUv).rgb,1.0);}",
      { tIn: { value: null }, tAdd: { value: null }, texel: { value: new THREE.Vector2() } },
    );
    var composite = mat(
      GLSL.hash +
        "uniform sampler2D tScene,tBloom;uniform float bloom,exposure,vignette,grain,time,contrast,saturation,ca,fade;uniform vec3 lift,gain,fadeColor;uniform vec2 res;varying vec2 vUv;" +
        "vec3 aces(vec3 x){return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);}" +
        "vec3 toSrgb(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(0.0031308,c));}" +
        "void main(){vec2 d=vUv-0.5;vec3 c;" +
        "if(ca>0.0){vec2 o=d*dot(d,d)*ca*0.012;c=vec3(texture2D(tScene,vUv+o).r,texture2D(tScene,vUv).g,texture2D(tScene,vUv-o).b);}else c=texture2D(tScene,vUv).rgb;" +
        "c+=texture2D(tBloom,vUv).rgb*bloom;c*=exposure;c=aces(c);c=toSrgb(c);" +
        "c=(c-0.5)*contrast+0.5;float l=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(l),c,saturation);" +
        "c=c*gain+lift*(1.0-c);" +
        "vec2 a=d*vec2(res.x/res.y,1.0);c*=1.0-vignette*smoothstep(0.25,1.05,length(a)*1.15);" +
        "float n=swcHash(vUv*res+fract(time*7.0)*97.0)-0.5;c+=n*grain*(1.0-abs(l-0.5));" +
        "c=mix(c,fadeColor,fade);c+=(swcHash(vUv*res+3.1)-0.5)/255.0;gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);}",
      {
        tScene: { value: null },
        tBloom: { value: null },
        bloom: { value: 0.6 },
        exposure: { value: 1 },
        vignette: { value: 0.25 },
        grain: { value: 0.03 },
        time: { value: 0 },
        contrast: { value: 1.02 },
        saturation: { value: 1.05 },
        ca: { value: 0 },
        fade: { value: 0 },
        lift: { value: new THREE.Color(0, 0, 0) },
        gain: { value: new THREE.Color(1, 1, 1) },
        fadeColor: { value: new THREE.Color(0, 0, 0) },
        res: { value: new THREE.Vector2(1, 1) },
      },
    );
    var blend = mat(
      GLSL.hash +
        GLSL.noise +
        "uniform sampler2D tA,tB;uniform float p,mode,aspect;varying vec2 vUv;void main(){vec3 a=texture2D(tA,vUv).rgb,b=texture2D(tB,vUv).rgb;float m;" +
        "if(mode<0.5){m=smoothstep(0.0,1.0,p);}" +
        "else if(mode<1.5){vec2 q=(vUv-0.5)*vec2(aspect,1.0);float r=length(q)+swcFbm(q*3.0)*0.12;m=1.0-smoothstep(p*1.25-0.12,p*1.25,r);}" +
        "else{float e=vUv.x*0.75+vUv.y*0.25+swcFbm(vUv*vec2(4.0,8.0))*0.18;m=1.0-smoothstep(p*1.4-0.15,p*1.4,e+0.15);}" +
        "gl_FragColor=vec4(mix(a,b,m),1.0);}",
      {
        tA: { value: null },
        tB: { value: null },
        p: { value: 0 },
        mode: { value: 0 },
        aspect: { value: 1 },
      },
    );
    var LEVELS = 5;
    var hdrOpts = { type: THREE.HalfFloatType, depthBuffer: false };
    var hdr = null,
      downs = [],
      ups = [],
      ldr = [],
      w = 1,
      h = 1;
    function resize(width, height) {
      w = width;
      h = height;
      [hdr].concat(downs, ups, ldr).forEach(function (t) {
        if (t) t.dispose();
      });
      var samples = renderer.capabilities.isWebGL2 ? 4 : 0;
      hdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: samples });
      downs = [];
      ups = [];
      for (var i = 0; i < LEVELS; i++) {
        var lw = Math.max(1, w >> (i + 1)),
          lh = Math.max(1, h >> (i + 1));
        downs.push(new THREE.WebGLRenderTarget(lw, lh, hdrOpts));
        if (i < LEVELS - 1) ups.push(new THREE.WebGLRenderTarget(lw, lh, hdrOpts));
      }
      ldr = [0, 1].map(function () {
        return new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      });
      composite.uniforms.res.value.set(w, h);
      blend.uniforms.aspect.value = w / h;
    }
    function pass(material, target) {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
    }
    var DEFAULTS = {
      bloom: 0.6,
      threshold: 0.9,
      knee: 0.5,
      exposure: 1,
      vignette: 0.25,
      grain: 0.03,
      contrast: 1.02,
      saturation: 1.05,
      ca: 0,
      fade: 0,
      lift: [0, 0, 0],
      gain: [1, 1, 1],
      fadeColor: [0, 0, 0],
    };
    return {
      resize: resize,
      get size() {
        return { width: w, height: h };
      },
      // Renders `scene` with `camera` through the post chain into LDR slot `slot`, or to the screen.
      render: function (sceneToDraw, camera, opts, time, slot, custom) {
        var o = Object.assign({}, DEFAULTS, opts || {});
        renderer.setRenderTarget(hdr);
        renderer.clear();
        if (custom) custom(hdr);
        else renderer.render(sceneToDraw, camera);
        if (o.bloom > 0) {
          prefilter.uniforms.tIn.value = hdr.texture;
          prefilter.uniforms.threshold.value = o.threshold;
          prefilter.uniforms.knee.value = o.knee;
          pass(prefilter, downs[0]);
          for (var i = 1; i < LEVELS; i++) {
            down.uniforms.tIn.value = downs[i - 1].texture;
            down.uniforms.texel.value.set(1 / downs[i - 1].width, 1 / downs[i - 1].height);
            pass(down, downs[i]);
          }
          for (var j = LEVELS - 2; j >= 0; j--) {
            var src = j === LEVELS - 2 ? downs[LEVELS - 1] : ups[j + 1];
            up.uniforms.tIn.value = src.texture;
            up.uniforms.tAdd.value = downs[j].texture;
            up.uniforms.texel.value.set(1 / src.width, 1 / src.height);
            pass(up, ups[j]);
          }
        }
        var u = composite.uniforms;
        u.tScene.value = hdr.texture;
        u.tBloom.value = ups[0].texture;
        u.bloom.value = o.bloom / LEVELS;
        u.exposure.value = o.exposure;
        u.vignette.value = o.vignette;
        u.grain.value = o.grain;
        u.contrast.value = o.contrast;
        u.saturation.value = o.saturation;
        u.ca.value = o.ca;
        u.fade.value = o.fade;
        u.time.value = time;
        u.lift.value.fromArray(o.lift);
        u.gain.value.fromArray(o.gain);
        u.fadeColor.value.fromArray(o.fadeColor);
        pass(composite, slot === undefined ? null : ldr[slot]);
      },
      blend: function (p, mode) {
        blend.uniforms.tA.value = ldr[0].texture;
        blend.uniforms.tB.value = ldr[1].texture;
        blend.uniforms.p.value = p;
        blend.uniforms.mode.value = mode;
        pass(blend, null);
      },
      compile: function () {
        [prefilter, down, up, composite, blend].forEach(function (m) {
          quad.material = m;
          renderer.compile(scene, cam);
        });
      },
    };
  }

  // ---------------------------------------------------------------- the deck
  var TRANSITIONS = { fade: 0, iris: 1, wipe: 2 };

  function start(options) {
    var opts = options || {};
    var THREE = window.THREE;
    var scenes = opts.scenes || [];
    var style = el("style", "", document.head);
    style.textContent = CSS;
    var canvas = el("canvas", "", document.body);
    canvas.id = "swc-stage";
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", opts.title || "Presentation");
    var layers = el("div", "", document.body);
    layers.id = "swc-layers";
    var ui = el("div", "", document.body);
    ui.id = "swc-ui";
    var reduced =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var deck = { ready: false, index: 0, beat: 0, auto: false };

    function fail(message) {
      el("div", "swc-error", ui, "<p>" + message + "</p>");
      console.error("[motion-deck] " + message);
    }
    if (!THREE)
      return fail("This presentation needs three.js: load specwithcode:three before the deck.");
    var gl = canvas.getContext("webgl2", {
      antialias: false,
      powerPreference: "high-performance",
      alpha: false,
    });
    if (!gl)
      return fail("This presentation needs WebGL 2, which this browser or machine does not offer.");
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: false });
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    var post = createPost(THREE, renderer);
    var audio = createAudio();

    // Chrome: loader, progress hairline, notes, help, toast.
    var loader = el(
      "div",
      "swc-load",
      ui,
      "<h1></h1><div class=bar><i></i></div><p>Preparing scenes</p>",
    );
    loader.querySelector("h1").textContent = opts.title || "Presentation";
    var loadBar = loader.querySelector("i"),
      loadText = loader.querySelector("p");
    var progressLine = el("div", "swc-progress", ui);
    var notesPanel = null,
      helpPanel = null,
      toastEl = null,
      toastTimer = 0;
    function toast(text) {
      if (!toastEl) toastEl = el("div", "swc-toast", ui);
      toastEl.textContent = text;
      toastEl.style.opacity = "1";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.style.opacity = "0";
      }, 1300);
    }

    // Per-scene state: beat progress p[k] runs 0 to 1 over the beat's dur once its delay passes.
    var instances = scenes.map(function (def) {
      var beats = def.beats && def.beats.length ? def.beats : [{ dur: 1.5 }];
      var layer = el("div", "swc-layer", layers);
      if (def.html) layer.innerHTML = def.html;
      var s = {
        t: 0,
        dt: 0,
        beat: 0,
        dir: 1,
        enter: 0,
        time: 0,
        p: beats.map(function () {
          return 0;
        }),
        since: beats.map(function () {
          return 0;
        }),
        mouse: { x: 0, y: 0 },
        width: 1,
        height: 1,
        aspect: 1,
        at: function (k) {
          return (s.p[k] || 0) * beats[k].dur;
        },
        win: function (k, t0, t1, e) {
          if (k < 0 || k >= beats.length) return 0;
          var local = s.since[k] - (beats[k].delay || 0);
          var shown = s.p[k] * beats[k].dur;
          var at = Math.min(local, shown);
          if (s.p[k] >= 1) at = Math.max(at, shown);
          return easeOf(e)(clamp01((at - t0) / Math.max(1e-4, t1 - t0)));
        },
      };
      return { def: def, beats: beats, layer: layer, s: s, inst: null, initialized: false };
    });

    function ctxFor(entry) {
      return {
        THREE: THREE,
        renderer: renderer,
        deck: api,
        audio: audio,
        layer: entry.layer,
        ease: ease,
        rng: rng,
        glsl: GLSL,
        words: words,
        rise: rise,
        odometer: odometer,
        mix: mix,
        clamp01: clamp01,
        $: function (selector) {
          return entry.layer.querySelector(selector);
        },
      };
    }

    function size() {
      var dprCap = opts.maxPixelRatio || 2;
      var ratio = Math.min(window.devicePixelRatio || 1, dprCap) * quality;
      var cw = Math.max(1, Math.floor(window.innerWidth * ratio)),
        ch = Math.max(1, Math.floor(window.innerHeight * ratio));
      renderer.setPixelRatio(1);
      renderer.setSize(cw, ch, false);
      post.resize(cw, ch);
      instances.forEach(function (entry) {
        var s = entry.s;
        s.width = window.innerWidth;
        s.height = window.innerHeight;
        s.aspect = s.width / s.height;
        var cam = entry.inst && entry.inst.camera;
        if (cam && cam.isPerspectiveCamera) {
          cam.aspect = s.aspect;
          cam.updateProjectionMatrix();
        }
        if (entry.inst && entry.inst.resize) entry.inst.resize(s);
      });
    }
    var quality = 1;

    function sceneOpts(entry) {
      var p = entry.def.post;
      return typeof p === "function" ? p(entry.s) : p;
    }
    function draw(entry, slot) {
      var inst = entry.inst;
      if (!inst) return;
      post.render(
        inst.scene,
        inst.camera,
        sceneOpts(entry),
        clock,
        slot,
        inst.render
          ? function (target) {
              inst.render(target, entry.s);
            }
          : null,
      );
    }

    // ---- loading: build every scene, compile its programs and draw each beat once offscreen
    var clock = 0;
    function nextFrame() {
      return new Promise(function (r) {
        requestAnimationFrame(function () {
          r();
        });
      });
    }
    async function warm() {
      size();
      post.compile();
      for (var i = 0; i < instances.length; i++) {
        var entry = instances[i];
        loadText.textContent =
          (entry.def.title || "Scene " + (i + 1)) + " · " + (i + 1) + " of " + instances.length;
        try {
          entry.inst = entry.def.create(ctxFor(entry)) || {};
          if (entry.inst.init) await entry.inst.init(entry.s);
          size();
          if (entry.inst.scene && entry.inst.camera)
            renderer.compile(entry.inst.scene, entry.inst.camera);
          for (var k = 0; k < entry.beats.length; k++) {
            seekState(entry, k, 0.5);
            if (entry.inst.update) entry.inst.update(entry.s);
            draw(entry, 0);
          }
          seekState(entry, 0, 0);
          entry.initialized = true;
        } catch (error) {
          console.error("[motion-deck] scene " + (entry.def.id || i) + " failed to load", error);
          entry.inst = null;
        }
        loadBar.style.width = Math.round(((i + 1) / instances.length) * 100) + "%";
        await nextFrame();
      }
      gl.finish();
    }
    // Puts a scene at beat k with progress f, earlier beats complete, later ones at rest.
    function seekState(entry, k, f) {
      var s = entry.s;
      s.beat = k;
      for (var j = 0; j < entry.beats.length; j++) {
        var d = entry.beats[j];
        s.p[j] = j < k ? 1 : j === k ? f : 0;
        s.since[j] = j < k ? d.dur + (d.delay || 0) + 30 : j === k ? f * d.dur + (d.delay || 0) : 0;
      }
      s.enter = 1;
    }

    // ---- navigation
    var transition = null; // { from, to, t, dur, mode, reverse }
    function writeHash() {
      var entry = instances[deck.index];
      var id = entry.def.id || "scene" + (deck.index + 1);
      var hash = "#" + id + (deck.beat > 0 ? "-" + (deck.beat + 1) : "");
      if (location.hash !== hash) {
        try {
          history.replaceState(history.state, "", location.pathname + location.search + hash);
        } catch {
          /* opaque origins may refuse */
        }
      }
      progressLine.style.width =
        (((deck.index + (deck.beat + 1) / entry.beats.length) / instances.length) * 100).toFixed(
          2,
        ) + "%";
      if (notesPanel) renderNotes();
    }
    function parseHash() {
      var m = /^#([a-z0-9_-]+?)(?:-(\d+))?$/i.exec(location.hash);
      if (!m) return null;
      for (var i = 0; i < instances.length; i++) {
        if ((instances[i].def.id || "") === m[1]) {
          var beat = Math.min(instances[i].beats.length, Math.max(1, Number(m[2] || 1))) - 1;
          return { index: i, beat: beat };
        }
      }
      return null;
    }
    function enterScene(index, beat, cut) {
      var entry = instances[index];
      instances.forEach(function (e, i) {
        e.layer.classList.toggle("swc-on", i === index);
      });
      deck.index = index;
      deck.beat = beat;
      if (cut) seekState(entry, beat, 0);
      entry.s.beat = beat;
      if (entry.def.bed !== undefined) audio.bed(entry.def.bed);
      if (entry.inst && entry.inst.enter) entry.inst.enter(entry.s);
      beatChanged(entry);
      writeHash();
    }
    function beatChanged(entry) {
      var s = entry.s;
      s.since[s.beat] = 0;
      if (entry.inst && entry.inst.beat) entry.inst.beat(s.beat, s);
    }
    function jump(index, beat) {
      transition = null;
      enterScene(index, beat, true);
    }
    function go(index, dir) {
      var from = deck.index;
      var to = Math.max(0, Math.min(instances.length - 1, index));
      if (to === from) return;
      var entry = instances[to];
      var beat = dir < 0 ? entry.beats.length - 1 : 0;
      seekState(entry, beat, dir < 0 ? 1 : 0);
      entry.s.dir = dir;
      entry.s.enter = 0;
      if (reduced) {
        enterScene(to, beat, false);
        return;
      }
      var name = (dir > 0 ? entry.def.transition : instances[from].def.transition) || "fade";
      transition = {
        from: from,
        to: to,
        t: 0,
        dur: dir > 0 ? 1.2 : 0.8,
        mode: TRANSITIONS[name] === undefined ? 0 : TRANSITIONS[name],
        dir: dir,
      };
      audio.hit("whoosh", { gain: 0.25, dur: transition.dur });
      enterScene(to, beat, false);
    }
    function next() {
      if (!deck.ready) return;
      if (transition) {
        transition.t += transition.dur * 0.5;
        return;
      }
      var entry = instances[deck.index];
      if (deck.beat < entry.beats.length - 1) {
        deck.beat += 1;
        entry.s.beat = deck.beat;
        entry.s.dir = 1;
        audio.hit("tick", { gain: 0.18 });
        beatChanged(entry);
        writeHash();
      } else if (deck.index < instances.length - 1) go(deck.index + 1, 1);
      else if (deck.auto) setAuto(false);
    }
    function back() {
      if (!deck.ready) return;
      // Back during a transition undoes it: the previous scene returns, complete.
      if (transition) {
        var undo = transition.from;
        jump(undo, instances[undo].beats.length - 1);
        seekState(instances[undo], deck.beat, 1);
        return;
      }
      var entry = instances[deck.index];
      if (deck.beat > 0) {
        deck.beat -= 1;
        entry.s.beat = deck.beat;
        entry.s.dir = -1;
        writeHash();
      } else if (deck.index > 0) go(deck.index - 1, -1);
    }
    var autoTimer = 0;
    function setAuto(on) {
      deck.auto = on;
      autoTimer = 0;
      toast(on ? "Playing by itself" : "Manual");
    }

    // ---- input
    function unlock() {
      audio.unlock();
    }
    function closeOverlays() {
      var closed = false;
      if (helpPanel) {
        helpPanel.remove();
        helpPanel = null;
        closed = true;
      }
      if (notesPanel) {
        notesPanel.remove();
        notesPanel = null;
        closed = true;
      }
      return closed;
    }
    function renderNotes() {
      var entry = instances[deck.index];
      var note = (entry.beats[deck.beat] && entry.beats[deck.beat].notes) || entry.def.notes || "";
      notesPanel.innerHTML = "<p></p><span></span>";
      notesPanel.querySelector("p").textContent = note;
      notesPanel.querySelector("span").textContent =
        "Scene " +
        (deck.index + 1) +
        " / " +
        instances.length +
        " · beat " +
        (deck.beat + 1) +
        " / " +
        entry.beats.length;
    }
    function toggleHelp() {
      if (helpPanel) {
        helpPanel.remove();
        helpPanel = null;
        return;
      }
      helpPanel = el("div", "swc-help", ui);
      [
        ["→ Space", "next"],
        ["←", "back"],
        ["Home / End", "first / last"],
        ["F", "fullscreen"],
        ["M", "sound on or off"],
        ["N", "speaker notes"],
        ["A", "play by itself"],
        ["?", "this help"],
      ].forEach(function (row) {
        el("b", "", helpPanel).textContent = row[0];
        el("span", "", helpPanel).textContent = row[1];
      });
    }
    function fullscreen() {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
        return;
      }
      var request = document.documentElement.requestFullscreen;
      if (!request) return toast("Fullscreen is not available here");
      document.documentElement.requestFullscreen().catch(function () {
        toast("Fullscreen is not available here");
      });
    }
    window.addEventListener("keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      unlock();
      var k = e.key;
      var handled = true;
      if (
        k === "ArrowRight" ||
        k === "ArrowDown" ||
        k === " " ||
        k === "PageDown" ||
        k === "Enter"
      ) {
        if (!e.repeat) next();
      } else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") {
        if (!e.repeat) back();
      } else if (k === "Home") jump(0, 0);
      else if (k === "End") jump(instances.length - 1, 0);
      else if (k === "f" || k === "F") fullscreen();
      else if (k === "m" || k === "M") toast(audio.mute() ? "Sound off" : "Sound on");
      else if (k === "a" || k === "A") setAuto(!deck.auto);
      else if (k === "n" || k === "N") {
        if (notesPanel) {
          notesPanel.remove();
          notesPanel = null;
        } else {
          notesPanel = el("div", "swc-panel", ui);
          renderNotes();
        }
      } else if (k === "?" || k === "h" || k === "H") toggleHelp();
      else if (k === "Escape") handled = closeOverlays();
      else handled = false;
      if (handled) e.preventDefault();
    });
    var down = null;
    canvas.addEventListener("pointerdown", function (e) {
      unlock();
      canvas.focus({ preventScroll: true });
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
      var entry = instances[deck.index];
      if (entry.inst && entry.inst.pointer && entry.inst.pointer("down", e, entry.s)) {
        down = null;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener("pointerup", function (e) {
      var entry = instances[deck.index];
      if (!down) {
        if (entry.inst && entry.inst.pointer) entry.inst.pointer("up", e, entry.s);
        return;
      }
      var dx = e.clientX - down.x,
        dy = e.clientY - down.y,
        fast = performance.now() - down.t < 700;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && fast) {
        if (dx < 0) next();
        else back();
      } else if (Math.hypot(dx, dy) < 12 && fast) {
        if (down.button === 2) back();
        else if (down.button === 0) next();
      }
      down = null;
    });
    canvas.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });
    var idleTimer = 0;
    window.addEventListener("pointermove", function (e) {
      var entry = instances[deck.index];
      entry.s.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      entry.s.mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
      if (entry.inst && entry.inst.pointer) entry.inst.pointer("move", e, entry.s);
      document.body.classList.remove("swc-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        document.body.classList.add("swc-idle");
      }, 2200);
    });
    window.addEventListener("hashchange", function () {
      var target = parseHash();
      if (target && (target.index !== deck.index || target.beat !== deck.beat))
        jump(target.index, target.beat);
    });
    window.addEventListener("resize", function () {
      if (deck.ready) size();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) audio.suspend();
    });

    // ---- frame loop
    var last = performance.now(),
      slowFrames = 0,
      fastFrames = 0;
    function advanceState(entry, dt) {
      var s = entry.s,
        beats = entry.beats;
      s.dt = dt;
      s.t += dt;
      s.time = clock;
      for (var k = 0; k < beats.length; k++) {
        var d = beats[k];
        if (k <= s.beat) {
          s.since[k] += dt;
          if (s.since[k] >= (d.delay || 0))
            s.p[k] = Math.min(1, s.p[k] + (dt * (k < s.beat ? 3 : 1) * (reduced ? 50 : 1)) / d.dur);
        } else if (s.p[k] > 0) {
          s.p[k] = Math.max(0, s.p[k] - (dt * 2.5) / d.dur);
          s.since[k] = s.p[k] * d.dur + (d.delay || 0);
        }
      }
      if (entry.inst && entry.inst.update) entry.inst.update(s);
    }
    function frame(now) {
      requestAnimationFrame(frame);
      var dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!deck.ready) return;
      clock += dt;
      // Adaptive resolution: hold 60 fps on slower GPUs, recover when there is headroom.
      if (dt > 0.024) {
        slowFrames++;
        fastFrames = 0;
      } else {
        fastFrames++;
        slowFrames = Math.max(0, slowFrames - 1);
      }
      if (slowFrames > 45 && quality > 0.6) {
        quality = Math.max(0.6, quality - 0.15);
        slowFrames = 0;
        size();
      }
      if (fastFrames > 600 && quality < 1) {
        quality = Math.min(1, quality + 0.1);
        fastFrames = 0;
        size();
      }
      var entry = instances[deck.index];
      if (transition) {
        transition.t += dt;
        var p = clamp01(transition.t / transition.dur);
        var from = instances[transition.from];
        entry.s.enter = ease.inOutCubic(p);
        from.s.enter = 1 - entry.s.enter;
        advanceState(from, dt);
        advanceState(entry, dt);
        draw(from, 0);
        draw(entry, 1);
        post.blend(ease.inOutCubic(p), transition.mode);
        if (p >= 1) {
          transition = null;
          entry.s.enter = 1;
        }
      } else {
        advanceState(entry, dt);
        draw(entry);
      }
      if (deck.auto && !transition) {
        var b = entry.beats[deck.beat];
        autoTimer += dt;
        if (autoTimer > (b.delay || 0) + b.dur + (b.hold === undefined ? 3 : b.hold)) {
          autoTimer = 0;
          next();
        }
      }
    }

    var api = {
      get index() {
        return deck.index;
      },
      get beat() {
        return deck.beat;
      },
      get ready() {
        return deck.ready;
      },
      next: next,
      back: back,
      audio: audio,
      go: function (id, beat) {
        for (var i = 0; i < instances.length; i++)
          if (instances[i].def.id === id) return jump(i, Math.max(0, (beat || 1) - 1));
      },
      info: function () {
        return {
          scene: instances[deck.index].def.id,
          index: deck.index,
          beat: deck.beat + 1,
          scenes: instances.length,
          quality: quality,
        };
      },
      // Deterministic stills for tests and thumbnails: scene at beat (1-based) after t seconds.
      seek: function (id, beat, t) {
        for (var i = 0; i < instances.length; i++) {
          if (instances[i].def.id !== id) continue;
          var entry = instances[i];
          jump(i, Math.max(0, (beat || 1) - 1));
          var steps = Math.round((t || 0) * 60);
          for (var n = 0; n < steps; n++) {
            clock += 1 / 60;
            advanceState(entry, 1 / 60);
          }
          draw(entry);
          return true;
        }
        return false;
      },
    };

    warm().then(
      function () {
        var target = parseHash() || { index: 0, beat: 0 };
        deck.ready = true;
        enterScene(target.index, target.beat, true);
        loader.style.opacity = "0";
        loader.style.pointerEvents = "none"; // a click during the fade reaches the deck
        setTimeout(function () {
          loader.remove();
        }, 750);
        // Inside a frame the host gives focus; taking it without a gesture only earns a warning.
        if (document.hasFocus()) canvas.focus({ preventScroll: true });
        window.specwithcodeReady = true;
        window.dispatchEvent(new Event("specwithcode:ready"));
      },
      function (error) {
        console.error("[motion-deck] loading failed", error);
        fail(
          "This presentation could not load: " +
            (error && error.message ? error.message : String(error)),
        );
      },
    );
    requestAnimationFrame(frame);
    window.SpecWithCodeDeck.current = api;
    return api;
  }

  window.SpecWithCodeDeck = {
    start: start,
    ease: ease,
    rng: rng,
    glsl: GLSL,
    words: words,
    rise: rise,
    odometer: odometer,
    current: null,
    version: "1.0.0",
  };
})();
