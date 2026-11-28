/*! SpecWithCode motion deck runtime: worlds and type | MIT License | Copyright 2026 SpecWithCode contributors */
// Part of specwithcode:motion-deck. ctx.world(scene, atmosphere) builds lit, full-frame worlds
// from custom GLSL: a sky with sun, clouds and stars; fbm terrain; water; fields of thousands of
// glowing tiles standing on the terrain; light arcs; drifting motes; glossy slabs with screens.
// They share one atmosphere (sun, sky colours, fog), so a world reads as one place.
// ctx.type(element, p, {style}) animates a headline glyph by glyph.
(function () {
  "use strict";
  var D = window.SpecWithCodeDeck;
  var G = D.glsl;

  // ---------------------------------------------------------------- shared GLSL
  var ATMOSPHERE =
    "uniform vec3 uSun,uSunColor,uZenith,uHorizon,uGround,uFog;uniform float uFogDensity,uFogHeight,uTime;\n" +
    // Sky colour along a view direction: horizon to zenith, ground below, glow around the sun.
    "vec3 swcSky(vec3 v){float h=v.y;vec3 c=mix(uHorizon,uZenith,pow(clamp(h,0.0,1.0),0.5));" +
    "c=mix(c,uGround,smoothstep(0.0,-0.3,h));float s=max(dot(v,uSun),0.0);" +
    "return c+uSunColor*(pow(s,6.0)*0.1+pow(s,64.0)*0.45);}\n" +
    // Distance and height fog toward the fog colour, warmer where it scatters sunlight.
    "vec3 swcFog(vec3 col,vec3 wp){vec3 d=wp-cameraPosition;float dist=length(d);vec3 v=d/max(dist,1e-3);" +
    "float s=pow(max(dot(v,uSun),0.0),8.0);vec3 fc=uFog+uSunColor*s*0.18;" +
    "float f=1.0-exp(-dist*uFogDensity*exp(-max(wp.y,0.0)*uFogHeight));return mix(col,fc,clamp(f,0.0,1.0));}\n";
  var HEIGHT =
    "uniform float uTScale,uTHeight,uTSeed,uTRidge,uTValley,uTValleyWidth,uTBase,uTFlatH;uniform vec2 uTFlatC,uTFlatR;\n" +
    "float swcRidge(vec2 p){float a=0.5,s=0.0;for(int i=0;i<6;i++){float n=1.0-abs(swcNoise(p)*2.0-1.0);" +
    "s+=a*n*n;p=p*2.07+vec2(3.1,1.7);a*=0.5;}return s;}\n" +
    // Height at a world xz: fbm hills blended with ridges, carved by a meandering valley along z.
    "float swcHeight(vec2 xz){if(uTHeight==0.0)return uTBase;vec2 p=xz*uTScale+uTSeed;float h=mix(swcFbm(p),swcRidge(p*0.6),uTRidge);" +
    "float vx=xz.x-sin(xz.y*0.0045+uTSeed)*uTValleyWidth*1.6;float valley=smoothstep(0.0,uTValleyWidth*1.4,abs(vx));" +
    "h=mix(h,h*valley-0.12*(1.0-valley),uTValley);h=uTBase+(h-0.3)*uTHeight;" +
    // A plateau: flat ground at uTFlatH inside radius uTFlatR.x, blending out by uTFlatR.y.
    "return mix(uTFlatH+(h-uTBase)*0.04,h,smoothstep(uTFlatR.x,uTFlatR.y,length(xz-uTFlatC)));}\n";
  // A screen of text: a title bar and lines that change page every so often. Fades its detail
  // with distance so far screens shimmer as a soft glow instead of aliasing.
  var SCREEN =
    "float swcDoc(vec2 uv,float seed,float t,float rows){float ry=(uv.y-0.08)/0.7*rows;float row=floor(ry);" +
    "float page=floor(t*0.35+seed*17.0);float len=0.25+0.68*swcHash(vec2(row+page*7.0,seed*91.0));" +
    "float line=step(0.3,fract(ry))*step(fract(ry),0.72)*step(0.0,ry)*step(ry,rows)*step((uv.x-0.1)/0.8,len)*step(0.1,uv.x);" +
    "float title=step(0.84,uv.y)*step(uv.y,0.92)*step(0.1,uv.x)*step(uv.x,0.42);" +
    "float typing=step(row,mod(t*2.5+seed*30.0,rows+3.0));float detail=1.0-smoothstep(0.25,0.7,fwidth(ry));" +
    "return mix(0.42,max(line*typing,title),detail);}\n";

  var NOISE = G.hash + G.noise;
  var VERT_WORLD =
    "varying vec3 vWP;void main(){vec4 w=modelMatrix*vec4(position,1.0);vWP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}";

  // ---------------------------------------------------------------- helpers
  function color(THREE, v, fallback) {
    if (v === undefined || v === null) v = fallback;
    if (v && v.isColor) return v.clone();
    if (Array.isArray(v)) return new THREE.Color(v[0], v[1], v[2]);
    return new THREE.Color(v);
  }
  function vec3(THREE, v) {
    return Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : v.clone();
  }
  // Applies options to uniforms by name: { sunColor: ... } sets uSunColor.
  function apply(THREE, uniforms, o) {
    Object.keys(o || {}).forEach(function (key) {
      var name = "u" + key.charAt(0).toUpperCase() + key.slice(1);
      var u = uniforms[name];
      if (!u) return;
      var v = o[key];
      if (u.value && u.value.isColor) u.value.copy(color(THREE, v));
      else if (u.value && u.value.isVector3) {
        u.value.copy(vec3(THREE, v));
        if (name === "uSun") u.value.normalize();
      } else if (u.value && u.value.isVector2) u.value.set(v[0], v[1]);
      else u.value = v;
    });
  }

  // ---------------------------------------------------------------- the world
  D.world = function (THREE, scene, atmosphere) {
    var a = atmosphere || {};
    var atmo = {
      uSun: { value: vec3(THREE, a.sun || [0.4, 0.25, -1]).normalize() },
      uSunColor: { value: color(THREE, a.sunColor, [3.2, 2.6, 2.0]) },
      uZenith: { value: color(THREE, a.zenith, [0.08, 0.16, 0.38]) },
      uHorizon: { value: color(THREE, a.horizon, [0.7, 0.62, 0.6]) },
      uGround: { value: color(THREE, a.ground, [0.12, 0.1, 0.1]) },
      uFog: { value: color(THREE, a.fog, a.horizon || [0.6, 0.58, 0.6]) },
      uFogDensity: { value: a.fogDensity === undefined ? 0.0016 : a.fogDensity },
      uFogHeight: { value: a.fogHeight === undefined ? 0.02 : a.fogHeight },
      uTime: { value: 0 },
    };
    var height = {
      uTScale: { value: 0.004 },
      uTHeight: { value: 0 },
      uTSeed: { value: 0 },
      uTRidge: { value: 0.5 },
      uTValley: { value: 0 },
      uTValleyWidth: { value: 60 },
      uTBase: { value: 0 },
      uTFlatC: { value: new THREE.Vector2(0, 0) },
      uTFlatR: { value: new THREE.Vector2(-2, -1) },
      uTFlatH: { value: 0 },
    };
    function uniforms(extra) {
      return Object.assign({}, atmo, height, extra || {});
    }
    function material(vert, frag, extra, params) {
      return new THREE.ShaderMaterial(
        Object.assign(
          {
            vertexShader: vert,
            fragmentShader: frag,
            uniforms: uniforms(extra),
          },
          params || {},
        ),
      );
    }
    function add(object, setter) {
      scene.add(object);
      object.set = function (o) {
        setter(o || {});
        return object;
      };
      return object;
    }

    var world = {
      uniforms: atmo,
      // Moves the sun or changes sky and fog colours: { sun, sunColor, zenith, horizon, fog, ... }.
      set: function (o) {
        apply(THREE, atmo, o);
        return world;
      },
      // The deck sets time each frame; call this only when drawing a world outside the deck.
      tick: function (time) {
        atmo.uTime.value = time;
      },
    };

    // A sky dome drawn at infinity: gradient, sun disc, lit fbm clouds and optional stars.
    world.sky = function (o) {
      o = o || {};
      var extra = {
        uClouds: { value: o.clouds === undefined ? 0.5 : o.clouds },
        uCloudScale: { value: o.cloudScale || 1.1 },
        uCloudSpeed: { value: o.cloudSpeed === undefined ? 0.01 : o.cloudSpeed },
        uCloudColor: { value: color(THREE, o.cloudColor, [1.6, 1.5, 1.45]) },
        uCloudShade: { value: color(THREE, o.cloudShade, [0.35, 0.36, 0.42]) },
        uStars: { value: o.stars || 0 },
        uSunSize: { value: o.sunSize === undefined ? 0.0006 : o.sunSize },
      };
      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 24),
        material(
          "varying vec3 vDir;void main(){vDir=position;vec4 p=projectionMatrix*mat4(mat3(viewMatrix))*vec4(position,1.0);gl_Position=vec4(p.xy,p.w*0.99999,p.w);}",
          NOISE +
            ATMOSPHERE +
            "uniform float uClouds,uCloudScale,uCloudSpeed,uStars,uSunSize;uniform vec3 uCloudColor,uCloudShade;varying vec3 vDir;" +
            "void main(){vec3 v=normalize(vDir);vec3 c=swcSky(v);float s=max(dot(v,uSun),0.0);" +
            "c+=uSunColor*smoothstep(1.0-uSunSize,1.0-uSunSize*0.5,s)*14.0;" +
            "if(uStars>0.0&&v.y>0.0){vec2 sp=v.xz/(v.y+0.35)*140.0;vec2 id=floor(sp);float h=swcHash(id);vec2 f=fract(sp)-0.5;" +
            "float star=step(0.982,h)*exp(-dot(f,f)*70.0)*(0.55+0.45*sin(uTime*2.0+h*60.0));c+=vec3(0.9,0.95,1.0)*star*uStars*smoothstep(0.02,0.35,v.y)*3.0;}" +
            "if(uClouds>0.0&&v.y>0.0){vec2 cp=v.xz/(v.y+0.1)*uCloudScale+vec2(uTime*uCloudSpeed,0.0);" +
            "float n=swcFbm(cp);float n2=swcFbm(cp*2.3+3.7);float dens=smoothstep(0.62-uClouds*0.3,0.95-uClouds*0.2,n*0.72+n2*0.28)*smoothstep(0.0,0.1,v.y);" +
            "float ns=swcFbm(cp+uSun.xz*0.12);float lit=clamp(0.55+(n-ns)*3.5,0.0,1.0);" +
            "vec3 cc=mix(uCloudShade,uCloudColor+uSunColor*0.55*pow(s,3.0),lit);cc=mix(cc,uHorizon,smoothstep(0.25,0.0,v.y)*0.7);c=mix(c,cc,dens*min(1.0,uClouds*1.6));}" +
            "gl_FragColor=vec4(c,1.0);}",
          extra,
          { side: THREE.BackSide, depthWrite: false },
        ),
      );
      mesh.frustumCulled = false;
      mesh.renderOrder = -10;
      return add(mesh, function (opts) {
        apply(THREE, extra, opts);
      });
    };

    // Terrain: a grid displaced on the GPU by swcHeight, lit by the sun and sky, fogged.
    world.terrain = function (o) {
      o = o || {};
      apply(THREE, height, {
        tScale: o.scale === undefined ? 0.004 : o.scale,
        tHeight: o.height === undefined ? 120 : o.height,
        tSeed: o.seed || 0,
        tRidge: o.ridge === undefined ? 0.5 : o.ridge,
        tValley: o.valley || 0,
        tValleyWidth: o.valleyWidth || 60,
        tBase: o.base || 0,
      });
      if (o.plateau) {
        height.uTFlatC.value.set(o.plateau.center[0], o.plateau.center[1]);
        height.uTFlatR.value.set(
          o.plateau.radius,
          o.plateau.radius + (o.plateau.blend || o.plateau.radius),
        );
        height.uTFlatH.value = o.plateau.height || 0;
      }
      var extra = {
        uLow: { value: color(THREE, o.low, [0.16, 0.14, 0.11]) },
        uHigh: { value: color(THREE, o.high, [0.36, 0.3, 0.24]) },
        uRock: { value: color(THREE, o.rock, [0.22, 0.2, 0.19]) },
        uSnow: { value: color(THREE, o.snow, [0.9, 0.92, 0.96]) },
        uSnowLine: { value: o.snowLine === undefined ? 0.75 : o.snowLine },
        uAmbient: { value: o.ambient === undefined ? 0.9 : o.ambient },
        uEps: { value: 1.5 },
      };
      var size = o.size || 3000,
        seg = o.segments || 320;
      var geometry = new THREE.PlaneGeometry(size, size, seg, seg);
      geometry.rotateX(-Math.PI / 2);
      var mesh = new THREE.Mesh(
        geometry,
        material(
          NOISE +
            ATMOSPHERE +
            HEIGHT +
            "uniform float uEps;varying vec3 vWP;varying vec3 vN;void main(){vec3 wp=(modelMatrix*vec4(position,1.0)).xyz;" +
            "float h=swcHeight(wp.xz),hx=swcHeight(wp.xz+vec2(uEps,0.0)),hz=swcHeight(wp.xz+vec2(0.0,uEps));" +
            "wp.y=h;vN=normalize(vec3(h-hx,uEps,h-hz));vWP=wp;gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.0);}",
          NOISE +
            ATMOSPHERE +
            HEIGHT +
            "uniform vec3 uLow,uHigh,uRock,uSnow;uniform float uSnowLine,uAmbient;varying vec3 vWP;varying vec3 vN;" +
            "void main(){vec3 n=normalize(vN);float slope=1.0-n.y;float hh=(vWP.y-uTBase)/max(uTHeight,1e-3);" +
            "float det=swcFbm(vWP.xz*0.035)*0.55+swcNoise(vWP.xz*0.6)*0.45;" +
            "vec3 alb=mix(uLow,uHigh,smoothstep(-0.25,0.45,hh+det*0.25-0.12));" +
            "alb=mix(alb,uRock,smoothstep(0.22,0.55,slope+det*0.18));" +
            "alb=mix(alb,uSnow,smoothstep(uSnowLine-0.06,uSnowLine+0.06,hh+det*0.12)*smoothstep(0.6,0.3,slope));alb*=0.78+0.44*det;" +
            "float ndl=dot(n,uSun);float diff=mix(max(ndl,0.0),max((ndl+0.35)/1.35,0.0),0.35);" +
            "vec3 sky=mix(uGround*0.6,uZenith*0.8+uHorizon*0.4,n.y*0.5+0.5);float ao=clamp(0.5+hh*0.7+n.y*0.25,0.25,1.0);" +
            "vec3 col=alb*(uSunColor*diff*1.1+sky*uAmbient*ao);gl_FragColor=vec4(swcFog(col,vWP),1.0);}",
          extra,
        ),
      );
      mesh.position.set((o.center && o.center[0]) || 0, 0, (o.center && o.center[1]) || 0);
      mesh.frustumCulled = false;
      return add(mesh, function (opts) {
        apply(THREE, extra, opts);
        apply(THREE, height, {
          tHeight: opts.height,
          tScale: opts.scale,
          tValley: opts.valley,
          tBase: opts.base,
        });
      });
    };

    // Water at a level: sky reflection with fresnel, moving ripples and a sun glint.
    world.water = function (o) {
      o = o || {};
      var extra = {
        uDeep: { value: color(THREE, o.color, [0.01, 0.03, 0.05]) },
        uGlint: { value: o.glint === undefined ? 1 : o.glint },
        uRipple: { value: o.ripple === undefined ? 1 : o.ripple },
      };
      var size = o.size || 6000;
      var geometry = new THREE.PlaneGeometry(size, size, 1, 1);
      geometry.rotateX(-Math.PI / 2);
      var mesh = new THREE.Mesh(
        geometry,
        material(
          VERT_WORLD,
          NOISE +
            ATMOSPHERE +
            "uniform vec3 uDeep;uniform float uGlint,uRipple;varying vec3 vWP;" +
            "float wave(vec2 p,float t,float fw){float a=swcNoise(p*2.0+vec2(t*0.22,t*0.1));" +
            "a+=0.5*swcNoise(p*4.7-vec2(t*0.3,-t*0.2))*(1.0-smoothstep(0.3,1.2,fw*4.7));" +
            "a+=0.25*swcNoise(p*11.0+vec2(t*0.5,t*0.4))*(1.0-smoothstep(0.3,1.2,fw*11.0));return a;}" +
            "void main(){vec3 v=normalize(vWP-cameraPosition);vec2 w=vWP.xz*0.05;float t=uTime;float fw=length(fwidth(w));" +
            "float e=0.04,h0=wave(w,t,fw);vec2 g=vec2(wave(w+vec2(e,0.0),t,fw)-h0,wave(w+vec2(0.0,e),t,fw)-h0)/e;" +
            "float dist=length(vWP-cameraPosition);vec3 n=normalize(vec3(-g.x*uRipple*0.08,1.0,-g.y*uRipple*0.08));" +
            "vec3 r=reflect(v,n);r.y=abs(r.y);float fres=0.03+0.97*pow(1.0-max(dot(-v,n),0.0),5.0);" +
            "vec3 col=mix(uDeep,swcSky(r),fres);col+=uSunColor*pow(max(dot(r,uSun),0.0),220.0)*6.0*uGlint+uSunColor*pow(max(dot(r,uSun),0.0),24.0)*0.12*uGlint;" +
            "gl_FragColor=vec4(swcFog(col,vWP),1.0);}",
          extra,
        ),
      );
      mesh.position.y = o.level || 0;
      mesh.frustumCulled = false;
      return add(mesh, function (opts) {
        apply(THREE, extra, opts);
        if (opts.level !== undefined) mesh.position.y = opts.level;
      });
    };

    // A field of standing screens placed on the GPU, one instance per grid cell (cols × rows).
    // on: lit radius around focus; reach: how far tiles have risen out of the ground; scan: an x
    // position behind which tiles show pass (or, for a few, fail) colours.
    world.field = function (o) {
      o = o || {};
      var cols = o.cols || 160,
        rows = o.rows || 160;
      var extra = {
        uCols: { value: cols },
        uRows: { value: rows },
        uSpacing: { value: o.spacing || 3 },
        uJitter: { value: o.jitter === undefined ? 0.25 : o.jitter },
        uCenter: { value: new THREE.Vector2((o.center || [0, 0])[0], (o.center || [0, 0])[1]) },
        uFocus: { value: new THREE.Vector2((o.focus || [0, 0])[0], (o.focus || [0, 0])[1]) },
        uDensity: { value: o.density === undefined ? 0.85 : o.density },
        uBlock: { value: o.block || 14 },
        uStreet: { value: o.street === undefined ? 2 : o.street },
        uOn: { value: o.on === undefined ? 1e5 : o.on },
        uReach: { value: o.reach === undefined ? 1e5 : o.reach },
        uSoft: { value: o.soft === undefined ? 20 : o.soft },
        uTileW: { value: (o.tile || [1.6, 1])[0] },
        uTileH: { value: (o.tile || [1.6, 1])[1] },
        uBig: { value: o.big === undefined ? 2.6 : o.big },
        uYaw: { value: o.yaw || 0 },
        uLift: { value: o.lift || 0.15 },
        uMinHeight: { value: o.minHeight === undefined ? -1e5 : o.minHeight },
        uColor: { value: color(THREE, o.color, [1.0, 0.92, 0.8]) },
        uColorB: { value: color(THREE, o.colorB, [1.0, 0.7, 0.35]) },
        uMixB: { value: o.mixB === undefined ? 0.15 : o.mixB },
        uGlow: { value: o.glow === undefined ? 2.2 : o.glow },
        uBody: { value: color(THREE, o.body, [0.08, 0.08, 0.09]) },
        uScan: { value: o.scan === undefined ? -1e5 : o.scan },
        uPassColor: { value: color(THREE, o.passColor, [0.4, 1.0, 0.7]) },
        uFailColor: { value: color(THREE, o.failColor, [1.0, 0.3, 0.25]) },
        uFail: { value: o.fail === undefined ? 0.03 : o.fail },
      };
      var quad = new THREE.PlaneGeometry(1, 1);
      quad.translate(0, 0.5, 0);
      var geometry = new THREE.InstancedBufferGeometry();
      geometry.index = quad.index;
      geometry.setAttribute("position", quad.getAttribute("position"));
      geometry.setAttribute("uv", quad.getAttribute("uv"));
      geometry.instanceCount = cols * rows;
      var mesh = new THREE.Mesh(
        geometry,
        material(
          NOISE +
            ATMOSPHERE +
            HEIGHT +
            "uniform float uJitter,uCols,uRows,uSpacing,uDensity,uBlock,uStreet,uOn,uReach,uSoft,uTileW,uTileH,uBig,uYaw,uLift,uMinHeight,uScan;" +
            "uniform vec2 uCenter,uFocus;varying vec2 vUv;varying float vLit,vSeed,vPass,vScanGlow;varying vec3 vWP;" +
            "void main(){float id=float(gl_InstanceID);vec2 cell=vec2(mod(id,uCols),floor(id/uCols));" +
            "float h1=swcHash(cell*1.37+11.0),h2=swcHash(cell+vec2(5.3,9.1));vec2 bc=mod(cell,vec2(uBlock,floor(uBlock*0.55)));" +
            "float keep=step(h1,uDensity)*step(uStreet,bc.x)*step(uStreet*0.5,bc.y);" +
            "vec2 xz=uCenter+(cell-vec2(uCols,uRows)*0.5)*uSpacing+(vec2(h1,h2)-0.5)*uSpacing*uJitter;float g=swcHeight(xz);keep*=step(uMinHeight,g);" +
            "float d=length(xz-uFocus);float appear=1.0-smoothstep(uReach-uSoft,uReach,d*(0.85+0.3*h2));" +
            "vLit=1.0-smoothstep(uOn-uSoft*0.5,uOn,d*(0.8+0.4*h1));" +
            "float s=(h2>0.975?uBig:1.0)*appear;float yaw=uYaw+(h1-0.5)*0.35;float c=cos(yaw),sn=sin(yaw);" +
            "vec3 l=vec3(position.x*uTileW*s,position.y*uTileH*s,0.0);l=vec3(c*l.x+sn*l.z,l.y,-sn*l.x+c*l.z);" +
            "vec3 wp=vec3(xz.x,g+uLift*s,xz.y)+l;vUv=uv;vSeed=h1;vWP=wp;vPass=step(xz.x,uScan);vScanGlow=exp(-abs(xz.x-uScan)*0.25);" +
            "gl_Position=keep*appear>0.001?projectionMatrix*viewMatrix*vec4(wp,1.0):vec4(0.0,0.0,2.0,1.0);}",
          NOISE +
            ATMOSPHERE +
            SCREEN +
            "uniform vec3 uColor,uColorB,uBody,uPassColor,uFailColor;uniform float uMixB,uGlow,uFail;" +
            "varying vec2 vUv;varying float vLit,vSeed,vPass,vScanGlow;varying vec3 vWP;" +
            "void main(){vec2 uv=vUv;float frame=step(0.03,uv.x)*step(uv.x,0.97)*step(0.04,uv.y)*step(uv.y,0.96);" +
            "float ink=swcDoc(uv,vSeed,uTime,7.0);vec3 tint=mix(uColor,uColorB,step(1.0-uMixB,fract(vSeed*7.31)));" +
            "vec3 pc=fract(vSeed*13.7)<uFail?uFailColor:uPassColor;tint=mix(tint,pc,vPass*0.9);" +
            "vec3 screen=tint*(0.3+0.95*ink)*uGlow*(1.0+vScanGlow*2.5);" +
            "vec3 body=uBody*(0.5+0.5*max(uSun.y,0.0))+uHorizon*0.04;vec3 col=mix(body,screen,vLit*frame);" +
            "if(!gl_FrontFacing)col=uBody*0.7+uSunColor*0.02;gl_FragColor=vec4(swcFog(col,vWP),1.0);}",
          extra,
          { side: THREE.DoubleSide },
        ),
      );
      mesh.frustumCulled = false;
      return add(mesh, function (opts) {
        apply(THREE, extra, opts);
      });
    };

    // Beams of light between points, each a curve that rises to `height`. progress reveals them;
    // bright packets travel along at `speed`.
    world.arcs = function (o) {
      o = o || {};
      var extra = {
        uColor: { value: color(THREE, o.color, [1.0, 0.8, 0.55]) },
        uGlow: { value: o.glow === undefined ? 3 : o.glow },
        uProgress: { value: o.progress === undefined ? 1 : o.progress },
        uSpeed: { value: o.speed === undefined ? 0.35 : o.speed },
        uPackets: { value: o.packets === undefined ? 3 : o.packets },
      };
      var group = new THREE.Group();
      var mat = material(
        "varying float vU;varying vec3 vN,vWP;void main(){vU=uv.x;vN=normalize(mat3(modelMatrix)*normal);vec4 w=modelMatrix*vec4(position,1.0);vWP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}",
        ATMOSPHERE +
          "uniform vec3 uColor;uniform float uGlow,uProgress,uSpeed,uPackets;varying float vU;varying vec3 vN,vWP;" +
          "void main(){if(vU>uProgress)discard;vec3 v=normalize(cameraPosition-vWP);float core=pow(abs(dot(normalize(vN),v)),1.5);" +
          "float pk=pow(max(0.0,sin((vU*uPackets-uTime*uSpeed)*6.2832)),28.0);float head=exp(-pow((uProgress-vU)*40.0,2.0))*step(uProgress,0.995);" +
          "float ends=smoothstep(0.0,0.04,vU)*smoothstep(1.0,0.96,vU);" +
          "gl_FragColor=vec4(uColor*uGlow*core*(0.35+pk*4.0+head*6.0)*ends,1.0);}",
        extra,
        { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true },
      );
      (o.pairs || []).forEach(function (pair) {
        var from = vec3(THREE, pair.from),
          to = vec3(THREE, pair.to);
        var mid = from.clone().lerp(to, 0.5);
        mid.y += pair.height === undefined ? from.distanceTo(to) * 0.35 : pair.height;
        var curve = new THREE.QuadraticBezierCurve3(from, mid, to);
        var tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 120, pair.width || o.width || 0.6, 8),
          mat,
        );
        tube.frustumCulled = false;
        group.add(tube);
      });
      return add(group, function (opts) {
        apply(THREE, extra, opts);
      });
    };

    // Drifting points of light in a box around `center`: dust, fireflies, sparks.
    world.motes = function (o) {
      o = o || {};
      var count = o.count || 1500,
        box = o.box || [400, 120, 400],
        center = o.center || [0, 40, 0];
      var rand = D.rng(o.seed || 7);
      var positions = new Float32Array(count * 3);
      for (var i = 0; i < count; i++) {
        positions[i * 3] = center[0] + (rand() - 0.5) * box[0];
        positions[i * 3 + 1] = center[1] + (rand() - 0.5) * box[1];
        positions[i * 3 + 2] = center[2] + (rand() - 0.5) * box[2];
      }
      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      var extra = {
        uColor: { value: color(THREE, o.color, [1.0, 0.85, 0.6]) },
        uSize: { value: o.size || 3 },
        uGlow: { value: o.glow === undefined ? 2 : o.glow },
        uRise: { value: o.rise === undefined ? 1.5 : o.rise },
        uBoxY: { value: box[1] },
      };
      var points = new THREE.Points(
        geometry,
        material(
          NOISE +
            "uniform float uTime,uSize,uRise,uBoxY;varying float vTw;void main(){vec3 p=position;float s=swcHash(p.xz);" +
            "p.y=position.y+mod(uTime*uRise*(0.5+s)+s*uBoxY,uBoxY)-uBoxY*0.5;p.x+=sin(uTime*0.3+s*20.0)*2.0;p.z+=cos(uTime*0.27+s*13.0)*2.0;" +
            "vec4 mv=modelViewMatrix*vec4(p,1.0);gl_PointSize=uSize*(0.5+s)*300.0/max(-mv.z,1.0);vTw=0.5+0.5*sin(uTime*(1.5+s*3.0)+s*40.0);gl_Position=projectionMatrix*mv;}",
          "uniform vec3 uColor;uniform float uGlow;varying float vTw;void main(){vec2 c=gl_PointCoord-0.5;float a=exp(-dot(c,c)*14.0);" +
            "gl_FragColor=vec4(uColor*uGlow*a*vTw,1.0);}",
          extra,
          { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true },
        ),
      );
      points.frustumCulled = false;
      return add(points, function (opts) {
        apply(THREE, extra, opts);
      });
    };

    // A glossy slab, like a machine or a monolith, with a lit screen on its front face.
    // progress fills a bar along the screen's foot.
    world.slab = function (o) {
      o = o || {};
      var size = o.size || [16, 24, 2];
      var extra = {
        uScreen: { value: color(THREE, o.color, [0.9, 0.95, 1.0]) },
        uBody: { value: color(THREE, o.body, [0.03, 0.035, 0.045]) },
        uGlow: { value: o.glow === undefined ? 2.5 : o.glow },
        uProgress: { value: o.progress || 0 },
        uSeed: { value: o.seed || 0.3 },
        uRows: { value: o.rows || 14 },
      };
      var geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      geometry.translate(0, size[1] / 2, 0);
      var mesh = new THREE.Mesh(
        geometry,
        material(
          "varying vec3 vWP,vN;varying vec2 vUv;varying float vFront;void main(){vUv=uv;vFront=step(0.5,normal.z);" +
            "vN=normalize(mat3(modelMatrix)*normal);vec4 w=modelMatrix*vec4(position,1.0);vWP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}",
          NOISE +
            ATMOSPHERE +
            SCREEN +
            "uniform vec3 uScreen,uBody;uniform float uGlow,uProgress,uSeed,uRows;varying vec3 vWP,vN;varying vec2 vUv;varying float vFront;" +
            "void main(){vec3 n=normalize(vN);vec3 v=normalize(cameraPosition-vWP);float fres=pow(1.0-max(dot(n,v),0.0),4.0);" +
            "vec3 r=reflect(-v,n);vec3 col=uBody*(0.4+0.6*max(dot(n,uSun),0.0))+swcSky(r)*(0.04+0.5*fres)+uSunColor*pow(max(dot(r,uSun),0.0),80.0)*0.8;" +
            "if(vFront>0.5){vec2 uv=vUv;float frame=step(0.06,uv.x)*step(uv.x,0.94)*step(0.06,uv.y)*step(uv.y,0.94);" +
            "vec2 su=(uv-0.06)/0.88;float ink=swcDoc(vec2(su.x,su.y*0.86+0.14),uSeed,uTime,uRows);" +
            "float bar=step(su.y,0.06)*step(0.02,su.y)*step(su.x,uProgress);" +
            "col=mix(col,uScreen*uGlow*(0.25+0.8*ink)+uScreen*uGlow*bar*2.5,frame);}" +
            "gl_FragColor=vec4(swcFog(col,vWP),1.0);}",
          extra,
        ),
      );
      var at = o.position || [0, 0, 0];
      mesh.position.set(at[0], at[1], at[2]);
      mesh.rotation.y = o.yaw || 0;
      return add(mesh, function (opts) {
        apply(THREE, extra, opts);
      });
    };

    return world;
  };

  // ---------------------------------------------------------------- kinetic type
  // Splits an element into glyph spans inside word spans (words keep their line breaks).
  function chars(node) {
    if (node.__swcChars) return node.__swcChars;
    var list = [];
    D.words(node).forEach(function (word) {
      var text = word.textContent;
      word.textContent = "";
      Array.from(text).forEach(function (ch) {
        var span = document.createElement("span");
        span.className = "swc-c";
        span.textContent = ch;
        word.appendChild(span);
        list.push(span);
      });
    });
    node.__swcChars = list;
    return list;
  }
  var clamp01 = function (x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  };
  // Each style maps eased progress k (0 hidden, 1 in place) to a transform, opacity and blur.
  var STYLES = {
    rise: function (k) {
      return { t: "translate3d(0," + ((1 - k) * 110).toFixed(2) + "%,0)", o: clamp01(k * 4), b: 0 };
    },
    blur: function (k) {
      return {
        t:
          "translate3d(" +
          ((1 - k) * 0.25).toFixed(3) +
          "em,0,0) scale(" +
          (1 + (1 - k) * 0.08).toFixed(3) +
          ")",
        o: k,
        b: (1 - k) * 14,
      };
    },
    track: function (k, i, n) {
      return {
        t: "translate3d(" + ((i - (n - 1) / 2) * (1 - k) * 0.4).toFixed(3) + "em,0,0)",
        o: k,
        b: (1 - k) * 8,
      };
    },
    scatter: function (k, i, n, r) {
      var a = r * 6.283,
        dist = 3 + r * 6;
      return {
        t:
          "translate3d(" +
          (Math.cos(a) * dist * (1 - k)).toFixed(3) +
          "em," +
          (Math.sin(a) * dist * 0.6 * (1 - k)).toFixed(3) +
          "em,0) rotate(" +
          ((r - 0.5) * 140 * (1 - k)).toFixed(1) +
          "deg)",
        o: clamp01(k * 1.5),
        b: (1 - k) * 6,
      };
    },
    drop: function (k, i, n, r) {
      return {
        t:
          "translate3d(0," +
          (-(1 - k) * 1.4).toFixed(3) +
          "em,0) rotate(" +
          ((r - 0.5) * 30 * (1 - k)).toFixed(1) +
          "deg)",
        o: clamp01(k * 3),
        b: 0,
      };
    },
    type: function (k) {
      return { t: "none", o: k > 0.5 ? 1 : 0, b: 0 };
    },
  };
  var DEFAULT_EASE = {
    rise: "outQuart",
    blur: "outCubic",
    track: "outExpo",
    scatter: "outExpo",
    drop: "outBack",
    type: "linear",
  };

  // type(element, p, {style, stagger, ease, out}): p brings glyphs in one after another; out (0 to
  // 1) takes them away again, upward and blurred.
  D.type = function (node, p, opts) {
    var o = opts || {};
    var style = STYLES[o.style] ? o.style : "rise";
    var list = chars(node);
    var n = list.length;
    var stagger = o.stagger === undefined ? 0.5 : o.stagger;
    var e = D.ease[o.ease || DEFAULT_EASE[style]] || D.ease.outQuart;
    var out = o.out || 0;
    node.classList.toggle("swc-free", style !== "rise");
    var rand = D.rng(o.seed || 11);
    for (var i = 0; i < n; i++) {
      var r = rand();
      var start = n > 1 ? (i / (n - 1)) * stagger : 0;
      var local = clamp01((p - start) / (1 - stagger || 1));
      var gone = clamp01((out - start) / (1 - stagger || 1));
      var k = e(local);
      var look = STYLES[style](k, i, n, r);
      var g = gone * gone * gone;
      var transform = look.t + (g > 0 ? " translate3d(0," + (-g * 0.5).toFixed(3) + "em,0)" : "");
      var span = list[i].style;
      span.transform = transform;
      span.opacity = String(clamp01(look.o) * (1 - g));
      var blur = look.b + g * 10;
      span.filter = blur > 0.05 ? "blur(" + blur.toFixed(2) + "px)" : "";
    }
  };
  D.chars = chars;
})();
