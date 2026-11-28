/*! SpecWithCode motion deck runtime: transitions | MIT License | Copyright 2026 SpecWithCode contributors */
// Part of specwithcode:motion-deck, joined after the core and the sound part. Each transition is
// GLSL that defines vec3 transition(vec2 uv) from the outgoing frame A(uv), the incoming frame
// B(uv), progress p (0 to 1), aspect, time and res, plus a duration and a synthesized cue.
// Authors add their own with SpecWithCodeDeck.transitions.name = { dur, glsl, cue }.
(function () {
  "use strict";
  var D = window.SpecWithCodeDeck;
  var T = D.transitions;

  // Shared helpers for the shaders below.
  var ROT = "mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}";
  var EASE =
    "float eio(float t){t=clamp(t,0.0,1.0);return t<0.5?4.0*t*t*t:1.0-pow(-2.0*t+2.0,3.0)/2.0;}";
  var INSIDE =
    "float inside(vec2 uv){vec2 e=step(vec2(0.0),uv)*step(uv,vec2(1.0));return e.x*e.y;}";

  // Sound cues are scored from the deck's own hits, timed to each transition's moments.
  function sweep(audio, dur, gain) {
    audio.hit("whoosh", { gain: gain || 0.28, dur: dur * 0.8 });
  }

  T.iris = {
    dur: 1.2,
    glsl:
      "vec3 transition(vec2 uv){vec2 q=(uv-0.5)*vec2(aspect,1.0);float r=length(q)+swcFbm(q*3.0)*0.12;" +
      "float m=1.0-smoothstep(p*1.25-0.12,p*1.25,r);return mix(A(uv),B(uv),m);}",
  };
  T.wipe = {
    dur: 1.2,
    glsl:
      "vec3 transition(vec2 uv){float e=uv.x*0.75+uv.y*0.25+swcFbm(uv*vec2(4.0,8.0))*0.18;" +
      "float m=1.0-smoothstep(p*1.4-0.15,p*1.4,e+0.15);return mix(A(uv),B(uv),m);}",
  };

  // The outgoing slide becomes a card that tilts and recedes into the incoming world.
  T.portal = {
    dur: 2.4,
    glsl:
      ROT +
      EASE +
      INSIDE +
      "vec3 transition(vec2 uv){float e=eio(p);vec2 q=(uv-0.5)*vec2(aspect,1.0);" +
      "float f=1.25;vec3 r=normalize(vec3(q,f));" +
      // The card: centre drifts up and right, distance grows, it yaws and pitches as it goes.
      "vec3 C=vec3(0.18*e*aspect,0.08*e,f*(1.0+7.0*e*e));float yaw=0.55*e,pit=-0.28*e;" +
      "vec3 n=vec3(0.0,0.0,-1.0);n.xz=rot2(yaw)*n.xz;n.yz=rot2(pit)*n.yz;" +
      "float t=dot(C,n)/dot(r,n);vec3 P=r*t-C;P.yz=rot2(-pit)*P.yz;P.xz=rot2(-yaw)*P.xz;" +
      "vec2 auv=P.xy/vec2(aspect,1.0)+0.5;" +
      // B settles from a slight push-in, lit by the card's glow.
      "vec2 bq=(uv-0.5)/(1.12-0.12*e)+0.5;vec3 b=B(bq)*(0.55+0.45*e);" +
      "float glow=exp(-length(q-C.xy*(f/C.z))*6.0)*0.25*e*(1.0-smoothstep(0.82,1.0,p));" +
      // Outside the card the ray may miss the plane (t is infinite): never sample A there.
      "if(t<=0.0||inside(auv)<0.5)return b+glow;" +
      "vec2 ed=min(auv,1.0-auv);float edge=min(ed.x*aspect,ed.y);float rim=exp(-edge*90.0)*e*1.4;" +
      "vec3 a=A(auv)*(1.0-0.25*e)+vec3(1.0,0.92,0.8)*rim;return mix(b+glow,a,1.0-smoothstep(0.82,1.0,p));}",
    cue: function (audio, dur) {
      sweep(audio, dur, 0.3);
      audio.hit("rise", { gain: 0.08, dur: dur * 0.7, note: 62 });
      audio.hit("chime", { gain: 0.12, delay: dur * 0.85, note: 74, verb: 0.8 });
    },
  };

  // A split-flap board: tiles flip from the outgoing slide to the incoming one, left to right.
  T.flaps = {
    dur: 2.2,
    glsl:
      INSIDE +
      "vec3 transition(vec2 uv){vec2 grid=vec2(floor(16.0*aspect/1.7778+0.5),9.0);vec2 cell=floor(uv*grid);vec2 lc=fract(uv*grid);" +
      "float delay=cell.x/grid.x*0.55+swcHash(cell+7.0)*0.2+cell.y/grid.y*0.08;" +
      "float q=clamp((p*1.45-delay)/0.5,0.0,1.0);q=q*q*(3.0-2.0*q);float ang=q*3.14159265;" +
      "float c=cos(ang);float sy=abs(c);vec3 col;" +
      // The tile is a card turning about its horizontal axis; its near edge widens a little.
      "float y=(lc.y-0.5)/max(sy,1e-3)+0.5;float x=(lc.x-0.5)/(1.0+0.12*sin(ang)*(y-0.5)*(c>0.0?1.0:-1.0))+0.5;" +
      "vec2 src=(cell+vec2(x,y))/grid;float on=step(0.0,y)*step(y,1.0)*step(0.0,x)*step(x,1.0);" +
      "float shade=0.45+0.55*sy;float spec=pow(1.0-sy,6.0)*0.6;" +
      "vec3 face=c>0.0?A(src):B(src);col=face*shade+vec3(spec);" +
      "vec3 behind=mix(A(uv),B(uv),step(0.5,q))*0.18;col=mix(behind,col,on);" +
      "float seams=(1.0-smoothstep(0.0,0.012*grid.x/aspect,min(lc.x,1.0-lc.x)))*0.6+(1.0-smoothstep(0.0,0.02,min(lc.y,1.0-lc.y)))*0.6;" +
      "col*=1.0-min(seams,0.8)*sin(3.14159*clamp(p*1.15,0.0,1.0));return col;}",
    cue: function (audio, dur) {
      for (var i = 0; i < 28; i++) {
        var at = (i / 28) * dur * 0.78 + Math.random() * 0.03;
        audio.hit("tick", {
          gain: 0.07 + Math.random() * 0.05,
          delay: at,
          pan: -0.9 + (i / 28) * 1.8,
        });
      }
      sweep(audio, dur, 0.12);
    },
  };

  // The outgoing slide curls away like a sheet of paper, showing its blank back.
  T.curl = {
    dur: 2.0,
    glsl:
      INSIDE +
      "vec3 paperBack(vec2 s){vec3 ink=A(s);float l=dot(ink,vec3(0.3,0.59,0.11));return mix(vec3(0.93,0.91,0.87),vec3(0.93,0.91,0.87)*(0.86+0.14*(1.0-l)),0.6);}" +
      "vec3 transition(vec2 uv){vec2 dir=normalize(vec2(1.0,0.42));vec2 qq=uv*vec2(aspect,1.0);float u=dot(qq,dir);" +
      "float umin=0.0,umax=dot(vec2(aspect,1.0),dir);float R=0.11;float pe=p*p*(3.0-2.0*p);" +
      "float f=mix(umax+0.02,umin-1.6*R-0.05,pe);float d=u-f;vec3 b=B(uv);" +
      "vec2 back;vec3 col;" +
      "if(d>R){col=b*(1.0-0.55*exp(-(d-R)/0.06));}" +
      "else if(d>=0.0){float th=asin(clamp(d/R,-1.0,1.0));" +
      "float u0=f+R*(3.14159265-th);vec2 s=(qq+dir*(u0-u))/vec2(aspect,1.0);" +
      "if(inside(s)>0.5){col=paperBack(s)*(0.6+0.4*cos(th));}" +
      "else{float u1=f+R*th;vec2 s1=(qq+dir*(u1-u))/vec2(aspect,1.0);col=inside(s1)>0.5?A(s1)*(0.45+0.55*cos(th)):b;}}" +
      "else{float u0=f+3.14159265*R-d;vec2 s=(qq+dir*(u0-u))/vec2(aspect,1.0);" +
      "if(inside(s)>0.5){col=paperBack(s)*(0.9+0.1*smoothstep(0.0,0.3,-d));}" +
      "else{col=A(uv)*(1.0-0.35*exp(d/0.05));}}" +
      "return col;}",
    cue: function (audio, dur) {
      audio.hit("whoosh", { gain: 0.22, dur: dur * 0.6 });
      for (var i = 0; i < 6; i++)
        audio.hit("tick", { gain: 0.04, delay: 0.1 + i * 0.09, pan: 0.6 - i * 0.2 });
    },
  };

  // A wave of water sweeps across, its foaming lip carrying the incoming scene behind it.
  T.wash = {
    dur: 2.2,
    glsl:
      "vec3 transition(vec2 uv){vec2 dir=normalize(vec2(1.0,0.35));float u=dot(uv*vec2(aspect,1.0),dir)/dot(vec2(aspect,1.0),dir);" +
      "float front=mix(-0.25,1.3,p);float wob=(swcFbm(vec2(uv.y*3.0-uv.x,time*0.6))-0.5)*0.16+(swcNoise(uv*vec2(14.0,30.0)+time)-0.5)*0.03;" +
      "float e=front-u+wob;" +
      // Behind the lip the water still moves and refracts the incoming frame, then calms.
      "float calm=smoothstep(0.0,0.55,e);vec2 rip=vec2(swcFbm(uv*6.0+time*0.8)-0.5,swcFbm(uv*6.0+vec2(5.2,1.3)-time*0.7)-0.5)*0.05*(1.0-calm);" +
      "vec3 b=B(uv+rip)*(0.85+0.15*calm)+vec3(0.6,0.8,1.0)*0.08*(1.0-calm);" +
      "vec2 push=dir*smoothstep(-0.25,0.0,e)*0.02;vec3 a=A(uv-push)*(1.0-0.3*smoothstep(-0.3,0.0,e));" +
      "float lip=exp(-abs(e)*55.0);float foam=lip*smoothstep(0.35,0.75,swcFbm(uv*vec2(18.0,40.0)+time*2.0));" +
      "vec3 col=e>0.0?b:a;col+=vec3(0.85,0.95,1.0)*(lip*0.45+foam*0.9);" +
      "float caust=pow(max(0.0,sin(swcFbm(uv*9.0+time)*12.0)),12.0)*(1.0-calm)*step(0.0,e)*0.25;return col+caust;}",
    cue: function (audio, dur) {
      audio.hit("whoosh", { gain: 0.35, dur: dur * 0.9 });
      audio.hit("rise", { gain: 0.05, dur: dur * 0.5, note: 50 });
      audio.hit("boom", { gain: 0.08, delay: dur * 0.55 });
    },
  };

  // The incoming scene slams down onto the outgoing one: a hard landing, a flash and a shake.
  T.slam = {
    dur: 1.6,
    glsl:
      "vec3 transition(vec2 uv){float hit=0.34;vec2 c=uv-0.5;" +
      "if(p<hit){float k=p/hit;k=k*k;float s=mix(2.6,1.0,k);vec3 b=vec3(0.0);" +
      "for(int i=0;i<6;i++){float o=float(i)/5.0*(1.0-k)*0.08;b+=B(c/(s*(1.0+o))+0.5);}b/=6.0;" +
      "float a=smoothstep(0.0,0.35,k);return mix(A(uv)*(1.0-0.6*k),b,a);}" +
      "float t=p-hit;float shake=exp(-t*10.0)*0.02;vec2 o=vec2(sin(t*71.0),cos(t*53.0))*shake;" +
      "float flash=exp(-t*16.0);vec2 sp=c*flash*0.02;" +
      "vec3 col=vec3(B(uv+o+sp).r,B(uv+o).g,B(uv+o-sp).b);return col+vec3(1.0,0.96,0.9)*flash*0.55;}",
    cue: function (audio, dur) {
      audio.hit("whoosh", { gain: 0.18, dur: dur * 0.32 });
      audio.hit("boom", { gain: 0.5, delay: dur * 0.34 });
      audio.hit("pop", { gain: 0.2, delay: dur * 0.34, note: 40 });
    },
  };

  // The outgoing slide tears down a ragged line and the halves pull apart.
  T.tear = {
    dur: 2.0,
    glsl:
      ROT +
      EASE +
      INSIDE +
      "float tearX(float y){return 0.5+(swcFbm(vec2(y*5.0,3.1))-0.5)*0.16+(swcNoise(vec2(y*60.0,1.7))-0.5)*0.018;}" +
      "vec2 piece(vec2 uv,float side,float e){vec2 q=(uv-vec2(0.5+side*0.25,0.5))*vec2(aspect,1.0);" +
      "q-=vec2(side*e*0.9*aspect,-e*0.18*side-e*e*0.35);q=rot2(side*e*0.35)*q;return q/vec2(aspect,1.0)+vec2(0.5+side*0.25,0.5);}" +
      "vec3 transition(vec2 uv){float e=eio(p);float lift=smoothstep(0.0,0.18,p);" +
      "vec3 col=B(uv)*(0.55+0.45*e);" +
      "vec2 sl=piece(uv,-1.0,e);float xl=tearX(sl.y);" +
      "if(inside(sl)>0.5&&sl.x<xl){float fib=(1.0-smoothstep(0.0,0.012,xl-sl.x))*lift;col=mix(A(sl),vec3(0.95,0.93,0.9),fib);col*=1.0-0.15*e;}" +
      "vec2 sr=piece(uv,1.0,e);float xr=tearX(sr.y);" +
      "if(inside(sr)>0.5&&sr.x>=xr){float fib=(1.0-smoothstep(0.0,0.012,sr.x-xr))*lift;col=mix(A(sr),vec3(0.95,0.93,0.9),fib);col*=1.0-0.15*e;}" +
      "return col;}",
    cue: function (audio, dur) {
      for (var i = 0; i < 14; i++)
        audio.hit("tick", {
          gain: 0.06 + Math.random() * 0.06,
          delay: 0.05 + i * 0.035,
          pan: (Math.random() - 0.5) * 0.4,
        });
      audio.hit("whoosh", { gain: 0.2, delay: 0.35, dur: dur * 0.6 });
    },
  };

  // Push through the outgoing slide into the incoming one, with radial blur and a bright core.
  T.zoom = {
    dur: 1.4,
    glsl:
      "vec3 transition(vec2 uv){vec2 c=uv-0.5;float e=p*p*(3.0-2.0*p);vec3 a=vec3(0.0),b=vec3(0.0);" +
      "float sa=1.0+e*e*2.5,sb=0.82+0.18*e;float ba=e*0.12,bb=(1.0-e)*0.1;" +
      "for(int i=0;i<10;i++){float k=float(i)/9.0;a+=A(c/(sa*(1.0+ba*k))+0.5);b+=B(c/(sb*(1.0+bb*k))+0.5);}a/=10.0;b/=10.0;" +
      "float m=smoothstep(0.35,0.7,p);float flash=exp(-pow((p-0.5)*7.0,2.0))*0.22;" +
      "return mix(a,b,m)+vec3(1.0,0.95,0.88)*flash*(1.0-length(c));}",
    cue: function (audio, dur) {
      audio.hit("rise", { gain: 0.1, dur: dur * 0.5, note: 64 });
      audio.hit("pop", { gain: 0.25, delay: dur * 0.5, note: 52 });
    },
  };
})();
