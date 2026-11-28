/*! SpecWithCode motion deck runtime: sound | MIT License | Copyright 2026 SpecWithCode contributors */
// Part of specwithcode:motion-deck, joined after the core. Everything is synthesized: no files.
(function () {
  "use strict";
  var D = window.SpecWithCodeDeck;
  var rng = D.rng;

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

  D.createAudio = createAudio;
})();
