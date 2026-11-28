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
    "font-family:var(--swc-font,'SpecWithCode Display',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif)}" +
    ".swc-display{font-family:'SpecWithCode Display',ui-sans-serif,system-ui,sans-serif;font-stretch:125%;font-weight:640;letter-spacing:-.025em;line-height:.98}" +
    ".swc-free .swc-w{overflow:visible}.swc-c{display:inline-block;will-change:transform,opacity,filter;white-space:pre}" +
    ".swc-layer.swc-on{opacity:1}" +
    // A scene's own controls take the pointer; everything else lets clicks reach the stage.
    ".swc-layer.swc-on :is(input,textarea,select,button,a[href],label,[contenteditable]){pointer-events:auto}" +
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
    // AgX constants follow three.js r180's tonemapping chunk (MIT), itself after Filament and Blender.
    var AGX =
      "vec3 agxCurve(vec3 x){vec3 x2=x*x,x4=x2*x2;return 15.5*x4*x2-40.14*x4*x+31.96*x4-6.868*x2*x+0.4298*x2+0.1191*x-0.00232;}" +
      "vec3 agx(vec3 c){const mat3 toRec2020=mat3(0.6274,0.0691,0.0164,0.3293,0.9195,0.0880,0.0433,0.0113,0.8956);" +
      "const mat3 fromRec2020=mat3(1.6605,-0.1246,-0.0182,-0.5876,1.1329,-0.1006,-0.0728,-0.0083,1.1187);" +
      "const mat3 inset=mat3(0.856627153315983,0.137318972929847,0.11189821299995,0.0951212405381588,0.761241990602591,0.0767994186031903,0.0482516061458583,0.101439036467562,0.811302368396859);" +
      "const mat3 outset=mat3(1.1271005818144368,-0.1413297634984383,-0.14132976349843826,-0.11060664309660323,1.157823702216272,-0.11060664309660294,-0.016493938717834573,-0.016493938717834257,1.2519364065950405);" +
      "c=inset*(toRec2020*c);c=clamp((log2(max(c,1e-10))+12.47393)/16.499999,0.0,1.0);c=outset*agxCurve(c);" +
      "return clamp(fromRec2020*pow(max(c,0.0),vec3(2.2)),0.0,1.0);}";
    var composite = mat(
      GLSL.hash +
        AGX +
        "uniform sampler2D tScene,tBloom,tHalo;uniform float bloom,exposure,vignette,grain,time,contrast,saturation,ca,fade,tone,halation;" +
        "uniform vec3 lift,gain,fadeColor,shadows,highlights;uniform vec2 res;varying vec2 vUv;" +
        "vec3 aces(vec3 x){return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);}" +
        "vec3 toSrgb(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(0.0031308,c));}" +
        "void main(){vec2 d=vUv-0.5;vec3 c;" +
        "if(ca>0.0){vec2 o=d*dot(d,d)*ca*0.012;c=vec3(texture2D(tScene,vUv+o).r,texture2D(tScene,vUv).g,texture2D(tScene,vUv-o).b);}else c=texture2D(tScene,vUv).rgb;" +
        "vec3 b=texture2D(tBloom,vUv).rgb;" +
        // Halation: film's red-orange glow around highlights, warmer than the bloom it rides on.
        "if(halation>0.0){b*=vec3(1.0+0.35*halation,1.0,1.0-0.35*halation);c+=texture2D(tHalo,vUv).rgb*vec3(1.0,0.32,0.1)*halation*0.6;}" +
        "c+=b*bloom;c*=exposure;c=tone<0.5?aces(c):tone<1.5?agx(c):clamp(c,0.0,1.0);c=toSrgb(c);" +
        "c=(c-0.5)*contrast+0.5;float l=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(l),c,saturation);" +
        "c=c*gain+lift*(1.0-c);c+=shadows*(1.0-l)*(1.0-l)+highlights*l*l;" +
        "vec2 a=d*vec2(res.x/res.y,1.0);c*=1.0-vignette*smoothstep(0.25,1.05,length(a)*1.15);" +
        "float n=swcHash(vUv*res+fract(time*7.0)*97.0)-0.5;c+=n*grain*(1.0-abs(l-0.5));" +
        "c=mix(c,fadeColor,fade);c+=(swcHash(vUv*res+3.1)-0.5)/255.0;gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);}",
      {
        tScene: { value: null },
        tBloom: { value: null },
        tHalo: { value: null },
        bloom: { value: 0.6 },
        exposure: { value: 1 },
        vignette: { value: 0.25 },
        grain: { value: 0.03 },
        time: { value: 0 },
        contrast: { value: 1.02 },
        saturation: { value: 1.05 },
        ca: { value: 0 },
        fade: { value: 0 },
        tone: { value: 0 },
        halation: { value: 0 },
        lift: { value: new THREE.Color(0, 0, 0) },
        gain: { value: new THREE.Color(1, 1, 1) },
        fadeColor: { value: new THREE.Color(0, 0, 0) },
        shadows: { value: new THREE.Color(0, 0, 0) },
        highlights: { value: new THREE.Color(0, 0, 0) },
        res: { value: new THREE.Vector2(1, 1) },
      },
    );
    // Transitions composite the outgoing frame (A) and the incoming one (B). Each registered
    // transition is GLSL defining vec3 transition(vec2 uv) with A(uv), B(uv), p, aspect, time.
    var TRANSITION_HEAD =
      GLSL.hash +
      GLSL.noise +
      "uniform sampler2D tA,tB;uniform float p,aspect,time;uniform vec2 res;varying vec2 vUv;" +
      "vec3 A(vec2 uv){return texture2D(tA,uv).rgb;}vec3 B(vec2 uv){return texture2D(tB,uv).rgb;}\n";
    var transitionMaterials = {};
    function transitionMaterial(name) {
      if (transitionMaterials[name]) return transitionMaterials[name];
      var def = registry()[name];
      if (!def) return null;
      transitionMaterials[name] = mat(
        TRANSITION_HEAD +
          def.glsl +
          "\nvoid main(){gl_FragColor=vec4(clamp(transition(vUv),0.0,1.0),1.0);}",
        {
          tA: { value: null },
          tB: { value: null },
          p: { value: 0 },
          aspect: { value: 1 },
          time: { value: 0 },
          res: { value: new THREE.Vector2(1, 1) },
        },
      );
      return transitionMaterials[name];
    }
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
      tone: "aces",
      halation: 0,
      shadows: [0, 0, 0],
      highlights: [0, 0, 0],
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
        // Halation reads the bloom chain's blurred highlights, so it needs the chain even
        // when bloom itself is off.
        if (o.bloom > 0 || o.halation > 0) {
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
        u.tHalo.value = ups[Math.min(2, ups.length - 1)].texture;
        u.bloom.value = o.bloom / LEVELS;
        u.exposure.value = o.exposure;
        u.vignette.value = o.vignette;
        u.grain.value = o.grain;
        u.contrast.value = o.contrast;
        u.saturation.value = o.saturation;
        u.ca.value = o.ca;
        u.fade.value = o.fade;
        u.tone.value = o.tone === "agx" ? 1 : o.tone === "none" ? 2 : 0;
        u.halation.value = o.halation;
        u.shadows.value.fromArray(o.shadows);
        u.highlights.value.fromArray(o.highlights);
        u.time.value = time;
        u.lift.value.fromArray(o.lift);
        u.gain.value.fromArray(o.gain);
        u.fadeColor.value.fromArray(o.fadeColor);
        pass(composite, slot === undefined ? null : ldr[slot]);
      },
      // Composites LDR slots 0 (A) and 1 (B) through the named transition onto the screen.
      blend: function (p, name, time) {
        var m = transitionMaterial(name) || transitionMaterial("fade");
        if (!m) return;
        m.uniforms.tA.value = ldr[0].texture;
        m.uniforms.tB.value = ldr[1].texture;
        m.uniforms.p.value = p;
        m.uniforms.aspect.value = w / h;
        m.uniforms.time.value = time || 0;
        m.uniforms.res.value.set(w, h);
        pass(m, null);
      },
      compile: function () {
        Object.keys(registry()).forEach(transitionMaterial);
        [prefilter, down, up, composite]
          .concat(
            Object.keys(transitionMaterials).map(function (k) {
              return transitionMaterials[k];
            }),
          )
          .forEach(function (m) {
            quad.material = m;
            renderer.compile(scene, cam);
          });
      },
    };
  }

  // ---------------------------------------------------------------- the deck
  // Transitions by name. The core carries fade; the fx part registers the rest.
  var TRANSITIONS = {
    fade: {
      dur: 1.2,
      glsl: "vec3 transition(vec2 uv){return mix(A(uv),B(uv),smoothstep(0.0,1.0,p));}",
    },
  };
  function registry() {
    return TRANSITIONS;
  }
  function transitionOf(name) {
    return TRANSITIONS[name] ? name : "fade";
  }

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
      // Tells a waiting preview at once that the deck will never be ready.
      window.specwithcodeFailed = String(message);
    }
    // A scene's own code runs through here: a scene that throws goes blank and the deck
    // keeps going, instead of every later frame, key and click stopping at the throw.
    function call(entry, name, a, b, c) {
      var inst = entry.inst;
      if (!inst || typeof inst[name] !== "function") return undefined;
      try {
        return inst[name](a, b, c);
      } catch (error) {
        console.error(
          "[motion-deck] scene " + (entry.def.id || "") + " failed in " + name + "()",
          error,
        );
        entry.inst = null;
        return undefined;
      }
    }
    // #id-N links to beat N of a scene, so a scene named like another's beat link would
    // make that link open the wrong scene.
    var ids = scenes.map(function (scene) {
      return (scene && scene.id) || "";
    });
    for (var c = 0; c < ids.length; c++) {
      var clash = /^(.+)-(\d+)$/.exec(ids[c]);
      if (clash && ids.indexOf(clash[1]) !== -1)
        return fail(
          'Scene id "' +
            ids[c] +
            '" is also the link to beat ' +
            clash[2] +
            ' of scene "' +
            clash[1] +
            '". Rename one of them.',
        );
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
    var audio = window.SpecWithCodeDeck.createAudio();

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
        type: function (node, p, o) {
          return window.SpecWithCodeDeck.type(node, p, o);
        },
        // Worlds made here follow the scene's clock.
        world: function (scene, atmosphere) {
          var made = window.SpecWithCodeDeck.world(THREE, scene, atmosphere);
          (entry.worlds || (entry.worlds = [])).push(made);
          return made;
        },
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
      // A pixel budget keeps a 5K window from allocating huge multisampled HDR targets.
      var budget = opts.maxPixels || 4200000;
      if (cw * ch > budget) {
        var shrink = Math.sqrt(budget / (cw * ch));
        cw = Math.max(1, Math.floor(cw * shrink));
        ch = Math.max(1, Math.floor(ch * shrink));
      }
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
        call(entry, "resize", s);
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
      try {
        drawScene(entry, inst, slot);
      } catch (error) {
        console.error("[motion-deck] scene " + (entry.def.id || "") + " failed to draw", error);
        entry.inst = null;
      }
    }
    function drawScene(entry, inst, slot) {
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
      // The display face first, so text lays out once; a font that never loads cannot hold the show.
      var font = window.SpecWithCodeDeck.fontReady;
      if (font)
        await Promise.race([
          font.catch(function () {}),
          new Promise(function (r) {
            setTimeout(r, 4000);
          }),
        ]);
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
    var transition = null; // { from, to, t, dur, name, dir }
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
      // A scene id may itself end in -N (scene-2), so the whole hash is tried as an id first.
      var whole = location.hash.slice(1);
      for (var w = 0; w < instances.length; w++) {
        if (whole !== "" && (instances[w].def.id || "") === whole) return { index: w, beat: 0 };
      }
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
    // Shows one scene's text layer, or none while a transition is mid-way.
    function showLayer(index) {
      instances.forEach(function (e, i) {
        e.layer.classList.toggle("swc-on", i === index);
      });
    }
    function enterScene(index, beat, cut) {
      var entry = instances[index];
      showLayer(transition ? -1 : index);
      deck.index = index;
      deck.beat = beat;
      if (cut) seekState(entry, beat, 0);
      entry.s.beat = beat;
      if (entry.def.bed !== undefined) audio.bed(entry.def.bed);
      call(entry, "enter", entry.s);
      beatChanged(entry);
      writeHash();
    }
    function beatChanged(entry) {
      var s = entry.s;
      s.since[s.beat] = 0;
      call(entry, "beat", s.beat, s);
    }
    function jump(index, beat) {
      transition = null;
      frozen = false;
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
      // Back plays the transition into the scene being left, in reverse and faster.
      var name = transitionOf(
        (dir > 0 ? entry.def.transition : instances[from].def.transition) || "fade",
      );
      var def = TRANSITIONS[name];
      transition = {
        from: from,
        to: to,
        t: 0,
        dur: (def.dur || 1.2) * (dir > 0 ? 1 : 0.6),
        name: name,
        dir: dir,
      };
      if (def.cue) def.cue(audio, transition.dur, dir);
      else audio.hit("whoosh", { gain: 0.25, dur: transition.dur });
      enterScene(to, beat, false);
    }
    function next() {
      if (!deck.ready) return;
      frozen = false;
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
      frozen = false;
      // Back during a forward transition undoes it: the previous scene returns, complete.
      // During a transition that is already going back, Back hurries it instead of
      // reversing to the scene being left.
      if (transition && transition.dir < 0) {
        transition.t += transition.dur * 0.5;
        return;
      }
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
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      // Keys typed into a scene's own field belong to the field.
      var target = e.target;
      if (
        target &&
        target.closest &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      )
        return;
      // Enter and Space press a focused button or link in a scene instead of moving on.
      if (
        (e.key === "Enter" || e.key === " ") &&
        target &&
        target.closest &&
        target.closest(
          "button, a[href], summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=switch]",
        )
      )
        return;
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
      if (call(entry, "pointer", "down", e, entry.s)) {
        down = null;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener("pointerup", function (e) {
      var entry = instances[deck.index];
      if (!down) {
        call(entry, "pointer", "up", e, entry.s);
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
      call(entry, "pointer", "move", e, entry.s);
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
    // A hidden page draws nothing and its clock stands still; it resumes where it was.
    var looping = false;
    function loop() {
      if (looping || document.hidden) return;
      looping = true;
      requestAnimationFrame(function (now) {
        last = now;
        frame(now);
      });
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) audio.suspend();
      else loop();
    });

    // ---- frame loop
    var TEXT_AT = 0.6;
    var frozen = false;
    // Draws a transition at p: forward from A into B, or back with the same transition reversed.
    function composite(tr, p) {
      var from = instances[tr.from],
        to = instances[tr.to];
      if (tr.dir < 0) {
        draw(to, 0);
        draw(from, 1);
        post.blend(1 - p, tr.name, clock);
      } else {
        draw(from, 0);
        draw(to, 1);
        post.blend(p, tr.name, clock);
      }
    }
    var last = performance.now(),
      slowFrames = 0,
      fastFrames = 0;
    function advanceState(entry, dt) {
      var s = entry.s,
        beats = entry.beats;
      s.dt = dt;
      s.t += dt;
      s.time = clock;
      if (entry.worlds)
        entry.worlds.forEach(function (made) {
          made.tick(clock);
        });
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
      call(entry, "update", s);
    }
    function frame(now) {
      if (document.hidden) {
        looping = false;
        return;
      }
      requestAnimationFrame(frame);
      var dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!deck.ready || frozen) return;
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
        // The incoming scene's beat clock starts once it is mostly on screen, so its text
        // animates in view instead of under the transition.
        advanceState(entry, p >= TEXT_AT ? dt : 0);
        composite(transition, p);
        if (p >= TEXT_AT) showLayer(transition.to);
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
      transitions: function () {
        return Object.keys(TRANSITIONS);
      },
      // A still of the transition into scene `id` at p (0 to 1), forward, for tests and
      // thumbnails. The deck holds that frame until the next seek, jump or key.
      transitionFrame: function (id, p, name) {
        var to = -1;
        for (var i = 0; i < instances.length; i++) if (instances[i].def.id === id) to = i;
        if (to < 1) return false;
        var from = instances[to - 1],
          entry = instances[to];
        seekState(from, from.beats.length - 1, 1);
        seekState(entry, 0, 0);
        var tr = {
          from: to - 1,
          to: to,
          dir: 1,
          name: transitionOf(name || entry.def.transition || "fade"),
        };
        entry.s.enter = ease.inOutCubic(p);
        from.s.enter = 1 - entry.s.enter;
        advanceState(from, 0);
        advanceState(entry, 0);
        composite(tr, clamp01(p));
        showLayer(p >= TEXT_AT ? to : p < 0.05 ? to - 1 : -1);
        frozen = true;
        return tr.name;
      },
      // Mean milliseconds to draw `n` frames of the current scene. Reading one pixel back after
      // each frame waits for the GPU to finish it, which gl.finish() alone does not in Chrome.
      perf: function (n) {
        var count = n || 60,
          entry = instances[deck.index],
          pixel = new Uint8Array(4),
          started = performance.now();
        for (var k = 0; k < count; k++) {
          clock += 1 / 60;
          advanceState(entry, 1 / 60);
          draw(entry);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        }
        var size = post.size;
        return {
          ms: (performance.now() - started) / count,
          width: size.width,
          height: size.height,
        };
      },
      seek: function (id, beat, t) {
        frozen = false;
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
    loop();
    window.SpecWithCodeDeck.current = api;
    return api;
  }

  window.SpecWithCodeDeck = {
    start: start,
    transitions: TRANSITIONS,
    // Called by the font part with the display face as a data URI. Archivo's width axis runs
    // 62% to 125%, so font-stretch picks the cut.
    useFont: function (url) {
      if (typeof FontFace !== "function" || !document.fonts) return;
      try {
        var face = new FontFace("SpecWithCode Display", "url(" + url + ") format('woff2')", {
          weight: "100 900",
          stretch: "62% 125%",
        });
        window.SpecWithCodeDeck.fontReady = face.load().then(function (loaded) {
          document.fonts.add(loaded);
          return loaded;
        });
      } catch (error) {
        console.warn("[motion-deck] display face not loaded", error);
      }
    },
    fontReady: null,
    ease: ease,
    rng: rng,
    glsl: GLSL,
    words: words,
    rise: rise,
    odometer: odometer,
    current: null,
    version: "1.1.0",
  };
})();
